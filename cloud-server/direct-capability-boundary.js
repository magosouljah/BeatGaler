"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const directTransport = require("./direct-transport-control");

const DEFAULT_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 5 * 1000;
const DEFAULT_TENANT_ACTIVE_CAP = 4;
const SAFE_SCOPE_ID_RE = /^[A-Za-z0-9._:@+-]{1,192}$/;

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

function normalizeOperationKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (!OPERATION_SCOPE_RULES.has(kind)) {
    const error = new Error("DIRECT_CAPABILITY_DENIED: operation is not allowlisted.");
    error.status = 403;
    error.code = "DIRECT_CAPABILITY_DENIED";
    throw error;
  }
  return kind;
}

function normalizeScope(kindInput, scopeInput) {
  const kind = normalizeOperationKind(kindInput);
  if (!scopeInput || typeof scopeInput !== "object" || Array.isArray(scopeInput)) {
    const error = new Error("DIRECT_CAPABILITY_SCOPE_REQUIRED: explicit object scope is required.");
    error.status = 400;
    error.code = "DIRECT_CAPABILITY_SCOPE_REQUIRED";
    throw error;
  }
  const objectType = String(scopeInput.objectType || scopeInput.object_type || "").trim().toLowerCase();
  const allowedTypes = OPERATION_SCOPE_RULES.get(kind);
  if (!allowedTypes.has(objectType)) {
    const error = new Error(`DIRECT_CAPABILITY_SCOPE_DENIED: ${kind} cannot target ${objectType || "unspecified"}.`);
    error.status = 403;
    error.code = "DIRECT_CAPABILITY_SCOPE_DENIED";
    throw error;
  }
  const rawIds = Array.isArray(scopeInput.objectIds || scopeInput.object_ids)
    ? (scopeInput.objectIds || scopeInput.object_ids)
    : [scopeInput.objectId ?? scopeInput.object_id];
  const objectIds = [...new Set(rawIds.map(value => String(value ?? "").trim()).filter(Boolean))];
  if (!objectIds.length || objectIds.length > 64 || objectIds.some(value => !SAFE_SCOPE_ID_RE.test(value) || value === "*")) {
    const error = new Error("DIRECT_CAPABILITY_SCOPE_INVALID: object ids must be explicit bounded identifiers.");
    error.status = 400;
    error.code = "DIRECT_CAPABILITY_SCOPE_INVALID";
    throw error;
  }
  if (objectType === "index" && (objectIds.length !== 1 || objectIds[0] !== "pinned")) {
    const error = new Error("DIRECT_CAPABILITY_SCOPE_DENIED: index scope must be the canonical pinned index.");
    error.status = 403;
    error.code = "DIRECT_CAPABILITY_SCOPE_DENIED";
    throw error;
  }
  return { object_type: objectType, object_ids: objectIds.sort() };
}

function capabilityToken() {
  return `cap_${crypto.randomBytes(32).toString("base64url")}`;
}

function readVaultScope(dataDir, installationId, tenantId) {
  const file = path.join(dataDir, "cloud-data.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const account = parsed?.linkedAccounts?.[String(installationId)] || null;
    const vault = String(account?.storageChatId || account?.telegramUserId || "").trim();
    if (vault) return vault;
  } catch {}
  // D6 guarantees installation->tenant ownership before this middleware runs.
  // A stable tenant-vault namespace is safer than accepting a client vault id.
  return `tenant-vault:${String(tenantId)}`;
}

