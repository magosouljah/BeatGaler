"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const directTransport = require("./direct-transport-control");

const DEFAULT_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 5 * 1000;
const DEFAULT_TENANT_ACTIVE_CAP = 4;
const SAFE_SCOPE_ID_RE = /^[A-Za-z0-9._:@+-]{1,192}$/;
const LIVE_STATUSES = new Set(["ACTIVE", "AUTHORIZED"]);
let installedRuntime = null;

const OPERATION_SCOPE_RULES = new Map([
  ["upload", new Set(["beat", "topic"])],
  ["download", new Set(["message"])],
  ["download_range", new Set(["message"])],
  ["probe_media", new Set(["message"])],
  ["get_index", new Set(["index"])],
  ["replace_index", new Set(["index"])],
  ["delete_messages", new Set(["message"])],
  ["load_artwork", new Set(["message"])],
  ["stream_master", new Set(["message"])],
  ["commit_import", new Set(["beat"])],
  ["commit_edit", new Set(["beat"])],
  ["trash_move", new Set(["beat"])],
  ["trash_restore", new Set(["trash"])],
  ["trash_purge", new Set(["trash"])],
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function bearerToken(req) {
  const raw = String(req.headers?.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function codedError(code, message, status = 403) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeOperationKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (!OPERATION_SCOPE_RULES.has(kind)) throw codedError("DIRECT_CAPABILITY_DENIED", "operation is not allowlisted.");
  return kind;
}

function normalizeScope(kindInput, scopeInput) {
  const kind = normalizeOperationKind(kindInput);
  if (!scopeInput || typeof scopeInput !== "object" || Array.isArray(scopeInput)) {
    throw codedError("DIRECT_CAPABILITY_SCOPE_REQUIRED", "explicit object scope is required.", 400);
  }
  const objectType = String(scopeInput.objectType || scopeInput.object_type || "").trim().toLowerCase();
  if (!OPERATION_SCOPE_RULES.get(kind).has(objectType)) {
    throw codedError("DIRECT_CAPABILITY_SCOPE_DENIED", `${kind} cannot target ${objectType || "unspecified"}.`);
  }
  const sourceIds = Array.isArray(scopeInput.objectIds || scopeInput.object_ids)
    ? (scopeInput.objectIds || scopeInput.object_ids)
    : [scopeInput.objectId ?? scopeInput.object_id];
  const objectIds = [...new Set(sourceIds.map(value => String(value ?? "").trim()).filter(Boolean))].sort();
  if (!objectIds.length || objectIds.length > 64 || objectIds.some(value => !SAFE_SCOPE_ID_RE.test(value) || value === "*")) {
    throw codedError("DIRECT_CAPABILITY_SCOPE_INVALID", "object ids must be explicit bounded identifiers.", 400);
  }
  if (objectType === "index" && (objectIds.length !== 1 || objectIds[0] !== "pinned")) {
    throw codedError("DIRECT_CAPABILITY_SCOPE_DENIED", "index scope must be the canonical pinned index.");
  }
  return { object_type: objectType, object_ids: objectIds };
}

function canonicalScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const objectType = String(value.object_type || value.objectType || "").trim().toLowerCase();
  const rawIds = Array.isArray(value.object_ids || value.objectIds) ? (value.object_ids || value.objectIds) : [];
  return {
    object_type: objectType,
    object_ids: [...new Set(rawIds.map(item => String(item ?? "").trim()).filter(Boolean))].sort(),
  };
}

function sameScope(left, right) {
  return JSON.stringify(canonicalScope(left)) === JSON.stringify(canonicalScope(right));
}

function capabilityToken() {
  return `cap_${crypto.randomBytes(32).toString("base64url")}`;
}

function readVaultScope(dataDir, installationId, tenantId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "cloud-data.json"), "utf8"));
    const account = parsed?.linkedAccounts?.[String(installationId)] || null;
    const vault = String(account?.storageChatId || account?.telegramUserId || "").trim();
    if (vault) return vault;
  } catch {}
  return `tenant-vault:${String(tenantId)}`;
}

