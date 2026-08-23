import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { FILE_UPLOAD_LIMIT_BYTES, createHttpContainment, installHttpContainment } = require("../cloud-server/http-containment.js");

function sessionKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function responseRecorder() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.payload = null;
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.payload = payload; return res; };
  return res;
}

function request({ token = "", headers = {}, body = {}, ip = "127.0.0.1", file } = {}) {
  return {
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
    ip,
    socket: { remoteAddress: ip },
    file,
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beatgaler-containment-"));
const token = "test-session-token";
const userId = "usr_test";
const installationId = "install_test";
fs.writeFileSync(path.join(dir, "accounts-data.json"), JSON.stringify({
  users: [{ id: userId, username: "tester#0001" }],
  sessions: {
    [sessionKey(token)]: { userId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 },
  },
}, null, 2));
fs.writeFileSync(path.join(dir, "cloud-data.json"), JSON.stringify({
  linkedAccounts: {
    [installationId]: { beatgalerAccountId: userId },
    other_install: { beatgalerAccountId: "usr_other" },
  },
}, null, 2));

try {
  const containment = createHttpContainment({
    dataDir: dir,
    env: { NODE_ENV: "production", BEATGALER_UPLOAD_RATE_MAX: "20", BEATGALER_UPLOAD_CONCURRENCY: "2" },
  });

  {
    const req = request();
    const res = responseRecorder();
    let nextCalled = false;
    containment.preUpload(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false, "unauthenticated upload must stop before multipart parsing");
  }

  {
    const req = request({ token, headers: { "content-length": String(FILE_UPLOAD_LIMIT_BYTES + 1024 * 1024 + 1) } });
    const res = responseRecorder();
    let nextCalled = false;
    containment.preUpload(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 413);
    assert.equal(nextCalled, false);
  }

  {
    const req = request({ token, headers: { "x-beatgaler-installation-id": installationId }, body: { beatgalerUserId: "other_install" } });
    const res = responseRecorder();
    containment.preUpload(req, res, () => {});
    let nextCalled = false;
    containment.postUpload(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false, "body installation cannot override authenticated header installation");
    res.emit("finish");
  }

  {
    const req = request({ token, headers: { "x-beatgaler-installation-id": installationId }, body: { beatgalerUserId: installationId }, file: { size: FILE_UPLOAD_LIMIT_BYTES + 1 } });
    const res = responseRecorder();
    containment.preUpload(req, res, () => {});
    let nextCalled = false;
    containment.postUpload(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 413);
    assert.equal(nextCalled, false);
    res.emit("finish");
  }

  {
    const req = request({ token, headers: { "x-beatgaler-installation-id": installationId }, body: { beatgalerUserId: installationId }, file: { size: FILE_UPLOAD_LIMIT_BYTES } });
    const res = responseRecorder();
    containment.preUpload(req, res, () => {});
    let nextCalled = false;
    containment.postUpload(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, "1.99 GB exact ceiling remains accepted by containment");
    assert.equal(req.beatgalerAuthorizedInstallationId, installationId);
    res.emit("finish");
  }

  {
    const prod = createHttpContainment({ dataDir: dir, env: { NODE_ENV: "production" } });
    const res = responseRecorder();
    let nextCalled = false;
    prod.registrationGate(request(), res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 503);
    assert.equal(nextCalled, false, "production registration is closed unless explicitly enabled");
  }

  {
    const fakeExpress = { application: {} };
    const registered = [];
    fakeExpress.application.post = function(route, ...handlers) {
      registered.push({ route, handlers });
      return this;
    };
    installHttpContainment(fakeExpress, { dataDir: dir, env: { NODE_ENV: "production" } });
    const sentinelMulter = () => { throw new Error("legacy multer must not be registered for /library/upsert"); };
    fakeExpress.application.post("/library/upsert", sentinelMulter, () => {});
    const route = registered.find(item => item.route === "/library/upsert");
    assert.ok(route);
    assert.equal(route.handlers.length, 1, "410 legacy route must short-circuit before Multer");
  }

  {
    const rate = createHttpContainment({
      dataDir: dir,
      env: { NODE_ENV: "production", BEATGALER_UPLOAD_RATE_MAX: "1", BEATGALER_UPLOAD_CONCURRENCY: "2" },
    });
    const firstReq = request({ token });
    const firstRes = responseRecorder();
    rate.preUpload(firstReq, firstRes, () => {});
    firstRes.emit("finish");
    const secondReq = request({ token });
    const secondRes = responseRecorder();
    let nextCalled = false;
    rate.preUpload(secondReq, secondRes, () => { nextCalled = true; });
    assert.equal(secondRes.statusCode, 429);
    assert.equal(nextCalled, false);
  }

  console.log("PASS regression-http-containment");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
