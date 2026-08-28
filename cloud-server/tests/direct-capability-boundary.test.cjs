"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOperationKind,
  normalizeScope,
  createMemoryStore,
} = require("../direct-capability-boundary");

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

test("operation kinds are deny-by-default", () => {
  assert.equal(normalizeOperationKind("download"), "download");
  assert.throws(() => normalizeOperationKind("data"), /DIRECT_CAPABILITY_DENIED/);
  assert.throws(() => normalizeOperationKind("admin_anything"), /DIRECT_CAPABILITY_DENIED/);
});

test("scope requires an explicit allowlisted object and rejects wildcard ids", () => {
  assert.deepEqual(normalizeScope("download", { objectType: "message", objectIds: [102, 101, 101] }), {
    object_type: "message",
    object_ids: ["101", "102"],
  });
  assert.throws(() => normalizeScope("download", null), /SCOPE_REQUIRED/);
  assert.throws(() => normalizeScope("download", { objectType: "beat", objectIds: ["beat-a"] }), /SCOPE_DENIED/);
  assert.throws(() => normalizeScope("download", { objectType: "message", objectIds: ["*"] }), /SCOPE_INVALID/);
  assert.throws(() => normalizeScope("get_index", { objectType: "index", objectIds: ["old"] }), /canonical pinned index/);
  assert.deepEqual(normalizeScope("get_index", { objectType: "index", objectIds: ["pinned"] }), {
    object_type: "index",
    object_ids: ["pinned"],
  });
});

test("capability is one-shot and cannot be replayed", async () => {
  let now = 2_000;
  const store = createMemoryStore({ now: () => now, maxActivePerTenant: 4 });
  await store.issue(record());
  const first = await store.consume({
    capabilityHash: "a".repeat(64), userId: "user-a", tenantId: "tenant-a", installationId: "install-a",
    sessionId: "session-a", generation: 1, clockSkewMs: 0,
  });
  assert.equal(first.ok, true);
  assert.equal(first.record.internal_operation_id, "op_internal_a");
  const replay = await store.consume({
    capabilityHash: "a".repeat(64), userId: "user-a", tenantId: "tenant-a", installationId: "install-a",
    sessionId: "session-a", generation: 1, clockSkewMs: 0,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "consumed");
});

test("capability A cannot be consumed by tenant/installation/session B", async () => {
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 4 });
  await store.issue(record());
  for (const change of [
    { userId: "user-b" }, { tenantId: "tenant-b" }, { installationId: "install-b" },
    { sessionId: "session-b" }, { generation: 2 },
  ]) {
    const result = await store.consume({
      capabilityHash: "a".repeat(64), userId: "user-a", tenantId: "tenant-a", installationId: "install-a",
      sessionId: "session-a", generation: 1, clockSkewMs: 0, ...change,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "scope");
  }
});

test("expiry uses server time and bounded server-side skew only", async () => {
  let now = 12_000;
  const store = createMemoryStore({ now: () => now, maxActivePerTenant: 4 });
  await store.issue(record({ expires_at_ms: 10_000 }));
  const expired = await store.consume({
    capabilityHash: "a".repeat(64), userId: "user-a", tenantId: "tenant-a", installationId: "install-a",
    sessionId: "session-a", generation: 1, clockSkewMs: 1_000,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
});

test("tenant active ceiling is enforced without creating another capability", async () => {
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 2 });
  await store.issue(record({ capability_hash: "a".repeat(64), internal_operation_id: "op-1" }));
  await store.issue(record({ capability_hash: "c".repeat(64), internal_operation_id: "op-2" }));
  await assert.rejects(
    store.issue(record({ capability_hash: "d".repeat(64), internal_operation_id: "op-3" })),
    error => error?.code === "DIRECT_TENANT_CAP_REACHED" && error?.status === 429,
  );
});

test("lease end, logout/password session and incident paths revoke active capabilities", async () => {
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 8 });
  await store.issue(record({ capability_hash: "a".repeat(64), internal_operation_id: "op-1" }));
  await store.issue(record({ capability_hash: "c".repeat(64), internal_operation_id: "op-2", session_id: "session-b" }));
  assert.equal(await store.revokeSession({ installationId: "install-a", sessionId: "session-a", reason: "lease_end" }), 1);
  assert.equal(store.__records.get("a".repeat(64)).status, "REVOKED");
  assert.equal(await store.revokeAuthSession({ authSessionHash: "b".repeat(64), reason: "password_change" }), 1);
  assert.equal(store.__records.get("c".repeat(64)).status, "REVOKED");

  await store.issue(record({ capability_hash: "d".repeat(64), internal_operation_id: "op-3", tenant_id: "tenant-z" }));
  assert.equal(await store.revokeTenant({ tenantId: "tenant-z", reason: "incident" }), 1);
  assert.equal(store.__records.get("d".repeat(64)).status, "REVOKED");
});