function identityMatches(record, input) {
  return record.user_id === input.userId && record.tenant_id === input.tenantId &&
    record.installation_id === input.installationId && record.auth_session_hash === input.authSessionHash &&
    record.session_id === input.sessionId && Number(record.generation) === Number(input.generation);
}

function createMemoryStore({ now = () => Date.now(), maxActivePerTenant = DEFAULT_TENANT_ACTIVE_CAP } = {}) {
  const records = new Map();
  function expire() {
    const current = now();
    for (const record of records.values()) {
      if (LIVE_STATUSES.has(record.status) && record.expires_at_ms < current) record.status = "EXPIRED";
    }
  }
  return {
    async issue(record) {
      expire();
      const live = [...records.values()].filter(item => LIVE_STATUSES.has(item.status) && item.tenant_id === record.tenant_id).length;
      if (live >= maxActivePerTenant) throw codedError("DIRECT_TENANT_CAP_REACHED", "too many active Direct operations for this tenant.", 429);
      records.set(record.capability_hash, { ...record, status: "ACTIVE" });
      return { ...records.get(record.capability_hash) };
    },
    async authorize(input) {
      expire();
      const record = records.get(input.capabilityHash);
      if (!record) return { ok: false, reason: "unknown" };
      if (!identityMatches(record, input)) return { ok: false, reason: "scope", record: { ...record } };
      if (record.operation_type !== input.operationType || !sameScope(record.object_scope, input.objectScope)) {
        return { ok: false, reason: "scope", record: { ...record } };
      }
      if (record.status !== "ACTIVE") return { ok: false, reason: record.status.toLowerCase(), record: { ...record } };
      if (record.expires_at_ms + input.clockSkewMs < now()) {
        record.status = "EXPIRED";
        return { ok: false, reason: "expired", record: { ...record } };
      }
      record.status = "AUTHORIZED";
      record.authorized_at_ms = now();
      return { ok: true, record: { ...record } };
    },
    async finish(input) {
      expire();
      const record = records.get(input.capabilityHash);
      if (!record) return { ok: false, reason: "unknown" };
      if (!identityMatches(record, input)) return { ok: false, reason: "scope", record: { ...record } };
      if (record.status === "ACTIVE") {
        record.status = "REVOKED";
        record.revoke_reason = "abandoned_before_authorize";
        record.revoked_at_ms = now();
        return { ok: true, authorized: false, record: { ...record } };
      }
      if (record.status === "CONSUMED") return { ok: true, authorized: true, replay: true, record: { ...record } };
      if (record.status !== "AUTHORIZED") return { ok: false, reason: record.status.toLowerCase(), record: { ...record } };
      if (record.expires_at_ms + input.clockSkewMs < now()) {
        record.status = "EXPIRED";
        return { ok: false, reason: "expired", record: { ...record } };
      }
      record.status = "CONSUMED";
      record.consumed_at_ms = now();
      return { ok: true, authorized: true, record: { ...record } };
    },
    async revokeSession({ installationId, sessionId, reason }) {
      let count = 0;
      for (const record of records.values()) {
        if (LIVE_STATUSES.has(record.status) && record.installation_id === installationId && record.session_id === sessionId) {
          record.status = "REVOKED"; record.revoke_reason = reason; record.revoked_at_ms = now(); count += 1;
        }
      }
      return count;
    },
    async revokeAuthSession({ authSessionHash, installationId = null, reason }) {
      let count = 0;
      for (const record of records.values()) {
        if (!LIVE_STATUSES.has(record.status) || record.auth_session_hash !== authSessionHash) continue;
        if (installationId && record.installation_id !== installationId) continue;
        record.status = "REVOKED"; record.revoke_reason = reason; record.revoked_at_ms = now(); count += 1;
      }
      return count;
    },
    async revokeTenant({ tenantId, reason }) {
      let count = 0;
      for (const record of records.values()) {
        if (LIVE_STATUSES.has(record.status) && record.tenant_id === tenantId) {
          record.status = "REVOKED"; record.revoke_reason = reason; record.revoked_at_ms = now(); count += 1;
        }
      }
      return count;
    },
    __records: records,
  };
}

