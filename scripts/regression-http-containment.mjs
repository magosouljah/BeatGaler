import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { FILE_UPLOAD_LIMIT_BYTES, createHttpContainment, installHttpContainment } = require("../cloud-server/http-containment.js");
function sessionKey(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function responseRecorder() {
  const res = new EventEmitter(); res.statusCode = 200; res.payload = null;
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.payload = payload; return res; };
  res.send = payload => { res.payload = payload; return res; };
  return res;
}
function request({ token = "", headers = {}, body = {}, query = {}, ip = "127.0.0.1", file } = {}) {
  return { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body, query, ip, socket: { remoteAddress: ip }, file };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beatgaler-containment-"));
const token = "test-session-token";
const unboundToken = "legacy-unbound-token";
const userId = "usr_test";
const installationId = "install_test";
fs.writeFileSync(path.join(dir, "accounts-data.json"), JSON.stringify({
  users: [
    { id: userId, username: "tester#0001", email: "tester@example.test" },
    { id: "usr_other", username: "other#0001", email: "other@example.test" },
  ],
  sessions: {
    [sessionKey(token)]: { userId, installationId, tenantId: userId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 },
    [sessionKey(unboundToken)]: { userId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 },
  },
}, null, 2));
fs.writeFileSync(path.join(dir, "cloud-data.json"), JSON.stringify({ linkedAccounts: {
  [installationId]: { beatgalerAccountId: userId }, other_install: { beatgalerAccountId: "usr_other" },
}, beatTopics: { [`${installationId}:beat_a`]: { messageThreadId: 101 } } }, null, 2));

try {
  const containment = createHttpContainment({ dataDir: dir, env: { NODE_ENV: "production", BEATGALER_UPLOAD_RATE_MAX: "20", BEATGALER_UPLOAD_CONCURRENCY: "2" } });

  {
    const req = request(); const res = responseRecorder(); let nextCalled = false;
    containment.preUpload(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401); assert.equal(nextCalled, false);
  }
  {
    const req = request({ token: unboundToken, headers: { "x-beatgaler-installation-id": installationId }, body: { beatgalerUserId: installationId } });
    const res = responseRecorder(); let nextCalled = false;
    containment.installationOwner(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403); assert.equal(nextCalled, false, "client ids cannot authorize an unbound session");
  }
  {
    const req = request({ token, headers: { "x-beatgaler-installation-id": "other_install" }, body: { beatgalerUserId: "other_install" }, query: { beatgalerUserId: "other_install" } });
    const res = responseRecorder(); let nextCalled = false;
    containment.installationOwner(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.body.beatgalerUserId, installationId);
    assert.equal(req.query.beatgalerUserId, installationId);
    assert.equal(req.beatgalerAuthorizedTenantId, userId);
  }
  {
    const req = request({ body: { beatgalerUserId: "other_install", identifier: "tester#0001" } });
    const res = responseRecorder(); let nextCalled = false;
    await containment.guardLoginInstallation(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403); assert.equal(nextCalled, false, "login must not rebind another account's installation");
  }
  {
    const req = request({ body: { beatgalerUserId: "other_install", identifier: "other@example.test" } });
    const res = responseRecorder(); let nextCalled = false;
    await containment.guardLoginInstallation(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, "same-account login may resume its own installation");
  }
  {
    const fresh = "install_claim_race";
    const reqA = request({ body: { beatgalerUserId: fresh, identifier: "tester#0001" } });
    const resA = responseRecorder(); let nextA = false;
    await containment.guardLoginInstallation(reqA, resA, () => { nextA = true; });
    assert.equal(nextA, true, "first unowned installation claim may proceed");

    const reqB = request({ body: { beatgalerUserId: fresh, identifier: "other#0001" } });
    const resB = responseRecorder(); let nextB = false;
    await containment.guardLoginInstallation(reqB, resB, () => { nextB = true; });
    assert.equal(resB.statusCode, 403);
    assert.equal(nextB, false, "concurrent claim must fail before async storage/bind work can race");

    resA.emit("finish");
    const reqC = request({ body: { beatgalerUserId: fresh, identifier: "other#0001" } });
    const resC = responseRecorder(); let nextC = false;
    await containment.guardLoginInstallation(reqC, resC, () => { nextC = true; });
    assert.equal(nextC, true, "claim reservation releases when the owning response finishes");
    resC.emit("finish");
  }
  {
    const req = request({ token, body: { beatgalerUserId: "other_install" } });
    const res = responseRecorder(); let nextCalled = false;
    await containment.guardSessionRebind(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403); assert.equal(nextCalled, false, "validated session cannot claim foreign installation");
  }
  {
    const req = request({ body: { beatgalerUserId: "other_install", provider: "google" } });
    const res = responseRecorder(); let nextCalled = false;
    containment.guardOAuthStart(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403); assert.equal(nextCalled, false, "unauthenticated OAuth cannot target an already-linked installation");
  }
  {
    const fresh = "install_oauth_fresh";
    const req = request({ body: { beatgalerUserId: fresh, provider: "google" } });
    const res = responseRecorder();
    containment.guardOAuthStart(req, res, () => {
      res.json({ ok: true, flow_id: "flow_fresh", authorization_url: "https://accounts.example/authorize?state=state_fresh" });
    });
    let bindings = JSON.parse(fs.readFileSync(path.join(dir, "authz-session-bindings.json"), "utf8"));
    assert.equal(bindings["oauth:state_fresh"].installationId, fresh);
    assert.equal(bindings["oauth-flow:flow_fresh"].installationId, fresh);

    const cloud = JSON.parse(fs.readFileSync(path.join(dir, "cloud-data.json"), "utf8"));
    cloud.linkedAccounts[fresh] = { beatgalerAccountId: "usr_other" };
    fs.writeFileSync(path.join(dir, "cloud-data.json"), JSON.stringify(cloud, null, 2));
    const cbReq = request({ query: { state: "state_fresh" } });
    const cbRes = responseRecorder(); let callbackNext = false;
    await containment.guardOAuthCallback(cbReq, cbRes, () => { callbackNext = true; });
    assert.equal(cbRes.statusCode, 403); assert.equal(callbackNext, false, "OAuth race cannot overwrite an installation claimed after flow start");

    const pollReq = request({ body: { flowId: "flow_fresh", beatgalerUserId: "other_install" } });
    const pollRes = responseRecorder(); let pollNext = false;
    containment.guardOAuthPoll(pollReq, pollRes, () => { pollNext = true; });
    assert.equal(pollRes.statusCode, 403); assert.equal(pollNext, false, "blocked OAuth flow cannot rebind through poll");

    delete cloud.linkedAccounts[fresh];
    fs.writeFileSync(path.join(dir, "cloud-data.json"), JSON.stringify(cloud, null, 2));
  }
  {
    const fresh = "install_oauth_poll";
    const req = request({ body: { beatgalerUserId: fresh, provider: "google" } });
    const res = responseRecorder();
    containment.guardOAuthStart(req, res, () => {
      res.json({ ok: true, flow_id: "flow_poll", authorization_url: "https://accounts.example/authorize?state=state_poll" });
    });
    const pollReq = request({ body: { flowId: "flow_poll", beatgalerUserId: "other_install" } });
    const pollRes = responseRecorder(); let pollNext = false;
    containment.guardOAuthPoll(pollReq, pollRes, () => { pollNext = true; pollRes.json({ ok: true, pending: true }); });
    assert.equal(pollNext, true);
    assert.equal(pollReq.body.beatgalerUserId, fresh, "OAuth poll installation must come from server-side flow reservation");
  }
  {
    const req = request({ token: unboundToken, body: { beatgalerUserId: "other_install" } });
    const res = responseRecorder(); let nextCalled = false;
    containment.logoutSession(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal("beatgalerUserId" in req.body, false, "legacy unbound logout must invalidate token without trusting body installation id");
  }
  {
    const req = request({ token, headers: { "content-length": String(FILE_UPLOAD_LIMIT_BYTES + 1) } });
    const res = responseRecorder(); let nextCalled = false;
    containment.preUpload(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 413); assert.equal(nextCalled, false, "limit +1 metadata must be rejected before Multer");
  }
  {
    const req = request({ token, headers: { "content-length": String(FILE_UPLOAD_LIMIT_BYTES + 1024 * 1024 + 1) } });
    const res = responseRecorder(); let nextCalled = false;
    containment.preUpload(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 413); assert.equal(nextCalled, false);
  }
  {
    const req = request({ token, body: { beatgalerUserId: "other_install" }, file: { size: FILE_UPLOAD_LIMIT_BYTES } });
    const res = responseRecorder(); let preNext = false;
    containment.preUpload(req, res, () => { preNext = true; }); assert.equal(preNext, true);
    let postNext = false; containment.postUpload(req, res, () => { postNext = true; });
    assert.equal(postNext, true); assert.equal(req.body.beatgalerUserId, installationId); res.emit("finish");
  }
  {
    const req = request({ token, file: { size: FILE_UPLOAD_LIMIT_BYTES + 1 } });
    const res = responseRecorder(); containment.preUpload(req, res, () => {});
    let nextCalled = false; containment.postUpload(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 413); assert.equal(nextCalled, false); res.emit("finish");
  }
  {
    const bound = createHttpContainment({ dataDir: dir, env: { NODE_ENV: "development" } });
    assert.equal(bound.bindSessionInstallation(unboundToken, installationId, userId), true);
    const req = request({ token: unboundToken, body: { beatgalerUserId: "other_install" } }); const res = responseRecorder(); let nextCalled = false;
    bound.installationOwner(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true); assert.equal(req.body.beatgalerUserId, installationId);
  }
  {
    const req = request({ token, body: { beatId: "beat_a", telegramTopicId: 202, beatgalerUserId: "other_install" } });
    const res = responseRecorder(); let nextCalled = false;
    containment.beatTopicOwner(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403); assert.equal(nextCalled, false, "foreign object topic id must not mutate another object");
  }
  {
    const req = request({ token, body: { beatId: "beat_a", telegramTopicId: 101 } });
    const res = responseRecorder(); let nextCalled = false;
    containment.beatTopicOwner(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, "owned topic id remains valid");
  }
  {
    const fakeExpress = { application: {} }; const registered = [];
    fakeExpress.application.post = function(route, ...handlers) { registered.push({ method: "post", route, handlers }); return this; };
    fakeExpress.application.get = function(route, ...handlers) { registered.push({ method: "get", route, handlers }); return this; };
    installHttpContainment(fakeExpress, { dataDir: dir, env: { NODE_ENV: "production" } });
    const multer = () => {};
    fakeExpress.application.post("/beats/upload", multer, () => {});
    const uploadRoute = registered.find(x => x.route === "/beats/upload");
    assert.equal(uploadRoute.handlers.length, 4);
    assert.notEqual(uploadRoute.handlers[0], multer, "authorization/rate boundary must run before Multer");
    assert.equal(uploadRoute.handlers[1], multer);
    fakeExpress.application.post("/beats/delete-topics-batch", () => {});
    const batchDelete = registered.find(x => x.route === "/beats/delete-topics-batch");
    assert.equal(batchDelete.handlers.length, 2, "batch topic delete must be installation-authorized before mutation");
    fakeExpress.application.get("/telegram/connect/status", () => {});
    const statusRoute = registered.find(x => x.route === "/telegram/connect/status");
    assert.equal(statusRoute.handlers.length, 2, "installation authorization must precede GET handler");
    fakeExpress.application.get("/auth/oauth/:provider/callback", () => {});
    const oauthCallback = registered.find(x => x.route === "/auth/oauth/:provider/callback");
    assert.equal(oauthCallback.handlers.length, 2, "OAuth ownership guard must precede provider callback work");
  }

  console.log("PASS regression-http-containment D6 authz");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }