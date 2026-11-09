'use strict';
// T05-N — Autoridad nativa PostgreSQL (NATIVO-POSTGRES-20261108 r2.1 §2, §3, §8.5, §12).
//  - resolveContext(): SOLO lectura (transacción READ ONLY). Nunca crea una biblioteca por inferencia (C1.3).
//  - provisionLibrary(): POST idempotente por user_id, una transacción corta, sin red, lock del vault (FOR UPDATE) y
//    predicado nativo íntegro en SQL. Si no se cumple: ROLLBACK, 409 LIBRARY_RESET_REQUIRED y 0 escrituras.
//  - Faltan flag, activación, PG o authority postgres: 503 CATALOG_UNAVAILABLE. Un error SQL nunca implica catálogo vacío.
//  - Guardas §12 del control-plane JSON y rechazo en origen de rebind (§6.2.1).
// No importa INDEX ni consulta Telegram. No contiene ninguna ruta de borrado de cuenta (§6.1 deshabilitado).

const crypto = require('crypto');
const { requireUserId } = require('./contract');

const NATIVE_FLAG_ENV = 'BEATGALER_CATALOG_NATIVE_ENABLED';
const ACCOUNT_DELETION_FLAG_ENV = 'BEATGALER_ACCOUNT_DELETION_ENABLED';
const CATALOG_SESSION_PROTOCOL = 'catalog-v1';
const INDEX_OPERATION_TYPES = Object.freeze(['get_index', 'replace_index', 'delete_messages']);
// §8.5: ningún cliente nativo recibe credenciales de Telegram.
const DIRECT_CREDENTIAL_KEYS = Object.freeze(['bot_token', 'telegram_api_id', 'telegram_api_hash', 'api_id', 'api_hash']);
const SQLSTATE = Object.freeze({
  LEGACY_WRITE_FORBIDDEN: 'BGL01', CASCADE_FORBIDDEN: 'BGC02', VAULT_REBIND_FORBIDDEN: 'BGR03', NATIVE_RULE: 'BGN04', AUTHORITY_FORBIDDEN: 'BGA05',
});