function createPostgresStore(pool, { maxActivePerTenant = DEFAULT_TENANT_ACTIVE_CAP } = {}) {
  if (!pool || typeof pool.connect !== "function") throw new Error("PostgreSQL pool is required.");
  const find = async capabilityHash => (await pool.query(
    "SELECT internal_operation_id,user_id,tenant_id,installation_id,auth_session_hash,session_id,generation,vault_scope,operation_type,object_scope,status,expires_at FROM direct_capabilities WHERE capability_hash=$1",
    [capabilityHash],
  )).rows[0] || null;
  return {
    async issue(record) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`direct-capability-tenant:${record.tenant_id}`]);
        await client.query("UPDATE direct_capabilities SET status='EXPIRED' WHERE tenant_id=$1 AND status IN ('ACTIVE','AUTHORIZED') AND expires_at < now()", [record.tenant_id]);
        const live = Number((await client.query("SELECT count(*)::int AS n FROM direct_capabilities WHERE tenant_id=$1 AND status IN ('ACTIVE','AUTHORIZED') AND expires_at >= now()", [record.tenant_id])).rows[0]?.n || 0);
        if (live >= maxActivePerTenant) throw codedError("DIRECT_TENANT_CAP_REACHED", "too many active Direct operations for this tenant.", 429);
        await client.query(`INSERT INTO direct_capabilities(
          capability_hash,internal_operation_id,user_id,tenant_id,installation_id,auth_session_hash,
          session_id,generation,vault_scope,operation_type,object_scope,status,issued_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'ACTIVE',to_timestamp($12 / 1000.0),to_timestamp($13 / 1000.0))`, [
          record.capability_hash, record.internal_operation_id, record.user_id, record.tenant_id, record.installation_id,
          record.auth_session_hash, record.session_id, record.generation, record.vault_scope, record.operation_type,
          JSON.stringify(record.object_scope), record.issued_at_ms, record.expires_at_ms,
        ]);
        await client.query("COMMIT");
        return record;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
    },
    async authorize(input) {
      const updated = await pool.query(`UPDATE direct_capabilities SET status='AUTHORIZED', authorized_at=now()
        WHERE capability_hash=$1 AND user_id=$2 AND tenant_id=$3 AND installation_id=$4 AND auth_session_hash=$5
          AND session_id=$6 AND generation=$7 AND operation_type=$8 AND object_scope=$9::jsonb
          AND status='ACTIVE' AND expires_at >= now() - ($10::bigint * interval '1 millisecond')
        RETURNING internal_operation_id,user_id,tenant_id,installation_id,auth_session_hash,session_id,generation,vault_scope,operation_type,object_scope,status`, [
        input.capabilityHash,input.userId,input.tenantId,input.installationId,input.authSessionHash,input.sessionId,
        input.generation,input.operationType,JSON.stringify(input.objectScope),input.clockSkewMs,
      ]);
      if (updated.rows.length === 1) return { ok: true, record: updated.rows[0] };
      const record = await find(input.capabilityHash);
      if (!record) return { ok: false, reason: "unknown" };
      const sameIdentity = String(record.user_id) === input.userId && String(record.tenant_id) === input.tenantId &&
        String(record.installation_id) === input.installationId && String(record.auth_session_hash) === input.authSessionHash &&
        String(record.session_id) === input.sessionId && Number(record.generation) === Number(input.generation);
      const sameOperation = String(record.operation_type) === input.operationType && sameScope(record.object_scope, input.objectScope);
      return { ok: false, reason: sameIdentity && sameOperation ? String(record.status || "denied").toLowerCase() : "scope", record };
    },
    async finish(input) {
      const updated = await pool.query(`UPDATE direct_capabilities SET
          status=CASE WHEN status='AUTHORIZED' THEN 'CONSUMED' ELSE 'REVOKED' END,
          consumed_at=CASE WHEN status='AUTHORIZED' THEN now() ELSE NULL END,
          revoked_at=CASE WHEN status='ACTIVE' THEN now() ELSE revoked_at END,
          revoke_reason=CASE WHEN status='ACTIVE' THEN 'abandoned_before_authorize' ELSE revoke_reason END
        WHERE capability_hash=$1 AND user_id=$2 AND tenant_id=$3 AND installation_id=$4 AND auth_session_hash=$5
          AND session_id=$6 AND generation=$7 AND status IN ('ACTIVE','AUTHORIZED')
          AND expires_at >= now() - ($8::bigint * interval '1 millisecond')
        RETURNING internal_operation_id,user_id,tenant_id,installation_id,session_id,generation,vault_scope,operation_type,object_scope,status,authorized_at`, [
        input.capabilityHash,input.userId,input.tenantId,input.installationId,input.authSessionHash,input.sessionId,input.generation,input.clockSkewMs,
      ]);
      if (updated.rows.length === 1) {
        const record = updated.rows[0];
        return { ok: true, authorized: record.status === "CONSUMED", record };
      }
      const record = await find(input.capabilityHash);
      if (!record) return { ok: false, reason: "unknown" };
      const sameIdentity = String(record.user_id) === input.userId && String(record.tenant_id) === input.tenantId &&
        String(record.installation_id) === input.installationId && String(record.auth_session_hash) === input.authSessionHash &&
        String(record.session_id) === input.sessionId && Number(record.generation) === Number(input.generation);
      if (sameIdentity && String(record.status) === "CONSUMED") return { ok: true, authorized: true, replay: true, record };
      return { ok: false, reason: sameIdentity ? String(record.status || "denied").toLowerCase() : "scope", record };
    },
    async revokeSession({ installationId, sessionId, reason }) {
      const result = await pool.query("UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$3 WHERE installation_id=$1 AND session_id=$2 AND status IN ('ACTIVE','AUTHORIZED')", [installationId,sessionId,reason]);
      return result.rowCount || 0;
    },
    async revokeAuthSession({ authSessionHash, installationId = null, reason }) {
      const result = installationId
        ? await pool.query("UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$3 WHERE auth_session_hash=$1 AND installation_id=$2 AND status IN ('ACTIVE','AUTHORIZED')", [authSessionHash,installationId,reason])
        : await pool.query("UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$2 WHERE auth_session_hash=$1 AND status IN ('ACTIVE','AUTHORIZED')", [authSessionHash,reason]);
      return result.rowCount || 0;
    },
    async revokeTenant({ tenantId, reason }) {
      const result = await pool.query("UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$2 WHERE tenant_id=$1 AND status IN ('ACTIVE','AUTHORIZED')", [tenantId,reason]);
      return result.rowCount || 0;
    },
  };
}

