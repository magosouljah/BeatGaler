"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mountAccountRouteGuards } = require('../account-route-guards');
const crypto = require("node:crypto");
const {
  createMemoryStore,
  installDirectCapabilityBoundary,
} = require("../direct-capability-boundary");
const { installProductiveTempAuthBoundary } = require("../productive-temp-auth-boundary");

function record(overrides = {}) {
  return {
    capability_hash: "a".repeat(64),
    internal_operation_id: "op_internal_a",
    user_id: "user-a",
    tenant_id: "tenant-a",
    installation_id: "install-a",
    auth_session_hash: "b".repeat(64),
    session_id: "session-a",
    generation: 1,
    vault_scope: "vault-a",
    operation_type: "download",
    object_scope: { object_type: "message", object_ids: ["101"] },
    issued_at_ms: 1_000,
    expires_at_ms: 11_000,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    capabilityHash: "a".repeat(64),
    userId: "user-a",
    tenantId: "tenant-a",
    installationId: "install-a",
    authSessionHash: "b".repeat(64),
    sessionId: "session-a",
    generation: 1,
    operationType: "download",
    objectScope: { object_type: "message", object_ids: ["101"] },
    clockSkewMs: 0,
    ...overrides,
  };
}

function createFakeExpress() {
  const routes = new Map();
  const application = {
    post(routePath, ...handlers) {
      routes.set(routePath, handlers);
      return application;
    },
  };
  return { application, routes };
}

async function runRoute(handlers, req) {
  let resolveSent;
  const sent = new Promise(resolve => { resolveSent = resolve; });
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = Number(code);
      return this;
    },
    json(payload) {
      resolveSent({ statusCode: this.statusCode, payload });
      return this;
    },
  };
  let index = 0;
  const next = async () => {
    const handler = handlers[index++];
    if (!handler) return;
    return handler(req, res, next);
  };
  await next();
  return sent;
}

function authHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function capabilityRouteRequest(body, overrides = {}) {
  return {
    headers: { authorization: "Bearer session-secret" },
    beatgalerAuthorizedUserId: "user-a",
    beatgalerAuthorizedTenantId: "tenant-a",
    beatgalerAuthorizedInstallationId: "install-a",
    body,
    ...overrides,
  };
}

test("authorize is one-shot and finish consumes only an authorized capability", async () => {
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 4 });
  await store.issue(record());
  const first = await store.authorize(request());
  assert.equal(first.ok, true);
  assert.equal(first.record.status, "AUTHORIZED");
  const replay = await store.authorize(request());
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "authorized");
  const finished = await store.finish(request());
  assert.equal(finished.ok, true);
  assert.equal(finished.authorized, true);
  assert.equal(finished.record.internal_operation_id, "op_internal_a");
  const endReplay = await store.finish(request());
  assert.equal(endReplay.ok, true);
  assert.equal(endReplay.authorized, true);
  assert.equal(endReplay.replay, true);
  assert.equal(endReplay.record.status, "CONSUMED");
});

test("capability A cannot authorize tenant/session/object B", async () => {
  const changes = [
    { userId: "user-b" }, { tenantId: "tenant-b" }, { installationId: "install-b" },
    { authSessionHash: "c".repeat(64) }, { sessionId: "session-b" }, { generation: 2 },
    { operationType: "download_range" },
    { objectScope: { object_type: "message", object_ids: ["102"] } },
  ];
  for (const [index, change] of changes.entries()) {
    const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 4 });
    const hash = String(index + 1).padStart(64, "0");
    await store.issue(record({ capability_hash: hash, internal_operation_id: `op-${index}` }));
    const result = await store.authorize(request({ capabilityHash: hash, ...change }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "scope");
  }
});

test("expiry is enforced by server time with bounded skew", async () => {
  let now = 12_000;
  const store = createMemoryStore({ now: () => now, maxActivePerTenant: 4 });
  await store.issue(record({ expires_at_ms: 10_000 }));
  const expired = await store.authorize(request({ clockSkewMs: 1_000 }));
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
});

test("memory capability store honors the same bounded expiry skew as PostgreSQL", async () => {
  let now = 9_000;
  const store = createMemoryStore({ now: () => now, maxActivePerTenant: 4 });
  await store.issue(record({ expires_at_ms: 10_000 }));
  now = 10_500;
  const withinSkew = await store.authorize(request({ clockSkewMs: 1_000 }));
  assert.equal(withinSkew.ok, true);
  assert.equal(withinSkew.record.status, "AUTHORIZED");
});

