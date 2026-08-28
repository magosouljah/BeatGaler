import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module, { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(root, rel), "utf8");
const require = createRequire(import.meta.url);
const findings = [];
const finding = message => findings.push(message);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./direct-transport-control" && String(parent?.filename || "").endsWith("direct-capability-boundary.js")) {
    return { endOperation: async () => ({ ok: true }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let createMemoryStore;
try {
  ({ createMemoryStore } = require("../cloud-server/direct-capability-boundary.js"));
} finally {
  Module._load = originalLoad;
}

function record(overrides = {}) {
  return {
    capability_hash: "a".repeat(64),
    internal_operation_id: "internal-a",
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
    expires_at_ms: 10_000,
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

// Independent A -> B / replay probe. This deliberately re-tests the contract
// rather than trusting the implementation author's unit suite.
{
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 4 });
  await store.issue(record());
  const wrongVaultObject = await store.authorize(request({
    objectScope: { object_type: "message", object_ids: ["202"] },
  }));
  if (wrongVaultObject.ok || wrongVaultObject.reason !== "scope") {
    finding("capability A was not denied for object B");
  }
  const first = await store.authorize(request());
  if (!first.ok) finding("exact-scope capability A could not authorize once");
  const replay = await store.authorize(request());
  if (replay.ok) finding("capability replay was accepted after first authorization");
  console.log("PASS AAA probe: object substitution denied and capability replay rejected");
}

// Explicit session close/revoke must kill a still-unused capability.
{
  const store = createMemoryStore({ now: () => 2_000, maxActivePerTenant: 4 });
  await store.issue(record());
  await store.revokeSession({ installationId: "install-a", sessionId: "session-a", reason: "aaa_closed_session" });
  const afterClose = await store.authorize(request());
  if (afterClose.ok || afterClose.reason !== "revoked") {
    finding("explicitly closed session still authorizes its capability");
  }
  console.log("PASS AAA probe: explicit session revoke blocks unused capability");
}

// The two stores are intended to implement one D7 contract. PostgreSQL accepts
// within bounded clock skew; the in-memory store used by non-PG/dev paths must
// not silently implement a stricter/different expiry rule.
{
  let now = 9_000;
  const store = createMemoryStore({ now: () => now, maxActivePerTenant: 4 });
  await store.issue(record({ expires_at_ms: 10_000 }));
  now = 10_500;
  const withinSkew = await store.authorize(request({ clockSkewMs: 1_000 }));
  if (!withinSkew.ok) {
    finding(`memory capability store rejects a request 500ms past expiry despite 1000ms allowed skew (reason=${withinSkew.reason || "unknown"})`);
  }
}

const tempBoundary = read("cloud-server/productive-temp-auth-boundary.js");
const capabilityBoundary = read("cloud-server/direct-capability-boundary.js");
const directTransport = read("cloud-server/direct-transport-control.js");

function block(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  if (start < 0) return "";
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

// Fail-closed means every target response is sanitized before an early return.
// The browser-side guard is defense-in-depth; it is not permission for Cloud to
// emit a permanent credential and rely on the client to reject it.
{
  const sessionTransform = block(tempBoundary, "async function transformSession", "async function transformTransportBody");
  const sanitizer = sessionTransform.indexOf("stripPermanentSecrets(session)");
  const rawErrorReturn = sessionTransform.indexOf("session.ok === false) return session");
  if (rawErrorReturn >= 0 && (sanitizer < 0 || rawErrorReturn < sanitizer)) {
    finding("productive temp-auth session error path returns the raw response before permanent-secret stripping");
  }

  const bodyTransform = block(tempBoundary, "async function transformTransportBody", "function installProductiveTempAuthBoundary");
  if (/\n\s*return body;\s*\n\}/.test(bodyTransform)) {
    finding("productive heartbeat/operation fallback returns the raw body without permanent-secret stripping");
  }
}

// Closed-session and quarantined-bot tests are lifecycle tests, not merely
// record-store tests. Authorization must either consult current Direct lease/bot
// state or Direct timeout/quarantine transitions must revoke the capability
// store. This does NOT treat the RO-approved shared-bot fallback itself as a
// failure; it only rejects use after the assigned lease/bot becomes invalid.
{
  const authorizeBlock = block(capabilityBoundary, "async function authorizePresentedCapability", "async function revokeTenantCapabilities");
  const authorizeConsultsTransport = /directTransport\.(?!endOperation\b)[A-Za-z0-9_]+\s*\(/.test(authorizeBlock);
  const transportPushesCapabilityRevocation = /capabil/i.test(directTransport) &&
    /heartbeat_timeout/i.test(directTransport) && /quarantin/i.test(directTransport);
  if (!authorizeConsultsTransport && !transportPushesCapabilityRevocation) {
    finding("capability authorization is not coupled to live lease expiry or bot quarantine state; heartbeat-timeout/quarantine can invalidate Direct transport without revoking an ACTIVE capability");
  }
}

if (findings.length) {
  throw new Error(`Task 7.2 adversarial findings (${findings.length}):\n- ${findings.join("\n- ")}`);
}

console.log("PASS Task 7.2 adversarial matrix: A→B/replay/expiry-skew/closed-session/quarantine and fail-closed boundary invariants hold");