function responseError(res, error) {
  return res.status(Number(error?.status || 500)).json({
    error: String(error?.message || "Direct capability boundary failed."),
    code: error?.code || "DIRECT_CAPABILITY_ERROR",
  });
}

function requestIdentity(req, fallback = null) {
  const userId = String(fallback?.userId || req.beatgalerAuthorizedUserId || "").trim();
  const tenantId = String(fallback?.tenantId || req.beatgalerAuthorizedTenantId || "").trim();
  const installationId = String(fallback?.installationId || req.beatgalerAuthorizedInstallationId || req.body?.beatgalerUserId || "").trim();
  const token = bearerToken(req);
  if (!userId || !tenantId || !installationId || !token) throw codedError("DIRECT_CAPABILITY_AUTHZ_REQUIRED", "session-bound authorization must run first.");
  return { userId, tenantId, installationId, authSessionHash: sha256(token) };
}

function capabilityInput(req, claims, { requireScope = false } = {}) {
  const capability = String(req.body?.operationId || req.body?.capability || "").trim();
  if (!capability.startsWith("cap_") || capability.length < 40) throw codedError("DIRECT_CAPABILITY_REQUIRED", "operation capability is missing.");
  const input = {
    capabilityHash: sha256(capability),
    ...claims,
    sessionId: String(req.body?.sessionId || ""),
    generation: Number(req.body?.generation || 0),
    clockSkewMs: installedRuntime?.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
  };
  if (requireScope) {
    input.operationType = normalizeOperationKind(req.body?.kind);
    input.objectScope = normalizeScope(input.operationType, req.body?.scope);
  }
  return { capability, input };
}

