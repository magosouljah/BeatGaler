"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOperationKind, normalizeScope, createMemoryStore } = require("../direct-capability-boundary");

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

test("operation kinds are deny-by-default", () => {
  assert.equal(normalizeOperationKind("download"), "download");
  assert.throws(() => normalizeOperationKind("data"), /DIRECT_CAPABILITY_DENIED/);
  assert.throws(() => normalizeOperationKind("admin_anything"), /DIRECT_CAPABILITY_DENIED/);
});

test("scope requires an explicit allowlisted object and rejects wildcard ids", () => {
  assert.deepEqual(normalizeScope("download", { objectType: "message", objectIds: [102, 101, 101] }), {
    object_type: "message", object_ids: ["101", "102"],
  });
  assert.throws(() => normalizeScope("download", null), /SCOPE_REQUIRED/);
  assert.throws(() => normalizeScope("download", { objectType: "beat", objectIds: ["beat-a"] }), /SCOPE_DENIED/);
  assert.throws(() => normalizeScope("download", { objectType: "message", objectIds: ["*"] }), /SCOPE_INVALID/);
  assert.throws(() => normalizeScope("get_index", { objectType: "index", objectIds: ["old"] }), /canonical pinned index/);
  assert.deepEqual(normalizeScope("get_index", { objectType: "index", objectIds: ["pinned"] }), {
    object_type: "index", object_ids: ["pinned"],
  });
});

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
  assert.equal(endReplay.ok, false);
  assert.equal(endReplay.reason, "consumed");
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
  await store.issue(record({ capability_hash: "d".repeat(64), internal_operation_id: "op-3", tenant_id: "tenant-z" }));
  assert.equal(await store.revokeTenant({ tenantId: "tenant-z", reason: "incident" }), 1);
  assert.equal(store.__records.get("d".repeat(64)).status, "REVOKED");
});
