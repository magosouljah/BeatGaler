"use strict";

const { sha256StringForDirect: sha256, bearerTokenRequiredRequest: bearerToken } = require("./auth-helpers");

const DEFAULT_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TENANT_ACTIVE_CAP = 4;
const LIVE_STATUSES = new Set(["ACTIVE", "AUTHORIZED"]);
let installedRuntime = null;

function codedError(code, message, status = 403) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.status = status;
  return error;
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

function identityMatches(record, input) {
  return record.user_id === input.userId && record.tenant_id === input.tenantId &&
    record.installation_id === input.installationId && record.auth_session_hash === input.authSessionHash &&
    record.session_id === input.sessionId && Number(record.generation) === Number(input.generation);
}

function renewalLeaseMs(input) {
  return Math.max(
    30_000,
    Math.min(30 * 60 * 1000, Number(input?.renewalLeaseMs || DEFAULT_CAPABILITY_TTL_MS)),
  );
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
    async renew(input) {
      const record = records.get(input.capabilityHash);
      if (!record) return { ok: false, reason: "unknown" };
      if (!identityMatches(record, input)) return { ok: false, reason: "scope", record: { ...record } };
      if (record.status !== "AUTHORIZED") return { ok: false, reason: record.status.toLowerCase(), record: { ...record } };
      if (record.expires_at_ms + input.clockSkewMs < now()) {
        record.status = "EXPIRED";
        return { ok: false, reason: "expired", record: { ...record } };
      }
      record.expires_at_ms = Math.max(record.expires_at_ms, now() + renewalLeaseMs(input));
      record.renewed_at_ms = now();
      return { ok: true, record: { ...record } };
    },
    async finish(input) {
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
    async revokeMissingOperations({ tenantId, installationId, sessionId, liveOperationIds, reason }) {
      const live = new Set((liveOperationIds || []).map(value => String(value)));
      let count = 0;
      for (const record of records.values()) {
        if (!LIVE_STATUSES.has(record.status)) continue;
        if (record.tenant_id !== tenantId || record.installation_id !== installationId || record.session_id !== sessionId) continue;
        if (live.has(String(record.internal_operation_id))) continue;
        record.status = "REVOKED";
        record.revoke_reason = reason;
        record.revoked_at_ms = now();
        count += 1;
      }
      return count;
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
    async renew(input) {
      const updated = await pool.query(`UPDATE direct_capabilities SET
          expires_at=GREATEST(expires_at, now() + ($8::bigint * interval '1 millisecond'))
        WHERE capability_hash=$1 AND user_id=$2 AND tenant_id=$3 AND installation_id=$4 AND auth_session_hash=$5
          AND session_id=$6 AND generation=$7 AND status='AUTHORIZED'
          AND expires_at >= now() - ($9::bigint * interval '1 millisecond')
        RETURNING internal_operation_id,user_id,tenant_id,installation_id,auth_session_hash,session_id,generation,vault_scope,operation_type,object_scope,status,expires_at`, [
        input.capabilityHash,input.userId,input.tenantId,input.installationId,input.authSessionHash,input.sessionId,
        input.generation,renewalLeaseMs(input),input.clockSkewMs,
      ]);
      if (updated.rows.length === 1) return { ok: true, record: updated.rows[0] };
      const expired = await pool.query(`UPDATE direct_capabilities SET status='EXPIRED'
        WHERE capability_hash=$1 AND user_id=$2 AND tenant_id=$3 AND installation_id=$4 AND auth_session_hash=$5
          AND session_id=$6 AND generation=$7 AND status='AUTHORIZED'
          AND expires_at < now() - ($8::bigint * interval '1 millisecond')
        RETURNING internal_operation_id,user_id,tenant_id,installation_id,auth_session_hash,session_id,generation,vault_scope,operation_type,object_scope,status,expires_at`, [
        input.capabilityHash,input.userId,input.tenantId,input.installationId,input.authSessionHash,input.sessionId,
        input.generation,input.clockSkewMs,
      ]);
      if (expired.rows.length === 1) return { ok: false, reason: "expired", record: expired.rows[0] };
      const record = await find(input.capabilityHash);
      if (!record) return { ok: false, reason: "unknown" };
      const sameIdentity = String(record.user_id) === input.userId && String(record.tenant_id) === input.tenantId &&
        String(record.installation_id) === input.installationId && String(record.auth_session_hash) === input.authSessionHash &&
        String(record.session_id) === input.sessionId && Number(record.generation) === Number(input.generation);
      return { ok: false, reason: sameIdentity ? String(record.status || "denied").toLowerCase() : "scope", record };
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
    async revokeMissingOperations({ tenantId, installationId, sessionId, liveOperationIds, reason }) {
      const result = await pool.query(
        "UPDATE direct_capabilities SET status='REVOKED', revoked_at=now(), revoke_reason=$5 WHERE tenant_id=$1 AND installation_id=$2 AND session_id=$3 AND status IN ('ACTIVE','AUTHORIZED') AND NOT (internal_operation_id = ANY($4::text[]))",
        [tenantId, installationId, sessionId, liveOperationIds, reason],
      );
      return result.rowCount || 0;
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

async function revokeTenantCapabilities(tenantId, reason = "incident") {
  if (!installedRuntime?.store) throw codedError("DIRECT_CAPABILITY_UNAVAILABLE", "capability store is unavailable.", 503);
  return installedRuntime.store.revokeTenant({ tenantId: String(tenantId), reason: String(reason || "incident") });
}

function installDirectCapabilityBoundary(express, options = {}) {
  if (express.application.__beatgalerDirectCapabilitiesInstalled) return installedRuntime;
  express.application.__beatgalerDirectCapabilitiesInstalled = true;
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const maxActivePerTenant = Math.max(1, Math.min(16, Number(env.BEATGALER_DIRECT_TENANT_ACTIVE_CAP || DEFAULT_TENANT_ACTIVE_CAP)));
  const store = options.store || (options.pool ? createPostgresStore(options.pool, { maxActivePerTenant }) : createMemoryStore({ now, maxActivePerTenant }));
  installedRuntime = { store };

  function revokeAuthOnSuccess(reason) {
    return function revokeAuthOnSuccessResponse(req, res, next) {
      const token = bearerToken(req);
      const authSessionHash = token ? sha256(token) : "";
      const originalJson = res.json.bind(res);
      res.json = payload => {
        const status = Number(res.statusCode || 200);
        if (status < 200 || status >= 300) return originalJson(payload);
        if (!authSessionHash) {
          res.status(503);
          return originalJson({
            error: "DIRECT_CAPABILITY_REVOKE_FAILED: authenticated session revocation target is unavailable.",
            code: "DIRECT_CAPABILITY_REVOKE_FAILED",
          });
        }
        void store.revokeAuthSession({ authSessionHash, reason }).then(() => originalJson(payload)).catch(() => {
          res.status(503);
          originalJson({
            error: "DIRECT_CAPABILITY_REVOKE_FAILED: session capability revocation could not be committed.",
            code: "DIRECT_CAPABILITY_REVOKE_FAILED",
          });
        });
        return res;
      };
      next();
    };
  }

  express.application.__beatgalerDirectCapabilityHandlers = { revokeAuthOnSuccess };
  return installedRuntime;
}

function wrapDirectCapabilityPost(routePath, handlers) {
  const { app, next } = this;
  const boundary = app.__beatgalerDirectCapabilityHandlers;
  if (!boundary) return next(routePath, ...handlers);
  if (routePath === "/auth/logout") return next(routePath, boundary.revokeAuthOnSuccess("logout"), ...handlers);
  if (routePath === "/auth/password/change") return next(routePath, boundary.revokeAuthOnSuccess("password_change"), ...handlers);
  if (routePath === "/auth/account/delete") return next(routePath, boundary.revokeAuthOnSuccess("account_delete"), ...handlers);
  return next(routePath, ...handlers);
}

module.exports = {
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_TENANT_ACTIVE_CAP,
  createMemoryStore,
  createPostgresStore,
  revokeTenantCapabilities,
  installDirectCapabilityBoundary,
  wrapDirectCapabilityPost,
};