test("renewal keeps an authorized capability reusable and extends its lease", async () => {
  let now = 2_000;
  const store = createMemoryStore({ now: () => now, maxActivePerTenant: 4 });
  await store.issue(record({ expires_at_ms: 10_000 }));
  assert.equal((await store.authorize(request())).ok, true);

  now = 5_000;
  const first = await store.renew(request({ renewalLeaseMs: 30_000 }));
  assert.equal(first.ok, true);
  assert.equal(first.record.status, "AUTHORIZED");
  assert.equal(first.record.expires_at_ms, 35_000);

  now = 12_000;
  const second = await store.renew(request({ renewalLeaseMs: 30_000 }));
  assert.equal(second.ok, true);
  assert.equal(second.record.status, "AUTHORIZED");
  assert.equal(second.record.expires_at_ms, 42_000);
  assert.equal((await store.finish(request())).record.status, "CONSUMED");
});

test("renewal rejects mismatched, revoked, consumed and expired capabilities", async () => {
  let now = 2_000;
  const store = createMemoryStore({ now: () => now, maxActivePerTenant: 8 });
  await store.issue(record({ capability_hash: "a".repeat(64), internal_operation_id: "op-active" }));
  assert.equal((await store.authorize(request())).ok, true);
  for (const change of [{ sessionId: "session-b" }, { generation: 2 }, { installationId: "install-b" }]) {
    const denied = await store.renew(request(change));
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "scope");
  }

  await store.issue(record({ capability_hash: "c".repeat(64), internal_operation_id: "op-revoked" }));
  assert.equal((await store.authorize(request({ capabilityHash: "c".repeat(64) }))).ok, true);
  await store.revokeSession({ installationId: "install-a", sessionId: "session-a", reason: "lease_end" });
  const revoked = await store.renew(request());
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, "revoked");

  await store.issue(record({ capability_hash: "d".repeat(64), internal_operation_id: "op-consumed" }));
  const consumedInput = request({ capabilityHash: "d".repeat(64) });
  assert.equal((await store.authorize(consumedInput)).ok, true);
  assert.equal((await store.finish(consumedInput)).ok, true);
  const consumed = await store.renew(consumedInput);
  assert.equal(consumed.ok, false);
  assert.equal(consumed.reason, "consumed");

  await store.issue(record({ capability_hash: "e".repeat(64), internal_operation_id: "op-expired", expires_at_ms: 3_000 }));
  const expiredInput = request({ capabilityHash: "e".repeat(64) });
  assert.equal((await store.authorize(expiredInput)).ok, true);
  now = 10_000;
  const expired = await store.renew(expiredInput);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
});

test("tenant ceiling counts authorized operations as live", async () => {
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 2 });
  await store.issue(record({ capability_hash: "a".repeat(64), internal_operation_id: "op-1" }));
  assert.equal((await store.authorize(request())).ok, true);
  await store.issue(record({ capability_hash: "c".repeat(64), internal_operation_id: "op-2" }));
  await assert.rejects(
    store.issue(record({ capability_hash: "d".repeat(64), internal_operation_id: "op-3" })),
    error => error?.code === "DIRECT_TENANT_CAP_REACHED" && error?.status === 429,
  );
});

test("orphaned authorized capabilities are revoked when their Direct operations disappeared", async () => {
  let now = 2_000;
  const store = createMemoryStore({ now: () => now, maxActivePerTenant: 4 });
  const hashes = ["a", "c", "d", "e"].map(value => value.repeat(64));
  for (let index = 0; index < hashes.length; index += 1) {
    const hash = hashes[index];
    await store.issue(record({
      capability_hash: hash,
      internal_operation_id: `op-${index + 1}`,
      issued_at_ms: 1_000 + index,
      expires_at_ms: 20_000,
    }));
    assert.equal((await store.authorize(request({ capabilityHash: hash }))).ok, true);
  }
  await assert.rejects(
    store.issue(record({ capability_hash: "f".repeat(64), internal_operation_id: "op-5", expires_at_ms: 20_000 })),
    error => error?.code === "DIRECT_TENANT_CAP_REACHED",
  );

  now = 3_000;
  const revoked = await store.revokeMissingOperations({
    tenantId: "tenant-a",
    installationId: "install-a",
    sessionId: "session-a",
    liveOperationIds: ["op-4", "op-5"],
    reason: "direct_operation_missing",
  });
  assert.equal(revoked, 3);
  assert.equal(store.__records.get(hashes[0]).status, "REVOKED");
  assert.equal(store.__records.get(hashes[1]).status, "REVOKED");
  assert.equal(store.__records.get(hashes[2]).status, "REVOKED");
  assert.equal(store.__records.get(hashes[3]).status, "AUTHORIZED");

  await store.issue(record({
    capability_hash: "f".repeat(64),
    internal_operation_id: "op-5",
    issued_at_ms: 3_000,
    expires_at_ms: 20_000,
  }));
  assert.equal(store.__records.get("f".repeat(64)).status, "ACTIVE");
});

test("an abandoned pre-authorize capability can only be cleaned up", async () => {
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 4 });
  await store.issue(record());
  const result = await store.finish(request());
  assert.equal(result.ok, true);
  assert.equal(result.authorized, false);
  assert.equal(result.record.status, "REVOKED");
});

