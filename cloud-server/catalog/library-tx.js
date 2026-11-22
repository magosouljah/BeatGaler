'use strict';

const { requireUserId } = require('./contract');
const { CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');

const STATEMENT_TIMEOUT_MS = 1000;
const API_TIMEOUT_MS = 2000;
const QUARANTINE_SQL = 'SELECT 1 FROM control_plane_flush_quarantine WHERE user_id = $1 AND resolved_at IS NULL LIMIT 1';
const LIB_SQL = `SELECT l.user_id, l.vault_id, l.authority, l.migration_state, l.authority_era::text AS authority_era, l.authority_epoch::text AS authority_epoch,
  l.revision::text AS revision, l.active_generation_id, l.active_count::text AS active_count, l.trash_count::text AS trash_count,
  l.purging_count::text AS purging_count, l.pending_count::text AS pending_count, l.restore_hold, l.cleanup_enabled
  FROM catalog_libraries l WHERE l.user_id = $1`;
const NO_LIBRARY = Symbol('no native library');

const mutation = { availability: true, quarantine: true, lock: true, rejectFrozen: true, onError: 'commitFlag' };
const snapshot = { availability: true, begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', onError: 'commitFinally' };
const nativeRules = new Set(['BGL01', 'BGN04', 'BGA05', 'BGC02']);

// Perfiles de transacción por variante. Los adaptadores de medios y MAIN
// conservan sus consultas de dominio dentro del callback de la transacción.
const VARIANTS = {
  commands: { mutate: { ...mutation, checkPool: true }, read: snapshot },
  operations: { mutate: mutation, read: snapshot },
  purge: { mutate: mutation, continuePurge: { ...mutation, rejectFrozen: false }, read: snapshot },
  direct: { mutate: mutation, unavailable: 'sqlstate' },
  playback: { mutate: { ...mutation, rejectFrozen: false }, read: snapshot },
  prefixPacks: { mutate: { ...mutation, timeoutMs: 5000 }, read: { timeoutMs: 5000, quarantine: true, onError: 'commitFlag' }, unavailable: 'sqlstate' },
  media: { read: { ...snapshot, quarantine: true } },
  queries: {
    read: { ...snapshot, checkPool: true, quarantine: true, queryContext: true, deadlineMs: API_TIMEOUT_MS },
    deriveWrite: { availability: true, quarantine: true, queryContext: true, onError: 'rollback' },
  },
};

class PurgeStepError extends Error {
  constructor(code, message, { transient = true, retryAfterMs = 0, reason = null } = {}) { super(message); this.name = 'PurgeStepError'; this.code = code; this.transient = transient; this.retryAfterMs = retryAfterMs; this.reason = reason; }
}

const unavailable = (reason, extra = {}) => new CatalogQueryError('CATALOG_UNAVAILABLE', 503, `catalog is unavailable (${reason})`, { reason, ...extra });

function sqlError(variant, error) {
  if (error instanceof CatalogAuthorityError || (variant === 'purge' && error instanceof PurgeStepError)) return error;
  const sqlstate = error?.code || null;
  if (typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) {
    console.error('[catalog/library-tx] PostgreSQL', { variant, sqlstate, message: error.message, detail: error.detail });
  }
  if (sqlstate === '57014') {
    const message = variant === 'queries' ? 'catalog query timed out' : 'catalog statement timed out';
    return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, message, { sqlstate: '57014' });
  }
  if (nativeRules.has(sqlstate)) {
    return new CatalogQueryError('CATALOG_NATIVE_RULE', 409, 'database native rule rejected the mutation', { sqlstate });
  }
  if (VARIANTS[variant].unavailable === 'sqlstate') return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog database is unavailable', { sqlstate });
  return unavailable('SQL_ERROR', { sqlstate });
}

function decide(variant, { intent }) {
  const profile = VARIANTS[variant]?.[intent];
  if (!profile) throw new TypeError(`unsupported library transaction: ${variant}.${intent}`);
  return {
    begin: profile.begin ?? 'BEGIN',
    timeoutMs: profile.timeoutMs ?? STATEMENT_TIMEOUT_MS,
    deadlineMs: profile.deadlineMs ?? null,
    availability: profile.availability === true,
    checkPool: profile.checkPool === true,
    quarantine: profile.quarantine === true,
    lock: profile.lock === true,
    queryContext: profile.queryContext === true,
    onError: profile.onError,
    errorMap: (error) => sqlError(variant, error),
    frozenError: (ctx) => profile.rejectFrozen && ctx.migration_state !== 'IDLE'
      ? new CatalogQueryError('LIBRARY_FROZEN', 409, 'library is not accepting mutations', { migration_state: ctx.migration_state })
      : null,
  };
}

function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog request exceeded the total time budget', { budget_ms: ms })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createLibraryTx({ pool, authority, variant }) {
  async function run(userId, intent, headers, fn) {
    const uid = requireUserId(userId);
    const policy = decide(variant, { intent });
    if (policy.availability) await authority.availability();
    if (policy.checkPool && (!pool || typeof pool.connect !== 'function')) throw unavailable('POSTGRES_UNAVAILABLE');
    const client = await pool.connect();

    async function work() {
      await client.query(policy.begin);
      try {
        await client.query(`SET LOCAL statement_timeout = ${policy.timeoutMs}`);
        if (policy.quarantine) {
          const q = await client.query(QUARANTINE_SQL, [uid]);
          if (q.rows.length) throw new CatalogAuthorityError('VAULT_QUARANTINED', 409, 'vault is quarantined by the control-plane flush', {});
        }
        let ctx;
        if (policy.lock) {
          ctx = await authority.requireLibraryForMutation(client, { userId: uid, ...headers });
          const frozenError = policy.frozenError(ctx);
          if (frozenError) throw frozenError;
        }
        if (policy.queryContext) {
          ctx = (await client.query(LIB_SQL, [uid])).rows[0] || null;
          if (!ctx || ctx.authority !== 'POSTGRES' || !ctx.active_generation_id) {
            if (intent === 'read') return NO_LIBRARY;
            await client.query('ROLLBACK');
            await authority.resolveContext({ userId: uid });
            throw unavailable('CONTEXT_RACE');
          }
        }
        const out = await fn({ client, ctx, uid });
        if (policy.onError !== 'commitFinally') await client.query('COMMIT');
        return out;
      } catch (error) {
        if (policy.onError === 'commitFlag' && error && error.commit === true) await client.query('COMMIT').catch(() => {});
        else if (policy.onError !== 'commitFinally') await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        if (policy.onError === 'commitFinally') await client.query('COMMIT').catch(() => {});
      }
    }

    let result;
    try {
      const pending = work();
      // La lectura de queries conserva el plazo y la liberación heredados.
      result = await (policy.deadlineMs ? withDeadline(pending, policy.deadlineMs) : pending);
    } catch (error) {
      throw policy.errorMap(error);
    } finally {
      client.release();
    }
    if (result === NO_LIBRARY) {
      await authority.resolveContext({ userId: uid });
      throw unavailable('CONTEXT_RACE');
    }
    return result;
  }

  async function mutationTx(intent, userId, { era, epoch }, fn) {
    return run(userId, intent, { era, epoch }, fn);
  }

  function readTx(userId, fn) {
    return run(userId, 'read', null, fn);
  }

  return Object.freeze({
    mutate: (userId, headers, fn) => mutationTx('mutate', userId, headers, fn),
    ...(variant === 'purge' && { continuePurge: (userId, headers, fn) => mutationTx('continuePurge', userId, headers, fn) }),
    read: readTx,
    deriveWrite: (userId, fn) => run(userId, 'deriveWrite', null, fn),
    translateError: (error) => sqlError(variant, error),
  });
}

module.exports = { createLibraryTx, decide, PurgeStepError, STATEMENT_TIMEOUT_MS, API_TIMEOUT_MS };
