"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createAuthAbuseControls, installAuthAbuseControls } = require("../auth-abuse-controls");
const { FILE_UPLOAD_LIMIT_BYTES, createHttpContainment } = require("../http-containment");

function responseRecorder() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.payload = null;
  res.headers = {};
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.payload = payload; return res; };
  res.setHeader = (key, value) => { res.headers[String(key).toLowerCase()] = String(value); };
  return res;
}

function authRequest({ ip = "127.0.0.1", identifier = "", tenantId = "" } = {}) {
  return {
    headers: {},
    body: { identifier, tenantId },
    ip,
    socket: { remoteAddress: ip },
  };
}

async function invoke(control, req, status = 200) {
  const res = responseRecorder();
  let nextCalled = false;
  await control.middleware(req, res, () => { nextCalled = true; });
  if (nextCalled) {
    res.statusCode = status;
    res.emit("finish");
  }
  return { res, nextCalled };
}

function sessionKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function uploadRequest({ token = "", headers = {}, body = {}, ip = "127.0.0.1", file } = {}) {
  return {
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
    ip,
    socket: { remoteAddress: ip },
    file,
  };
}

(async () => {
  // Credential-stuffing control: IP dimension.
  {
    const control = createAuthAbuseControls({ env: {
      BEATGALER_AUTH_RATE_IP_MAX: "1",
      BEATGALER_AUTH_RATE_ACCOUNT_MAX: "100",
      BEATGALER_AUTH_RATE_TENANT_MAX: "100",
      BEATGALER_AUTH_FAILURE_DELAY_MS: "0",
    }});
    assert.equal((await invoke(control, authRequest({ ip: "10.0.0.1", identifier: "a" }))).nextCalled, true);
    const blocked = await invoke(control, authRequest({ ip: "10.0.0.1", identifier: "b" }));
    assert.equal(blocked.res.statusCode, 429, "same IP must be rate limited independently of account");
    assert.ok(blocked.res.headers["retry-after"]);
  }

  // Credential-stuffing control: account dimension across IP rotation.
  {
    const control = createAuthAbuseControls({ env: {
      BEATGALER_AUTH_RATE_IP_MAX: "100",
      BEATGALER_AUTH_RATE_ACCOUNT_MAX: "1",
      BEATGALER_AUTH_RATE_TENANT_MAX: "100",
      BEATGALER_AUTH_FAILURE_DELAY_MS: "0",
    }});
    assert.equal((await invoke(control, authRequest({ ip: "10.0.0.1", identifier: "victim@example.test" }))).nextCalled, true);
    const blocked = await invoke(control, authRequest({ ip: "10.0.0.2", identifier: "victim@example.test" }));
    assert.equal(blocked.res.statusCode, 429, "same account must be rate limited across IP rotation");
  }

  // Tenant dimension across IP/account rotation.
  {
    const control = createAuthAbuseControls({ env: {
      BEATGALER_AUTH_RATE_IP_MAX: "100",
      BEATGALER_AUTH_RATE_ACCOUNT_MAX: "100",
      BEATGALER_AUTH_RATE_TENANT_MAX: "1",
      BEATGALER_AUTH_FAILURE_DELAY_MS: "0",
    }});
    assert.equal((await invoke(control, authRequest({ ip: "10.0.0.1", identifier: "a", tenantId: "tenant-a" }))).nextCalled, true);
    const blocked = await invoke(control, authRequest({ ip: "10.0.0.2", identifier: "b", tenantId: "tenant-a" }));
    assert.equal(blocked.res.statusCode, 429, "tenant must be rate limited across IP/account rotation");
  }

  // Progressive delay is asynchronous/injected and grows after auth failures.
  {
    const delays = [];
    const control = createAuthAbuseControls({
      env: {
        BEATGALER_AUTH_RATE_IP_MAX: "100",
        BEATGALER_AUTH_RATE_ACCOUNT_MAX: "100",
        BEATGALER_AUTH_RATE_TENANT_MAX: "100",
        BEATGALER_AUTH_FAILURE_DELAY_MS: "7",
        BEATGALER_AUTH_FAILURE_DELAY_MAX_MS: "100",
      },
      sleep: async ms => { delays.push(ms); },
    });
    const req = authRequest({ identifier: "stuffing-target" });
    await invoke(control, req, 401);
    await invoke(control, req, 401);
    await invoke(control, req, 401);
    assert.deepEqual(delays, [7, 14], "failed credentials must receive progressive non-blocking delays");
  }

  // Malformed JSON is normalized to a deterministic 400 instead of falling into route logic.
  {
    const fakeExpress = {
      application: {
        post(route, ...handlers) { this.registered = { route, handlers }; return this; },
      },
      json() {
        return (_req, _res, done) => {
          const error = new SyntaxError("bad json");
          error.status = 400;
          done(error);
        };
      },
    };
    installAuthAbuseControls(fakeExpress, { env: { BEATGALER_AUTH_FAILURE_DELAY_MS: "0" } });
    const guarded = fakeExpress.json({ limit: "256kb" });
    const res = responseRecorder();
    let nextCalled = false;
    guarded(authRequest(), res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, "Malformed JSON body.");
    assert.equal(nextCalled, false);
  }

  // Upload/cross-tenant matrix reuses the session-bound containment model and never allocates a giant payload.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beatgaler-f1-6.2-"));
  const token = "f1-6.2-session";
  const foreignToken = "f1-6.2-foreign-session";
  const userId = "usr_a";
  const installationId = "tenant_a";
  const expiresAt = Date.now() + 60_000;
  fs.writeFileSync(path.join(dir, "accounts-data.json"), JSON.stringify({
    users: [{ id: userId }],
    sessions: {
      [sessionKey(token)]: { userId, expiresAt },
      [sessionKey(foreignToken)]: { userId, expiresAt },
    },
  }));
  fs.writeFileSync(path.join(dir, "cloud-data.json"), JSON.stringify({
    linkedAccounts: {
      [installationId]: { beatgalerAccountId: userId },
      tenant_b: { beatgalerAccountId: "usr_b" },
    },
  }));
  fs.writeFileSync(path.join(dir, "authz-session-bindings.json"), JSON.stringify({
    [sessionKey(token)]: { installationId, tenantId: userId, boundAt: Date.now(), expiresAt },
    [sessionKey(foreignToken)]: { installationId: "tenant_b", tenantId: userId, boundAt: Date.now(), expiresAt },
  }));

  try {
    const containment = createHttpContainment({ dataDir: dir, env: {
      NODE_ENV: "production",
      BEATGALER_UPLOAD_RATE_MAX: "100",
      BEATGALER_UPLOAD_CONCURRENCY: "1",
    }});

    // 401 unauthenticated, before multipart parsing.
    {
      const res = responseRecorder();
      let nextCalled = false;
      containment.preUpload(uploadRequest(), res, () => { nextCalled = true; });
      assert.equal(res.statusCode, 401);
      assert.equal(nextCalled, false);
    }

    // 403 cross-tenant: even a stale/forged session binding cannot authorize an installation owned by another account.
    {
      const req = uploadRequest({ token: foreignToken, headers: { "x-beatgaler-installation-id": "tenant_b" }, body: { beatgalerUserId: "tenant_b" } });
      const res = responseRecorder();
      containment.preUpload(req, res, () => assert.fail("foreign tenant must not continue"));
      assert.equal(res.statusCode, 403);
      res.emit("finish");
    }

    // 1.99 GB exact accepted at post-parse boundary; +1 byte rejected. No large file is created.
    {
      const req = uploadRequest({ token, headers: { "x-beatgaler-installation-id": installationId }, body: { beatgalerUserId: installationId }, file: { size: FILE_UPLOAD_LIMIT_BYTES } });
      const res = responseRecorder();
      containment.preUpload(req, res, () => {});
      let nextCalled = false;
      containment.postUpload(req, res, () => { nextCalled = true; });
      assert.equal(FILE_UPLOAD_LIMIT_BYTES, 1_990_000_000);
      assert.equal(nextCalled, true);
      res.emit("finish");
    }
    {
      const req = uploadRequest({ token, headers: { "x-beatgaler-installation-id": installationId }, body: { beatgalerUserId: installationId }, file: { size: FILE_UPLOAD_LIMIT_BYTES + 1 } });
      const res = responseRecorder();
      containment.preUpload(req, res, () => {});
      containment.postUpload(req, res, () => assert.fail("limit + 1 byte must not continue"));
      assert.equal(res.statusCode, 413);
      res.emit("finish");
    }

    // Early Content-Length rejection happens before multipart parsing and without payload allocation.
    {
      const req = uploadRequest({ token, headers: { "content-length": String(FILE_UPLOAD_LIMIT_BYTES + 1024 * 1024 + 1) } });
      const res = responseRecorder();
      let nextCalled = false;
      containment.preUpload(req, res, () => { nextCalled = true; });
      assert.equal(res.statusCode, 413);
      assert.equal(nextCalled, false);
    }

    // 429 concurrency, with no destructive payload/race.
    {
      const firstReq = uploadRequest({ token });
      const firstRes = responseRecorder();
      containment.preUpload(firstReq, firstRes, () => {});
      const secondReq = uploadRequest({ token });
      const secondRes = responseRecorder();
      let secondNext = false;
      containment.preUpload(secondReq, secondRes, () => { secondNext = true; });
      assert.equal(secondRes.statusCode, 429);
      assert.equal(secondNext, false);
      firstRes.emit("finish");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("PASS F1 6.2 abuse controls: 401/403/413/429, scoped limits, delays, malformed body, safe upload boundaries/concurrency");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});