test("lease end, auth changes and incident revoke ACTIVE or AUTHORIZED capabilities", async () => {
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 8 });
  await store.issue(record({ capability_hash: "a".repeat(64), internal_operation_id: "op-1" }));
  await store.authorize(request());
  await store.issue(record({ capability_hash: "c".repeat(64), internal_operation_id: "op-2", session_id: "session-b" }));
  assert.equal(await store.revokeSession({ installationId: "install-a", sessionId: "session-a", reason: "lease_end" }), 1);
  assert.equal(store.__records.get("a".repeat(64)).status, "REVOKED");
  assert.equal(await store.revokeAuthSession({ authSessionHash: "b".repeat(64), reason: "password_change" }), 1);
  assert.equal(store.__records.get("c".repeat(64)).status, "REVOKED");
  const blockedAfterAuthRevoke = await store.authorize(request({ capabilityHash: "c".repeat(64), sessionId: "session-b" }));
  assert.equal(blockedAfterAuthRevoke.ok, false);
  assert.equal(blockedAfterAuthRevoke.reason, "revoked");
  await store.issue(record({ capability_hash: "d".repeat(64), internal_operation_id: "op-3", tenant_id: "tenant-z" }));
  assert.equal(await store.revokeTenant({ tenantId: "tenant-z", reason: "incident" }), 1);
  assert.equal(store.__records.get("d".repeat(64)).status, "REVOKED");
});

test("productive temp-auth strips permanent secrets from error and no-refresh response paths", async () => {
  const fakeExpress = createFakeExpress();
  installProductiveTempAuthBoundary(fakeExpress);
  const app = Object.create(fakeExpress.application);
  mountAccountRouteGuards(app);
  app.post("/transport/session/start", (_req, res) => res.json({
    ok: false,
    error: "denied",
    bot_token: "must-not-leak",
    telegram_api_id: 123,
    telegram_api_hash: "must-not-leak",
    credential_envelope: "must-not-leak",
  }));
  app.post("/transport/session/heartbeat", (_req, res) => res.json({
    ok: true,
    status: "ACTIVE",
    bot_token: "must-not-leak",
    telegram_api_id: 123,
    telegram_api_hash: "must-not-leak",
  }));

  const sessionResult = await runRoute(fakeExpress.routes.get("/transport/session/start"), {
    path: "/transport/session/start",
    body: {},
  });
  assert.equal(sessionResult.statusCode, 200);
  assert.deepEqual(sessionResult.payload, { ok: false, error: "denied" });

  const heartbeatResult = await runRoute(fakeExpress.routes.get("/transport/session/heartbeat"), {
    path: "/transport/session/heartbeat",
    body: {},
  });
  assert.equal(heartbeatResult.statusCode, 200);
  assert.deepEqual(heartbeatResult.payload, { ok: true, status: "ACTIVE" });
});

test("sensitive account routes revoke the whole authenticated capability set and ignore body installation hints", async () => {
  const calls = [];
  const store = {
    async revokeAuthSession(input) {
      calls.push(input);
      return 2;
    },
  };
  const fakeExpress = createFakeExpress();
  installDirectCapabilityBoundary(fakeExpress, { store, env: process.env });
  const app = Object.create(fakeExpress.application);
  mountAccountRouteGuards(app);
  const cases = [
    ["/auth/logout", "logout"],
    ["/auth/password/change", "password_change"],
    ["/auth/account/delete", "account_delete"],
  ];
  for (const [routePath] of cases) {
    app.post(routePath, (_req, res) => res.json({ ok: true }));
  }
  for (const [routePath, reason] of cases) {
    const result = await runRoute(fakeExpress.routes.get(routePath), {
      headers: { authorization: "Bearer session-secret" },
      body: { beatgalerUserId: "attacker-controlled-installation" },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, { ok: true });
    const call = calls.at(-1);
    assert.deepEqual(call, { authSessionHash: authHash("session-secret"), reason });
    assert.equal(Object.hasOwn(call, "installationId"), false);
  }
});

test("sensitive account route fails closed when durable capability revocation fails", async () => {
  const store = {
    async revokeAuthSession() {
      throw new Error("injected store failure");
    },
  };
  const fakeExpress = createFakeExpress();
  installDirectCapabilityBoundary(fakeExpress, { store, env: process.env });
  const app = Object.create(fakeExpress.application);
  mountAccountRouteGuards(app);
  app.post("/auth/password/change", (_req, res) => res.json({ ok: true }));
  const result = await runRoute(fakeExpress.routes.get("/auth/password/change"), {
    headers: { authorization: "Bearer session-secret" },
    body: { beatgalerUserId: "attacker-controlled-installation" },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.code, "DIRECT_CAPABILITY_REVOKE_FAILED");
  assert.match(result.payload.error, /revocation could not be committed/i);
});