async function authorizePresentedCapability(req, fallbackIdentity = null) {
  if (!installedRuntime?.store) throw codedError("DIRECT_CAPABILITY_UNAVAILABLE", "capability store is unavailable.", 503);
  const claims = requestIdentity(req, fallbackIdentity);
  const { capability, input } = capabilityInput(req, claims, { requireScope: true });
  const result = await installedRuntime.store.authorize(input);
  if (!result.ok) {
    const code = result.reason === "scope" ? "DIRECT_CAPABILITY_SCOPE_DENIED" : "DIRECT_CAPABILITY_REPLAY_OR_EXPIRED";
    throw codedError(code, "capability is not active for this exact session/operation/object.");
  }
  return {
    ok: true,
    authorized: true,
    operation_id: capability,
    capability: {
      operation: result.record.operation_type,
      object_scope: result.record.object_scope,
      vault_scope: result.record.vault_scope,
    },
  };
}

async function revokeTenantCapabilities(tenantId, reason = "incident") {
  if (!installedRuntime?.store) throw codedError("DIRECT_CAPABILITY_UNAVAILABLE", "capability store is unavailable.", 503);
  return installedRuntime.store.revokeTenant({ tenantId: String(tenantId), reason: String(reason || "incident") });
}

function installDirectCapabilityBoundary(express, options = {}) {
  if (express.application.__beatgalerDirectCapabilitiesInstalled) return installedRuntime;
  express.application.__beatgalerDirectCapabilitiesInstalled = true;
  const env = options.env || process.env;
  const dataDir = options.dataDir || __dirname;
  const now = options.now || (() => Date.now());
  const ttlMs = Math.max(30_000, Math.min(30 * 60 * 1000, Number(env.BEATGALER_DIRECT_CAPABILITY_TTL_MS || DEFAULT_CAPABILITY_TTL_MS)));
  const clockSkewMs = Math.max(0, Math.min(30_000, Number(env.BEATGALER_DIRECT_CAPABILITY_CLOCK_SKEW_MS || DEFAULT_CLOCK_SKEW_MS)));
  const maxActivePerTenant = Math.max(1, Math.min(16, Number(env.BEATGALER_DIRECT_TENANT_ACTIVE_CAP || DEFAULT_TENANT_ACTIVE_CAP)));
  const store = options.store || (options.pool ? createPostgresStore(options.pool, { maxActivePerTenant }) : createMemoryStore({ now, maxActivePerTenant }));
  installedRuntime = { store, ttlMs, clockSkewMs, maxActivePerTenant };
  const originalPost = express.application.post;

  async function cleanupInternalOperation(req, internalOperationId) {
    if (!internalOperationId) return;
    try {
      await directTransport.endOperation({
        installationId: String(req.beatgalerAuthorizedInstallationId || req.body?.beatgalerUserId || ""),
        sessionId: String(req.body?.sessionId || ""),
        generation: Number(req.body?.generation || 0),
        operationId: internalOperationId,
      });
    } catch {}
  }

  function beginCapability(req, res, next) {
    let claims, kind, scope;
    try {
      claims = requestIdentity(req);
      kind = normalizeOperationKind(req.body?.kind);
      scope = normalizeScope(kind, req.body?.scope);
    } catch (error) { return responseError(res, error); }
    const originalJson = res.json.bind(res);
    res.json = payload => {
      if (!(Number(res.statusCode || 200) < 300 && payload?.ok === true && payload?.operation_id)) return originalJson(payload);
      const internalOperationId = String(payload.operation_id);
      const token = capabilityToken();
      const issuedAt = now();
      const record = {
        capability_hash: sha256(token), internal_operation_id: internalOperationId,
        user_id: claims.userId, tenant_id: claims.tenantId, installation_id: claims.installationId,
        auth_session_hash: claims.authSessionHash, session_id: String(req.body?.sessionId || ""),
        generation: Number(req.body?.generation || 0), vault_scope: readVaultScope(dataDir, claims.installationId, claims.tenantId),
        operation_type: kind, object_scope: scope, issued_at_ms: issuedAt, expires_at_ms: issuedAt + ttlMs,
      };
      void store.issue(record).then(() => originalJson({
        ...payload,
        operation_id: token,
        capability: {
          token, user_id: claims.userId, tenant_id: claims.tenantId, installation_id: claims.installationId,
          vault_scope: record.vault_scope, operation: kind, object_scope: scope,
          issued_at: new Date(issuedAt).toISOString(), expires_at: new Date(record.expires_at_ms).toISOString(),
        },
      })).catch(async error => {
        await cleanupInternalOperation(req, internalOperationId);
        responseError(res, error);
      });
      return res;
    };
    next();
  }

  async function finishCapability(req, res, next) {
    let claims, parsed;
    try {
      claims = requestIdentity(req);
      parsed = capabilityInput(req, claims);
    } catch (error) { return responseError(res, error); }
    try {
      const result = await store.finish(parsed.input);
      if (!result.ok) {
        const code = result.reason === "scope" ? "DIRECT_CAPABILITY_SCOPE_DENIED" : "DIRECT_CAPABILITY_REPLAY_OR_EXPIRED";
        return responseError(res, codedError(code, "capability cannot be finished for this session."));
      }
      req.body.operationId = String(result.record.internal_operation_id);
      next();
    } catch (error) { responseError(res, error); }
  }

  async function revokeSession(req, _res, next) {
    const installationId = String(req.beatgalerAuthorizedInstallationId || req.body?.beatgalerUserId || "");
    const sessionId = String(req.body?.sessionId || "");
    if (installationId && sessionId) await store.revokeSession({ installationId, sessionId, reason: "lease_end" }).catch(() => {});
    next();
  }

  function revokeAuthOnSuccess(reason) {
    return (req, res, next) => {
      const authSessionHash = sha256(bearerToken(req));
      const installationId = String(req.body?.beatgalerUserId || req.beatgalerAuthorizedInstallationId || "").trim() || null;
      const originalJson = res.json.bind(res);
      res.json = payload => {
        if (Number(res.statusCode || 200) >= 200 && Number(res.statusCode || 200) < 300 && authSessionHash) {
          void store.revokeAuthSession({ authSessionHash, installationId, reason }).finally(() => originalJson(payload));
          return res;
        }
        return originalJson(payload);
      };
      next();
    };
  }

  async function authorizeCapability(req, res) {
    try {
      return res.json(await authorizePresentedCapability(req));
    } catch (error) {
      return responseError(res, error);
    }
  }

  express.application.post = function patchedDirectCapabilityPost(routePath, ...handlers) {
    if (routePath === "/transport/operation/begin") {
      if (!this.__beatgalerDirectCapabilityAuthorizeRouteInstalled) {
        this.__beatgalerDirectCapabilityAuthorizeRouteInstalled = true;
        originalPost.call(this, "/transport/capability/authorize", authorizeCapability);
      }
      return originalPost.call(this, routePath, beginCapability, ...handlers);
    }
    if (routePath === "/transport/operation/end") return originalPost.call(this, routePath, finishCapability, ...handlers);
    if (routePath === "/transport/session/stop") return originalPost.call(this, routePath, revokeSession, ...handlers);
    if (routePath === "/auth/logout") return originalPost.call(this, routePath, revokeAuthOnSuccess("logout"), ...handlers);
    if (routePath === "/auth/password/change") return originalPost.call(this, routePath, revokeAuthOnSuccess("password_change"), ...handlers);
    if (routePath === "/auth/account/delete") return originalPost.call(this, routePath, revokeAuthOnSuccess("account_delete"), ...handlers);
    return originalPost.call(this, routePath, ...handlers);
  };
  return installedRuntime;
}

module.exports = {
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_TENANT_ACTIVE_CAP,
  OPERATION_SCOPE_RULES,
  normalizeOperationKind,
  normalizeScope,
  createMemoryStore,
  createPostgresStore,
  authorizePresentedCapability,
  revokeTenantCapabilities,
  installDirectCapabilityBoundary,
};