function createMemoryStore({ now = () => Date.now(), maxActivePerTenant = DEFAULT_TENANT_ACTIVE_CAP } = {}) {
  const records = new Map();

  function expire() {
    const current = now();
    for (const record of records.values()) {
      if (record.status === "ACTIVE" && record.expires_at_ms < current) record.status = "EXPIRED";
    }
  }

  return {
    async issue(record) {
      expire();
      const active = [...records.values()].filter(item => item.status === "ACTIVE" && item.tenant_id === record.tenant_id).length;
      if (active >= maxActivePerTenant) {
        const error = new Error("DIRECT_TENANT_CAP_REACHED: too many active Direct operations for this tenant.");
        error.status = 429;
        error.code = "DIRECT_TENANT_CAP_REACHED";
        throw error;
      }
      records.set(record.capability_hash, { ...record, status: "ACTIVE" });
      return { ...records.get(record.capability_hash) };
    },
    async consume({ capabilityHash, userId, tenantId, installationId, sessionId, generation, clockSkewMs }) {
      expire();
      const record = records.get(capabilityHash);
      if (!record) return { ok: false, reason: "unknown" };
      const same = record.user_id === userId && record.tenant_id === tenantId && record.installation_id === installationId &&
        record.session_id === sessionId && Number(record.generation) === Number(generation);
      if (!same) return { ok: false, reason: "scope", record: { ...record } };
      if (record.status !== "ACTIVE") return { ok: false, reason: record.status.toLowerCase(), record: { ...record } };
      if (record.expires_at_ms + clockSkewMs < now()) {
        record.status = "EXPIRED";
        return { ok: false, reason: "expired", record: { ...record } };
      }
      record.status = "CONSUMED";
      record.consumed_at_ms = now();
      return { ok: true, record: { ...record } };
    },
    async revokeSession({ installationId, sessionId, reason }) {
      let count = 0;
      for (const record of records.values()) {
        if (record.status === "ACTIVE" && record.installation_id === installationId && record.session_id === sessionId) {
          record.status = "REVOKED"; record.revoke_reason = reason; record.revoked_at_ms = now(); count += 1;
        }
      }
      return count;
    },
    async revokeAuthSession({ authSessionHash, installationId = null, reason }) {
      let count = 0;
      for (const record of records.values()) {
        if (record.status !== "ACTIVE") continue;
        if (record.auth_session_hash !== authSessionHash) continue;
        if (installationId && record.installation_id !== installationId) continue;
        record.status = "REVOKED"; record.revoke_reason = reason; record.revoked_at_ms = now(); count += 1;
      }
      return count;
    },
    async revokeTenant({ tenantId, reason }) {
      let count = 0;
      for (const record of records.values()) {
        if (record.status === "ACTIVE" && record.tenant_id === tenantId) {
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
  return {
    async issue(record) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`direct-capability-tenant:${record.tenant_id}`]);
        await client.query("UPDATE direct_capabilities SET status='EXPIRED' WHERE tenant_id=$1 AND status='ACTIVE' AND expires_at < now()", [record.tenant_id]);
        const active = Number((await client.query("SELECT count(*)::int AS n FROM direct_capabilities WHERE tenant_id=$1 AND status='ACTIVE' AND expires_at >= now()", [record.tenant_id])).rows[0]?.n || 0);
        if (active >= maxActivePerTenant) {
          const error = new Error("DIRECT_TENANT_CAP_REACHED: too many active Direct operations for this tenant.");
          error.status = 429; error.code = "DIRECT_TENANT_CAP_REACHED"; throw error;
        }
        await client.query(`INSERT INTO direct_capabilities(
          capability_hash,internal_operation_id,user_id,tenant_id,installation_id,auth_session_hash,
          session_id,generation,vault_scope,operation_type,object_scope,status,issued_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'ACTIVE',to_timestamp($12 / 1000.0),to_timestamp($13 / 1000.0))`, [
          record.capability_hash, record.internal_operation_id, record.user_id, record.tenant_id,
          record.installation_id, record.auth_session_hash, record.session_id, record.generation,
          record.vault_scope, record.operation_type, JSON.stringify(record.object_scope), record.issued_at_ms, record.expires_at_ms,
        ]);
        await client.query("COMMIT");
        return record;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally { client.release(); }
    },
    async consume({ capabilityHash, userId, tenantId, installationId, sessionId, generation, clockSkewMs }) {
      const updated = await pool.query(`UPDATE direct_capabilities SET status='CONSUMED', consumed_at=now()
        WHERE capability_hash=$1 AND user_id=$2 AND tenant_id=$3 AND installation_id=$4 AND session_id=$5
          AND generation=$6 AND status='ACTIVE' AND expires_at >= now() - ($7::bigint * interval '1 millisecond')
        RETURNING internal_operation_id,user_id,tenant_id,installation_id,session_id,generation,vault_scope,operation_type,object_scope,status`,
      [capabilityHash,userId,tenantId,installationId,sessionId,generation,clockSkewMs]);
      if (updated.rows.length === 1) return { ok: true, record: updated.rows[0] };
      const found = (await pool.query("SELECT internal_operation_id,user_id,tenant_id,installation_id,session_id,generation,status,expires_at FROM direct_capabilities WHERE capability_hash=$1", [capabilityHash])).rows[0];
      if (!found) return { ok: false, reason: "unknown" };
      const same = String(found.user_id) === userId && String(found.tenant_id) === tenantId && String(found.installation_id) === installationId && String(found.session_id) === sessionId && Number(found.generation) === Number(generation);
      return { ok: false, reason: same ? String(found.status || "denied").toLowerCase() : "scope", record: found };
    },
    async revokeSession({ installationId, sessionId, reason }) {
      const result = await pool.query("UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$3 WHERE installation_id=$1 AND session_id=$2 AND status='ACTIVE'", [installationId,sessionId,reason]);
      return result.rowCount || 0;
    },
    async revokeAuthSession({ authSessionHash, installationId = null, reason }) {
      const result = installationId
        ? await pool.query("UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$3 WHERE auth_session_hash=$1 AND installation_id=$2 AND status='ACTIVE'", [authSessionHash,installationId,reason])
        : await pool.query("UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$2 WHERE auth_session_hash=$1 AND status='ACTIVE'", [authSessionHash,reason]);
      return result.rowCount || 0;
    },
    async revokeTenant({ tenantId, reason }) {
      const result = await pool.query("UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$2 WHERE tenant_id=$1 AND status='ACTIVE'", [tenantId,reason]);
      return result.rowCount || 0;
    },
  };
}

function installDirectCapabilityBoundary(express, options = {}) {
  if (express.application.__beatgalerDirectCapabilitiesInstalled) return;
  express.application.__beatgalerDirectCapabilitiesInstalled = true;
  const env = options.env || process.env;
  const dataDir = options.dataDir || __dirname;
  const now = options.now || (() => Date.now());
  const ttlMs = Math.max(30_000, Math.min(30 * 60 * 1000, Number(env.BEATGALER_DIRECT_CAPABILITY_TTL_MS || DEFAULT_CAPABILITY_TTL_MS)));
  const clockSkewMs = Math.max(0, Math.min(30_000, Number(env.BEATGALER_DIRECT_CAPABILITY_CLOCK_SKEW_MS || DEFAULT_CLOCK_SKEW_MS)));
  const maxActivePerTenant = Math.max(1, Math.min(16, Number(env.BEATGALER_DIRECT_TENANT_ACTIVE_CAP || DEFAULT_TENANT_ACTIVE_CAP)));
  const store = options.store || (options.pool ? createPostgresStore(options.pool, { maxActivePerTenant }) : createMemoryStore({ now, maxActivePerTenant }));
  const originalPost = express.application.post;

  function identity(req) {
    const userId = String(req.beatgalerAuthorizedUserId || "").trim();
    const tenantId = String(req.beatgalerAuthorizedTenantId || "").trim();
    const installationId = String(req.beatgalerAuthorizedInstallationId || req.body?.beatgalerUserId || "").trim();
    const token = bearerToken(req);
    if (!userId || !tenantId || !installationId || !token) {
      const error = new Error("DIRECT_CAPABILITY_AUTHZ_REQUIRED: session-bound authorization must run first.");
      error.status = 403; error.code = "DIRECT_CAPABILITY_AUTHZ_REQUIRED"; throw error;
    }
    return { userId, tenantId, installationId, authSessionHash: sha256(token) };
  }

  function sendError(res, error) {
    const status = Number(error?.status || 500);
    return res.status(status).json({ error: String(error?.message || "Direct capability boundary failed."), code: error?.code || "DIRECT_CAPABILITY_ERROR" });
  }

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
    let claims;
    let scope;
    let kind;
    try {
      claims = identity(req);
      kind = normalizeOperationKind(req.body?.kind);
      scope = normalizeScope(kind, req.body?.scope);
    } catch (error) { return sendError(res, error); }

    const originalJson = res.json.bind(res);
    res.json = payload => {
      if (!(Number(res.statusCode || 200) < 300 && payload?.ok === true && payload?.operation_id)) return originalJson(payload);
      const internalOperationId = String(payload.operation_id);
      const token = capabilityToken();
      const issuedAt = now();
      const expiresAt = issuedAt + ttlMs;
      const record = {
        capability_hash: sha256(token),
        internal_operation_id: internalOperationId,
        user_id: claims.userId,
        tenant_id: claims.tenantId,
        installation_id: claims.installationId,
        auth_session_hash: claims.authSessionHash,
        session_id: String(req.body?.sessionId || ""),
        generation: Number(req.body?.generation || 0),
        vault_scope: readVaultScope(dataDir, claims.installationId, claims.tenantId),
        operation_type: kind,
        object_scope: scope,
        issued_at_ms: issuedAt,
        expires_at_ms: expiresAt,
      };
      void store.issue(record).then(() => originalJson({
        ...payload,
        operation_id: token,
        capability: {
          token,
          user_id: claims.userId,
          tenant_id: claims.tenantId,
          installation_id: claims.installationId,
          vault_scope: record.vault_scope,
          operation: kind,
          object_scope: scope,
          issued_at: new Date(issuedAt).toISOString(),
          expires_at: new Date(expiresAt).toISOString(),
        },
      })).catch(async error => {
        await cleanupInternalOperation(req, internalOperationId);
        sendError(res, error);
      });
      return res;
    };
    next();
  }

  async function consumeCapability(req, res, next) {
    let claims;
    try { claims = identity(req); }
    catch (error) { return sendError(res, error); }
    const presented = String(req.body?.operationId || "").trim();
    if (!presented.startsWith("cap_") || presented.length < 40) return res.status(403).json({ error: "DIRECT_CAPABILITY_REQUIRED: operation capability is missing.", code: "DIRECT_CAPABILITY_REQUIRED" });
    try {
      const consumed = await store.consume({
        capabilityHash: sha256(presented), userId: claims.userId, tenantId: claims.tenantId,
        installationId: claims.installationId, sessionId: String(req.body?.sessionId || ""),
        generation: Number(req.body?.generation || 0), clockSkewMs,
      });
      if (!consumed.ok) {
        if (consumed.record?.internal_operation_id && (consumed.reason === "expired" || consumed.reason === "expired".toUpperCase())) await cleanupInternalOperation(req, consumed.record.internal_operation_id);
        const code = consumed.reason === "scope" ? "DIRECT_CAPABILITY_SCOPE_DENIED" : "DIRECT_CAPABILITY_REPLAY_OR_EXPIRED";
        return res.status(403).json({ error: `${code}: capability is not active for this session/object.`, code });
      }
      req.body.operationId = String(consumed.record.internal_operation_id);
      next();
    } catch (error) { sendError(res, error); }
  }

  async function revokeSession(req, res, next) {
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

  express.application.post = function patchedDirectCapabilityPost(routePath, ...handlers) {
    if (routePath === "/transport/operation/begin") return originalPost.call(this, routePath, beginCapability, ...handlers);
    if (routePath === "/transport/operation/end") return originalPost.call(this, routePath, consumeCapability, ...handlers);
    if (routePath === "/transport/session/stop") return originalPost.call(this, routePath, revokeSession, ...handlers);
    if (routePath === "/auth/logout") return originalPost.call(this, routePath, revokeAuthOnSuccess("logout"), ...handlers);
    if (routePath === "/auth/password/change") return originalPost.call(this, routePath, revokeAuthOnSuccess("password_change"), ...handlers);
    if (routePath === "/auth/account/delete") return originalPost.call(this, routePath, revokeAuthOnSuccess("account_delete"), ...handlers);
    return originalPost.call(this, routePath, ...handlers);
  };

  return { store, constants: { ttlMs, clockSkewMs, maxActivePerTenant } };
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
  installDirectCapabilityBoundary,
};