class CatalogAuthorityError extends Error {
  constructor(code, status, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'CatalogAuthorityError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}
const unavailable = (reason, extra = {}) => new CatalogAuthorityError('CATALOG_UNAVAILABLE', 503, `catalog is unavailable (${reason})`, { reason, ...extra });
const resetRequired = (reasons) => new CatalogAuthorityError('LIBRARY_RESET_REQUIRED', 409, 'vault is not eligible for a native library', { reasons });

function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
// Descriptor canónico de una generación nativa vacía (§3.4.2): su SHA-256 es el source_hash.
function nativeGenerationDescriptor({ era, chatId, vaultId }) {
  return { schema: 'beatgaler.catalog.generation', version: 1, origin: 'NATIVE', authority_era: String(era), vault_id: String(vaultId), chat_id: String(chatId), beats: 0 };
}

function catalogNativeConfig(env = process.env) {
  const nativeEnabled = String(env[NATIVE_FLAG_ENV] || '').trim().toLowerCase() === 'true';
  const deletionRaw = String(env[ACCOUNT_DELETION_FLAG_ENV] || '').trim().toLowerCase();
  if (deletionRaw === 'true' || deletionRaw === '1') {
    // §6.1: no existe tarea que lo habilite (implementación T15, habilitación T24, cada una con autorización propia).
    throw new Error(`${ACCOUNT_DELETION_FLAG_ENV} cannot be enabled: controlled account deletion is not implemented (NATIVO r2.1 §6.1).`);
  }
  return Object.freeze({ nativeEnabled, accountDeletionEnabled: false });
}

function parseTransportBotIds(text) {
  let parsed;
  try { parsed = JSON.parse(String(text)); } catch { throw unavailable('ACTIVATION_INVALID', { field: 'transport_bot_ids' }); }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string' || !id.trim())) throw unavailable('ACTIVATION_INVALID', { field: 'transport_bot_ids' });
  return parsed.map((id) => id.trim());
}

// Devuelve una copia sin credenciales de Telegram (§8.5, probado sobre el JSON serializado).
function stripDirectCredentials(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
  const out = {};
  for (const [key, value] of Object.entries(session)) {
    if (DIRECT_CREDENTIAL_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
function containsDirectCredentials(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return DIRECT_CREDENTIAL_KEYS.some((key) => new RegExp(`"${key}"\\s*:`).test(text));
}

// Lista exacta de rastros legacy del predicado nativo (§3.4.4). Origen: consumer-map §"Existentes" y migraciones:
//  vault_index_pointers (0014:7), library_quota_state (0015:5), library_beat_reservations (0015:11), library_beats (0015:27),
//  library_project_uploads (0017:5), library_legacy_project_copies (0017:17), library_trash_purges (0018:5),
//  pin authority: vaults.index_pin_restricted_bot_id/index_pin_restricted_at (0016:6-7) y project_media_restricted_bot_id (0017:3),
//  garbage_journal (0001:163), index_observations (0001:155), direct_operations no terminales (0001:139) y
//  direct_capabilities de tipo INDEX (0005:3; tipos en direct-capability-boundary.js:21-23).
const VAULT_PREDICATE_SQL = (forUpdate) => `
  SELECT v.id, v.user_id, v.telegram_chat_id, v.catalog_native_eligible, v.index_bootstrap_pending, v.transport_bot_id,
    EXISTS (SELECT 1 FROM catalog_library_chats c WHERE c.provider = 'telegram' AND c.chat_id = v.telegram_chat_id) AS chat_known,
    EXISTS (SELECT 1 FROM vault_index_pointers p WHERE p.vault_id = v.id) AS t_vault_index_pointers,
    EXISTS (SELECT 1 FROM library_quota_state q WHERE q.user_id = v.user_id) AS t_library_quota_state,
    EXISTS (SELECT 1 FROM library_beats b WHERE b.user_id = v.user_id) AS t_library_beats,
    EXISTS (SELECT 1 FROM library_trash_purges t WHERE t.user_id = v.user_id) AS t_library_trash_purges,
    EXISTS (SELECT 1 FROM library_beat_reservations r WHERE r.user_id = v.user_id) AS t_library_beat_reservations,
    EXISTS (SELECT 1 FROM library_project_uploads u WHERE u.user_id = v.user_id) AS t_library_project_uploads,
    EXISTS (SELECT 1 FROM library_legacy_project_copies lc WHERE lc.user_id = v.user_id) AS t_library_legacy_project_copies,
    (v.index_pin_restricted_bot_id IS NOT NULL OR v.index_pin_restricted_at IS NOT NULL OR v.project_media_restricted_bot_id IS NOT NULL) AS t_pin_authority,
    EXISTS (SELECT 1 FROM garbage_journal g WHERE g.vault_id = v.id) AS t_garbage_journal,
    EXISTS (SELECT 1 FROM index_observations o WHERE o.vault_id = v.id) AS t_index_observations,
    EXISTS (SELECT 1 FROM direct_operations d WHERE d.vault_id = v.id AND d.state NOT IN ('COMMITTED', 'FAILED')) AS t_direct_operations_live,
    EXISTS (SELECT 1 FROM direct_capabilities dc WHERE dc.user_id = v.user_id AND dc.operation_type = ANY($2::text[])) AS t_direct_capabilities_index
  FROM vaults v WHERE v.user_id = $1${forUpdate ? ' FOR UPDATE OF v' : ''}`;

const LIBRARY_SQL = (forUpdate) => `
  SELECT l.user_id, l.vault_id, l.authority, l.migration_state, l.authority_era, l.authority_epoch::text AS authority_epoch,
    l.revision::text AS revision, l.active_generation_id, l.active_count::text AS active_count, l.trash_count::text AS trash_count,
    l.purging_count::text AS purging_count, l.pending_count::text AS pending_count, l.cleanup_enabled, l.restore_hold, l.created_at,
    g.origin AS generation_origin, g.status AS generation_status,
    (SELECT c.chat_id FROM catalog_library_chats c WHERE c.user_id = l.user_id AND c.state = 'CURRENT') AS current_chat_id
  FROM catalog_libraries l
  LEFT JOIN catalog_generations g ON g.user_id = l.user_id AND g.generation_id = l.active_generation_id
  WHERE l.user_id = $1${forUpdate ? ' FOR UPDATE OF l' : ''}`;

function evaluateNativePredicate(row, activation) {
  const reasons = [];
  if (!row) return { eligible: false, reasons: ['NO_VAULT'] };
  if (row.catalog_native_eligible !== true) reasons.push('NOT_MARKED_ELIGIBLE');
  if (row.index_bootstrap_pending !== true) reasons.push('BOOTSTRAP_NOT_PENDING');
  if (row.chat_known) reasons.push('CHAT_ALREADY_REGISTERED');
  for (const [key, value] of Object.entries(row)) if (key.startsWith('t_') && value === true) reasons.push(`LEGACY_TRACE:${key.slice(2)}`);
  if (row.transport_bot_id && activation && !activation.transportBotIds.includes(String(row.transport_bot_id))) reasons.push('TRANSPORT_BOT_NOT_ALLOWED');
  return { eligible: reasons.length === 0, reasons };
}

function contextOf(lib) {
  return Object.freeze({
    authority: 'POSTGRES',
    user_id: lib.user_id,
    vault_id: lib.vault_id,
    chat_id: lib.current_chat_id || null,
    authority_era: String(lib.authority_era),
    authority_epoch: String(lib.authority_epoch),
    revision: String(lib.revision),
    generation_id: lib.active_generation_id,
    generation_origin: lib.generation_origin,
    migration_state: lib.migration_state,
    counts: { active: Number(lib.active_count), trash: Number(lib.trash_count), purging: Number(lib.purging_count), pending: Number(lib.pending_count) },
    restore_hold: lib.restore_hold === true,
    cleanup_enabled: lib.cleanup_enabled === true,
  });
}

async function readActivation(client) {
  const r = await client.query('SELECT environment_id, run_id, transport_bot_ids, direct_token_exposure, activated_at FROM catalog_native_activation');
  if (r.rows.length !== 1) return null;
  const row = r.rows[0];
  return Object.freeze({ environmentId: row.environment_id, runId: row.run_id, transportBotIds: parseTransportBotIds(row.transport_bot_ids), directTokenExposure: row.direct_token_exposure, activatedAt: row.activated_at });
}
async function isQuarantined(client, userId) {
  const r = await client.query('SELECT 1 FROM control_plane_flush_quarantine WHERE user_id = $1 AND resolved_at IS NULL LIMIT 1', [userId]);
  return r.rows.length > 0;
}

function createCatalogAuthority({ pool = null, env = process.env, controlPlaneAuthority = null, randomUUID = () => crypto.randomUUID() } = {}) {
  const config = catalogNativeConfig(env);

  // §3.4.1 Precondiciones de disponibilidad. Cualquier fallo: 503 sin efectos. Nunca "catálogo vacío".
  async function availability(client = pool) {
    if (!config.nativeEnabled) throw unavailable('NATIVE_FLAG_DISABLED');
    if (controlPlaneAuthority !== 'postgres') throw unavailable('CONTROL_PLANE_NOT_POSTGRES', { authority: controlPlaneAuthority });
    if (!pool || typeof pool.connect !== 'function') throw unavailable('POSTGRES_UNAVAILABLE');
    let activation;
    try { activation = await readActivation(client); } catch (error) {
      if (error instanceof CatalogAuthorityError) throw error;
      throw unavailable('SQL_ERROR', { sqlstate: error?.code || null });
    }
    if (!activation) throw unavailable('NOT_ACTIVATED');
    return activation;
  }

  async function resolveContext({ userId } = {}) {
    const uid = requireUserId(userId);
    const activation = await availability();
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      try {
        // §6.2.3 Fail-closed por usuario: en cuarentena nadie usa un valor dudoso, con o sin biblioteca.
        if (await isQuarantined(client, uid)) throw new CatalogAuthorityError('VAULT_QUARANTINED', 409, 'vault is quarantined by the control-plane flush', {});
        const lib = (await client.query(LIBRARY_SQL(false), [uid])).rows[0] || null;
        if (lib) {
          if (lib.authority === 'POSTGRES') return contextOf(lib);
          throw resetRequired(['LIBRARY_LEGACY']);
        }
        const vault = (await client.query(VAULT_PREDICATE_SQL(false), [uid, INDEX_OPERATION_TYPES])).rows[0] || null;
        const verdict = evaluateNativePredicate(vault, activation);
        if (verdict.eligible) throw new CatalogAuthorityError('LIBRARY_NOT_PROVISIONED', 404, 'library is not provisioned yet', { provision: 'POST /catalog/v1/library/provision' });
        throw resetRequired(verdict.reasons);
      } finally {
        await client.query('COMMIT').catch(() => {});
      }
    } catch (error) {
      if (error instanceof CatalogAuthorityError) throw error;
      throw unavailable('SQL_ERROR', { sqlstate: error?.code || null });
    } finally { client.release(); }
  }

  // §3.4 Una transacción, sin red. Idempotente por PK user_id.
  async function provisionLibrary({ userId } = {}, { attempt = 0 } = {}) {
    const uid = requireUserId(userId);
    const activation = await availability();
    const client = await pool.connect();
    let retryAfterUniqueRace = false;
    try {
      await client.query('BEGIN');
      try {
        // 2. Mismo lock que la publicación legacy (library-index-publication.js:211): serializa provisiones y publicaciones.
        //    El predicado se evalúa en una sentencia POSTERIOR al lock: en READ COMMITTED, una consulta bloqueada en
        //    FOR UPDATE reevalúa solo la fila bloqueada (EvalPlanQual) y sus subconsultas EXISTS conservarían el snapshot
        //    anterior al COMMIT del rival; separar lock y predicado garantiza ver el ledger que ese rival dejó.
        await client.query('SELECT id FROM vaults WHERE user_id = $1 FOR UPDATE', [uid]);
        const vault = (await client.query(VAULT_PREDICATE_SQL(false), [uid, INDEX_OPERATION_TYPES])).rows[0] || null;
        if (await isQuarantined(client, uid)) throw new CatalogAuthorityError('VAULT_QUARANTINED', 409, 'vault is quarantined by the control-plane flush', {});
        // 3. Fila existente.
        const existing = (await client.query(LIBRARY_SQL(true), [uid])).rows[0] || null;
        if (existing) {
          if (existing.authority === 'POSTGRES') { await client.query('COMMIT'); return { created: false, context: contextOf(existing) }; }
          throw resetRequired(['LIBRARY_LEGACY']);
        }
        // 4. Predicado nativo íntegro en SQL.
        const verdict = evaluateNativePredicate(vault, activation);
        if (!verdict.eligible) throw resetRequired(verdict.reasons);
        // 5. Escrituras en orden §3.4.5 (la FK a la generación es DEFERRABLE INITIALLY DEFERRED).
        const generationId = `native-${randomUUID()}`;
        const lib = (await client.query(`INSERT INTO catalog_libraries(user_id, vault_id, authority, migration_state, authority_epoch, revision, active_generation_id,
            active_count, trash_count, purging_count, pending_count, cleanup_enabled, restore_hold)
          VALUES ($1, $2, 'POSTGRES', 'IDLE', 1, 1, $3, 0, 0, 0, 0, false, true) RETURNING authority_era`, [uid, vault.id, generationId])).rows[0];
        const descriptor = canonicalJson(nativeGenerationDescriptor({ era: lib.authority_era, chatId: vault.telegram_chat_id, vaultId: vault.id }));
        await client.query(`INSERT INTO catalog_generations(user_id, generation_id, snapshot_id, status, source_hash, raw_index, raw_index_sha256, descriptor_json, validated_at, origin)
          VALUES ($1, $2, $3, 'ACTIVE', $4, NULL, NULL, $5, now(), 'NATIVE')`, [uid, generationId, `native:${generationId.slice(7)}`, sha256Hex(descriptor), descriptor]);
        await client.query(`INSERT INTO catalog_library_chats(provider, chat_id, user_id, vault_id, state) VALUES ('telegram', $1, $2, $3, 'CURRENT')`, [vault.telegram_chat_id, uid, vault.id]);
        await client.query(`UPDATE direct_capabilities SET status = 'REVOKED', revoked_at = now(), revoke_reason = 'CATALOG_NATIVE'
          WHERE user_id = $1 AND status IN ('ACTIVE', 'AUTHORIZED')`, [uid]);
        await client.query('UPDATE vaults SET index_bootstrap_pending = false, updated_at = now() WHERE id = $1 AND user_id = $2', [vault.id, uid]);
        const created = (await client.query(LIBRARY_SQL(false), [uid])).rows[0];
        await client.query('COMMIT');
        return { created: true, context: contextOf(created) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error instanceof CatalogAuthorityError) throw error;
      // Respaldo de la PK/índice único si alguien se saltó el lock: releer una sola vez.
      if (error?.code === '23505' && attempt === 0) retryAfterUniqueRace = true;
      else throw unavailable('SQL_ERROR', { sqlstate: error?.code || null });
    } finally { client.release(); }
    return provisionLibrary({ userId: uid }, { attempt: 1 });
  }

  // Guard reutilizable para mutaciones (T07+): biblioteca POSTGRES bajo lock, era y época exigidas y revalidadas.
  async function requireLibraryForMutation(client, { userId, era, epoch } = {}) {
    const uid = requireUserId(userId);
    if (!era || !epoch) throw new CatalogAuthorityError('CATALOG_ERA_REQUIRED', 400, 'authority_era and authority_epoch are required');
    const lib = (await client.query(LIBRARY_SQL(true), [uid])).rows[0] || null;
    if (!lib || lib.authority !== 'POSTGRES') throw new CatalogAuthorityError('LIBRARY_RESET_REQUIRED', 409, 'no PostgreSQL library for this tenant', { reasons: [lib ? 'LIBRARY_LEGACY' : 'NO_LIBRARY'] });
    if (String(lib.authority_era) !== String(era)) throw new CatalogAuthorityError('CATALOG_ERA_MISMATCH', 409, 'authority era does not match', { current_era: String(lib.authority_era) });
    if (String(lib.authority_epoch) !== String(epoch)) throw new CatalogAuthorityError('CATALOG_EPOCH_STALE', 409, 'authority epoch is stale', { current_epoch: String(lib.authority_epoch) });
    return contextOf(lib);
  }

  // §6.2.1 Rechazo en origen: cambiar el chat de un vault con biblioteca POSTGRES exige un rebind OPEN hacia ese chat.
  async function assertVaultRebindAllowed({ userId, fromChatId = null, toChatId = null } = {}, client = pool) {
    const uid = requireUserId(userId);
    const lib = (await client.query("SELECT 1 FROM catalog_libraries WHERE user_id = $1 AND authority = 'POSTGRES'", [uid])).rows[0];
    if (!lib) return { native: false };
    const from = fromChatId == null ? null : String(fromChatId);
    const to = toChatId == null ? null : String(toChatId);
    const open = (await client.query(`SELECT 1 FROM catalog_chat_rebinds WHERE user_id = $1 AND state = 'OPEN'
      AND ($2::text IS NULL OR from_chat_id = $2) AND ($3::text IS NULL OR to_chat_id = $3)`, [uid, from, to])).rows[0];
    if (!open) throw new CatalogAuthorityError('CATALOG_VAULT_REBIND_FORBIDDEN', 409, 'vault chat of a native library can only change through rebind-chat', { user_id: uid });
    return { native: true, rebind: true };
  }

  return Object.freeze({ config, availability, resolveContext, provisionLibrary, requireLibraryForMutation, assertVaultRebindAllowed, evaluateNativePredicate });
}

// §12.2: control-plane JSON con pool y activación o bibliotecas → el arranque se niega (STOP-ENV).
async function assertNativeStartupCompatible({ pool, authority } = {}) {
  if (authority !== 'json' || !pool || typeof pool.query !== 'function') return { checked: false };
  const r = await pool.query('SELECT (SELECT count(*) FROM catalog_native_activation)::int AS activations, (SELECT count(*) FROM catalog_libraries)::int AS libraries');
  const row = r.rows[0] || { activations: 0, libraries: 0 };
  if (Number(row.activations) > 0 || Number(row.libraries) > 0) {
    const error = new Error(`CATALOG_NATIVE_STARTUP_REFUSED: control-plane authority json cannot start against a database with ${row.activations} native activation(s) and ${row.libraries} catalog librar(ies).`);
    error.code = 'CATALOG_NATIVE_STARTUP_REFUSED';
    throw error;
  }
  return { checked: true, activations: Number(row.activations), libraries: Number(row.libraries) };
}

// §12.3: el re-cutover JSON→PG se niega con activación (un snapshot viejo no puede reinsertar vaults como elegibles).
async function assertNoNativeActivation(pool, action = 'control-plane cutover') {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool is required.');
  const r = await pool.query('SELECT environment_id FROM catalog_native_activation');
  if (r.rows.length) {
    const error = new Error(`CATALOG_NATIVE_RECUTOVER_REFUSED: ${action} is refused: environment ${r.rows[0].environment_id} is natively activated.`);
    error.code = 'CATALOG_NATIVE_RECUTOVER_REFUSED';
    throw error;
  }
}

// Singleton para server-core (igual que library-index-publication.configure): sin configurar, los helpers de origen no actúan.
let configured = null;
function configureCatalogAuthority(options = null) {
  configured = options && options.pool ? createCatalogAuthority(options) : null;
  return configured;
}
function currentCatalogAuthority() { return configured; }
async function assertVaultRebindAllowedIfConfigured(input) {
  if (!configured) return { native: false, configured: false };
  return configured.assertVaultRebindAllowed(input);
}

module.exports = {
  NATIVE_FLAG_ENV, ACCOUNT_DELETION_FLAG_ENV, CATALOG_SESSION_PROTOCOL, INDEX_OPERATION_TYPES, DIRECT_CREDENTIAL_KEYS, SQLSTATE,
  CatalogAuthorityError, catalogNativeConfig, createCatalogAuthority, evaluateNativePredicate, nativeGenerationDescriptor, canonicalJson,
  stripDirectCredentials, containsDirectCredentials, assertNativeStartupCompatible, assertNoNativeActivation,
  configureCatalogAuthority, currentCatalogAuthority, assertVaultRebindAllowedIfConfigured,
};
