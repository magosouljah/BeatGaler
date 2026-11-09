'use strict';
// T17-N — CLI nativa: `inspect` (solo lectura), `activate`, `reset` y `rebind-chat` (dry-run por defecto) según NATIVO r2.1
// §3.1, §4.1–§4.4, §5.0, §12.3 y §13 (R12, R14). Sin sombra, freeze, corte ni reversión (TAREAS T17 redefinida).
// Telegram nunca se consulta ni se escribe desde aquí (no hay gateway): el inventario es SQL puro y lo dice en su manifiesto.
// Toda comprobación corre dentro de la misma transacción que escribe; el dry-run usa una transacción READ ONLY y no escribe.
// Ningún comando vacía una biblioteca nativa ni borra filas legacy, medios o INDEX: reset las deja inertes (§4.2 "Qué no hace").
const crypto = require('crypto');
const fs = require('fs');
const { canonicalJson } = require('./authority');
const { deterministicId } = require('../legacy-import-executor');

const VERSION = 'T17-N (NATIVO r2.1)';
const HELP = `catalog-native — CLI nativa del catálogo PostgreSQL (${VERSION})

Uso:
  node cloud-server/scripts/catalog-native.cjs --database-url <url> <comando> [opciones]
  node cloud-server/scripts/catalog-native.cjs --help

La URL de PostgreSQL se pasa SIEMPRE de forma explícita con --database-url; DATABASE_URL y el resto del entorno se ignoran.
Todos los comandos salvo inspect son dry-run por defecto: solo leen y muestran el plan. Aplicar exige --apply y un manifiesto
JSON revisado sin placeholders ni secretos (bot_token, api_hash, password, URLs con credenciales se rechazan).
Salida: JSON en stdout. Códigos: 0 ok/no-op, 2 uso, 3 STOP-* (detalle en stderr), 4 error SQL.

Comandos:
  inspect --environment <id> [--user <id>] [--auth-json <accounts-data.json>] [--out <manifiesto.json>] [--allow-write-role]
      Solo lectura (BEGIN READ ONLY) con un rol sin permiso de escritura; --allow-write-role solo en un laboratorio desechable.
      Por vault: puntero/pin, library_beats, cuota, purges, operaciones Direct/PROJECT en vuelo, capacidades vivas, chat, bot,
      fila de catálogo y divergencia vaults.id/chat JSON↔SQL (R12) si se pasa --auth-json. Telegram no se consulta
      (telegram: "NOT_QUERIED"). Devuelve un manifiesto con inventory_sha256 por vault y global; el propietario rellena
      "discardable" fuera de la CLI. Sin inventario marcado no hay reset.
  activate --manifest <activate.json> --auth-json <accounts-data.json> [--apply]
      Inserta la única fila de catalog_native_activation (§3.1). Precondiciones en la misma transacción: ninguna activación
      previa (misma environment_id + mismo manifiesto → no-op ALREADY_ACTIVATED; otra → STOP), control-plane postgres
      (cutover READY), JSON-compat = SQL en número y hash de users y vaults, 0 usuarios en cuarentena, inventario igual al
      del inspect aprobado (inspect.inventory_sha256), sin divergencias R12, catalog_libraries vacía salvo staging LEGACY
      listado, cerco §5.0 verificado en SQL (rol antiguo NOLOGIN con 0 backends, bots conocidos sin rotación pendiente,
      inventario de instancias todas paradas, direct_token_exposure ROTATED|FRESH_BOTS; WAIVED_TEST_ONLY no existe).
      Manifiesto: { environment_id, run_id, transport_bot_ids[], direct_token_exposure, instance_inventory[{id, stopped}],
        inspect{inventory_sha256, approval_ref}, credential_fence{old_db_role, token_rotation_proof_ref,
        transport_fence_proof_ref}, staging_libraries[]? }
  rebind-chat --manifest <rebind.json> [--auth-json <accounts-data.json>] [--apply]
      Única vía para cambiar vaults.telegram_chat_id de un vault con catálogo o en reset (§4.3). Con biblioteca: abre
      catalog_chat_rebinds (OPEN → APPLIED en la misma transacción), el chat anterior pasa a RETIRED (solo lectura) y el nuevo
      a CURRENT, época +1. Siempre deja una fila append-only en catalog_vault_rebind_audit y resuelve la cuarentena del flush
      del usuario (resolution REBIND). Con --auth-json actualiza storageChatId del JSON-compat antes del COMMIT.
      Rechaza: vault_id distinto (R12), from_chat distinto, chat destino ya usado (biblioteca, otro vault o abandonado),
      operaciones en vuelo. Manifiesto: { environment_id, user_id, vault_id, from_chat_id, to_chat_id, approval_ref, rebind_id? }
  reset --manifest <reset.json> [--apply]
      Reinicio nativo de un vault de prueba descartable (§4.2), en una transacción con el vault bloqueado: recalcula el hash
      del inventario (distinto → STOP-DATA), exige 0 operaciones legacy en vuelo, biblioteca POSTGRES existente → no-op
      ALREADY_APPLIED solo con el mismo manifiesto (si no, LIBRARY_ALREADY_NATIVE: un reset nunca vacía una biblioteca
      nativa), exige que el vault ya apunte al chat nuevo puesto por rebind-chat (auditoría) y no registrado; generaciones
      LEGACY → RETIRED sin DELETE; generación reset-<uuid> origin RESET con descriptor de lo abandonado; biblioteca POSTGRES
      con era nueva y época +1; chat nuevo CURRENT y chat legacy LEGACY_ABANDONED; capacidades Direct revocadas;
      index_bootstrap_pending=false. No borra filas legacy, medios ni INDEX (eso es T24-N, con autorización propia).
      Secuencia: inspect → marcar descartable → rebind-chat --apply → inspect (hash posterior al rebind) → reset --apply.
      Manifiesto: { environment_id, run_id, user_id, vault_id, inventory_sha256, legacy_chat_id, new_chat_id,
        approval{marked_discardable: true, ref} }

STOP: STOP-ENV (entorno/activación/rol/bots), STOP-DATA (inventario, divergencias, chats, operaciones en vuelo),
STOP-CONTRACT (manifiesto inválido o incompatible), STOP-APPROVAL (vault no marcado como descartable).`;

class NativeCliError extends Error {
  constructor(code, stop, message, detail = {}) { super(message); this.name = 'NativeCliError'; this.code = code; this.stop = stop; this.detail = detail; }
}
const usage = (message, detail = {}) => new NativeCliError('USAGE', 'USAGE', message, detail);
const stop = (kind, code, message, detail = {}) => new NativeCliError(code, kind, message, detail);
const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

const CHAT_RE = /^-?[0-9]{1,20}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HEX_RE = /^[0-9a-f]{64}$/;
const PLACEHOLDER_RE = /^(\s*|<.*>|todo.*|tbd.*|placeholder.*|changeme.*|x{3,}|\.{3}|identificador-.*|sha-.*|uuid-.*|hash-.*|evidencia-.*|instruccion-.*|propietario-.*|vault-explicito|entorno-.*|ref-pendiente.*)$/i;
const SECRET_KEY_RE = /(bot_token|api_hash|api_id|password|passwd|secret|database_url|connection_string|authorization)/i;
const FLAG_ONLY = new Set(['apply', 'allow-write-role', 'telegram', 'help']);

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (arg === '-h') { out.flags.help = true; continue; }
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (FLAG_ONLY.has(key)) { out.flags[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || String(value).startsWith('--')) throw usage(`--${key} requires a value`);
    out.flags[key] = String(value); i += 1;
  }
  return out;
}

function requireText(source, key, { pattern = null, where = 'manifest' } = {}) {
  const value = source?.[key];
  if (typeof value !== 'string' || PLACEHOLDER_RE.test(value)) throw stop('STOP-CONTRACT', 'MANIFEST_FIELD_INVALID', `${where} field "${key}" is missing or a placeholder`, { field: key });
  if (pattern && !pattern.test(value)) throw stop('STOP-CONTRACT', 'MANIFEST_FIELD_INVALID', `${where} field "${key}" has an invalid format`, { field: key });
  return value;
}
function requireFlag(flags, key, pattern = null) {
  const value = flags[key];
  if (typeof value !== 'string' || !value.trim()) throw usage(`--${key} is required`);
  if (pattern && !pattern.test(value)) throw usage(`--${key} has an invalid format`);
  return value;
}
function assertNoSecrets(value, trail = '$') {
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoSecrets(v, `${trail}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) throw stop('STOP-CONTRACT', 'MANIFEST_CONTAINS_SECRETS', `manifest must not carry credentials (${trail}.${k})`, { path: `${trail}.${k}` });
      assertNoSecrets(v, `${trail}.${k}`);
    }
    return;
  }
  if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value)) throw stop('STOP-CONTRACT', 'MANIFEST_CONTAINS_SECRETS', `manifest must not carry URLs with credentials (${trail})`, { path: trail });
}
function readJsonFile(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { throw usage(`${label} cannot be read: ${error.code || error.message}`, { file }); }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw stop('STOP-CONTRACT', 'MANIFEST_INVALID_JSON', `${label} is not valid JSON`, { file }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw stop('STOP-CONTRACT', 'MANIFEST_INVALID_JSON', `${label} must be a JSON object`, { file });
  return parsed;
}
function loadManifest(flags) {
  const file = requireFlag(flags, 'manifest');
  const manifest = readJsonFile(file, 'manifest');
  assertNoSecrets(manifest);
  return manifest;
}
function loadAuthJson(file) {
  const data = readJsonFile(file, 'auth json');
  if (!Array.isArray(data.users)) throw stop('STOP-CONTRACT', 'AUTH_JSON_INVALID', 'auth json must contain a users array', { file });
  return data;
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const ROLE_SQL = `SELECT current_user::text AS role, has_table_privilege(current_user, 'vaults', 'UPDATE') AS can_write`;
const ACTIVATION_SQL = 'SELECT environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, activated_at FROM catalog_native_activation';
const CUTOVER_SQL = "SELECT state FROM control_plane_cutovers WHERE id = 'legacy-json-v1'";
const OPEN_QUARANTINE_SQL = 'SELECT count(DISTINCT user_id)::int AS n FROM control_plane_flush_quarantine WHERE resolved_at IS NULL';
// Inventario por vault (§4.1): SQL puro, determinista y recalculable bajo el lock del vault (§4.2.1).
const VAULT_INVENTORY_SQL = `
  SELECT v.id, v.user_id, v.telegram_chat_id, v.transport_bot_id, v.index_bootstrap_pending, v.catalog_native_eligible,
    v.index_pin_restricted_bot_id, v.index_pin_restricted_at::text AS index_pin_restricted_at, v.project_media_restricted_bot_id,
    (SELECT json_build_object('index_message_id', p.index_message_id::text, 'predecessor_message_id', p.predecessor_message_id::text, 'revision', p.revision::text, 'source', p.source)
       FROM vault_index_pointers p WHERE p.vault_id = v.id) AS pointer,
    (SELECT q.index_message_id::text FROM library_quota_state q WHERE q.user_id = v.user_id) AS quota_index_message_id,
    (SELECT count(*) FROM library_beats b WHERE b.user_id = v.user_id)::int AS library_beats,
    (SELECT count(*) FROM library_trash_purges t WHERE t.user_id = v.user_id)::int AS trash_purges,
    (SELECT count(*) FROM library_trash_purges t WHERE t.user_id = v.user_id AND t.confirmed_at IS NULL)::int AS trash_purges_open,
    (SELECT count(*) FROM library_beat_reservations r WHERE r.user_id = v.user_id)::int AS reservations,
    (SELECT count(*) FROM library_project_uploads u WHERE u.user_id = v.user_id)::int AS project_uploads,
    (SELECT count(*) FROM library_legacy_project_copies lc WHERE lc.user_id = v.user_id)::int AS legacy_project_copies,
    (SELECT count(*) FROM direct_operations d WHERE d.vault_id = v.id AND d.state NOT IN ('COMMITTED', 'FAILED'))::int AS direct_operations_live,
    (SELECT count(*) FROM direct_capabilities dc WHERE dc.user_id = v.user_id AND dc.status IN ('ACTIVE', 'AUTHORIZED'))::int AS capabilities_live,
    (SELECT count(*) FROM garbage_journal g WHERE g.vault_id = v.id)::int AS garbage_journal,
    (SELECT count(*) FROM index_observations o WHERE o.vault_id = v.id)::int AS index_observations,
    (SELECT json_build_object('authority', l.authority, 'generation_id', l.active_generation_id, 'origin', g.origin, 'era', l.authority_era::text, 'epoch', l.authority_epoch::text)
       FROM catalog_libraries l LEFT JOIN catalog_generations g ON g.user_id = l.user_id AND g.generation_id = l.active_generation_id WHERE l.user_id = v.user_id) AS catalog,
    (SELECT json_agg(json_build_object('chat_id', c.chat_id, 'state', c.state) ORDER BY c.chat_id) FROM catalog_library_chats c WHERE c.user_id = v.user_id) AS catalog_chats,
    EXISTS (SELECT 1 FROM control_plane_flush_quarantine fq WHERE fq.user_id = v.user_id AND fq.resolved_at IS NULL) AS quarantined
  FROM vaults v WHERE ($1::text IS NULL OR v.user_id = $1) ORDER BY v.user_id`;

function jsonCompatOf(row, authJson) {
  if (!authJson) return 'NOT_COMPARED';
  const user = (authJson.users || []).find((u) => String(u.id) === String(row.user_id)) || null;
  const jsonVaultId = user && user.storageChatId != null ? deterministicId('vlt', String(user.id), user.storageChatId) : null;
  return {
    present: Boolean(user),
    vault_id: jsonVaultId,
    chat_id: user && user.storageChatId != null ? String(user.storageChatId) : null,
    vault_id_diverges: jsonVaultId !== null && jsonVaultId !== row.id,
    chat_diverges: Boolean(user) && String(user.storageChatId ?? '') !== String(row.telegram_chat_id ?? ''),
  };
}
async function inventory(client, { userId = null, authJson = null } = {}) {
  const rows = (await client.query(VAULT_INVENTORY_SQL, [userId])).rows;
  const vaults = rows.map((row) => {
    const entry = {
      user_id: row.user_id, vault_id: row.id, chat_id: row.telegram_chat_id == null ? null : String(row.telegram_chat_id), transport_bot_id: row.transport_bot_id || null,
      index_bootstrap_pending: row.index_bootstrap_pending === true, catalog_native_eligible: row.catalog_native_eligible === true,
      pin: { index_pin_restricted_bot_id: row.index_pin_restricted_bot_id || null, index_pin_restricted_at: row.index_pin_restricted_at || null, project_media_restricted_bot_id: row.project_media_restricted_bot_id || null },
      pointer: row.pointer || null, quota_index_message_id: row.quota_index_message_id || null,
      counts: {
        library_beats: row.library_beats, trash_purges: row.trash_purges, trash_purges_open: row.trash_purges_open, reservations: row.reservations, project_uploads: row.project_uploads,
        legacy_project_copies: row.legacy_project_copies, direct_operations_live: row.direct_operations_live, capabilities_live: row.capabilities_live,
        garbage_journal: row.garbage_journal, index_observations: row.index_observations,
      },
      catalog: row.catalog || null, catalog_chats: row.catalog_chats || [], quarantined: row.quarantined === true,
    };
    // El hash cubre solo SQL: la comparación JSON (R12) se informa aparte y no altera el hash que reset recalcula bajo el lock.
    return { ...entry, inventory_sha256: sha256Hex(canonicalJson(entry)), json_compat: jsonCompatOf(row, authJson) };
  });
  return { vaults, inventory_sha256: sha256Hex(canonicalJson(vaults.map((v) => v.inventory_sha256))) };
}
async function readActivation(client) {
  const rows = (await client.query(ACTIVATION_SQL)).rows;
  if (!rows.length) return null;
  const row = rows[0];
  let bots = [];
  try { bots = JSON.parse(row.transport_bot_ids); } catch { bots = []; }
  return { environment_id: row.environment_id, run_id: row.run_id, transport_bot_ids: bots, direct_token_exposure: row.direct_token_exposure, manifest_sha256: row.manifest_sha256, activated_at: row.activated_at instanceof Date ? row.activated_at.toISOString() : String(row.activated_at) };
}
async function requireActivation(client, environmentId) {
  const activation = await readActivation(client);
  if (!activation) throw stop('STOP-ENV', 'NOT_ACTIVATED', 'the environment is not natively activated (run activate first)');
  if (activation.environment_id !== environmentId) throw stop('STOP-ENV', 'ENVIRONMENT_MISMATCH', 'the manifest environment differs from the activated environment', { activated: activation.environment_id, manifest: environmentId });
  return activation;
}
async function compareJsonCompat(client, authJson) {
  const users = authJson.users || [];
  const jsonUsers = users.map((u) => String(u.id)).sort();
  const jsonVaults = users.filter((u) => u.storageChatId != null).map((u) => [String(u.id), deterministicId('vlt', String(u.id), u.storageChatId), String(u.storageChatId)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sqlUsers = (await client.query('SELECT id FROM users ORDER BY id')).rows.map((r) => String(r.id));
  const sqlVaults = (await client.query('SELECT user_id, id, telegram_chat_id FROM vaults ORDER BY user_id')).rows.map((r) => [String(r.user_id), String(r.id), String(r.telegram_chat_id)]);
  const h = (value) => sha256Hex(canonicalJson(value));
  const result = {
    users: { json: jsonUsers.length, sql: sqlUsers.length, json_sha256: h(jsonUsers), sql_sha256: h(sqlUsers) },
    vaults: { json: jsonVaults.length, sql: sqlVaults.length, json_sha256: h(jsonVaults), sql_sha256: h(sqlVaults) },
  };
  result.match = result.users.json_sha256 === result.users.sql_sha256 && result.vaults.json_sha256 === result.vaults.sql_sha256;
  return result;
}

// Escritor del control-plane por defecto: la misma sentencia que el flusher (postgres-auth-multiprocess-compat.js) para que
// el estado JSON-compat (virtual en modo postgres) y SQL coincidan; el trigger 0027 ve el rebind OPEN en la misma transacción.
const sqlControlPlaneWriter = Object.freeze({
  async setVaultChat(client, { userId, vaultId, toChatId }) {
    const r = await client.query('UPDATE vaults SET telegram_chat_id = $1, updated_at = now() WHERE id = $2 AND user_id = $3', [toChatId, vaultId, userId]);
    if (r.rowCount !== 1) throw stop('STOP-DATA', 'VAULT_WRITE_FAILED', 'vault chat update affected an unexpected number of rows', { rows: r.rowCount });
  },
});

function createNativeCli({ pool, now = () => new Date(), randomUUID = () => crypto.randomUUID(), controlPlaneWriter = sqlControlPlaneWriter } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createNativeCli requires a pg pool');

  async function withTx(apply, fn) {
    const client = await pool.connect();
    try {
      await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function inspect(flags) {
    const environment = requireFlag(flags, 'environment', ID_RE);
    if (flags.telegram) throw usage('Telegram is never queried by this CLI: it needs a separate authorization and the gateway (T11); remove --telegram');
    const authJson = flags['auth-json'] ? loadAuthJson(flags['auth-json']) : null;
    const userId = flags.user ? requireFlag(flags, 'user') : null;
    const manifest = await withTx(false, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const role = (await client.query(ROLE_SQL)).rows[0];
      if (role.can_write === true && !flags['allow-write-role']) {
        throw stop('STOP-ENV', 'INSPECT_ROLE_CAN_WRITE', `inspect must run with a read-only role (role "${role.role}" can UPDATE vaults); --allow-write-role is only for a disposable lab`, { role: role.role });
      }
      const activation = await readActivation(client);
      if (activation && activation.environment_id !== environment) throw stop('STOP-ENV', 'ENVIRONMENT_MISMATCH', 'the requested environment differs from the activated one', { activated: activation.environment_id, requested: environment });
      const cutover = (await client.query(CUTOVER_SQL)).rows[0] || null;
      const libraries = (await client.query('SELECT count(*)::int AS n FROM catalog_libraries')).rows[0].n;
      const quarantined = (await client.query(OPEN_QUARANTINE_SQL)).rows[0].n;
      const inv = await inventory(client, { userId, authJson });
      return {
        kind: 'T17-N inspect', version: VERSION, environment, generated_at: now().toISOString(), read_only: true, role: role.role, role_can_write: role.can_write === true,
        activation, control_plane: { cutover_state: cutover ? cutover.state : null, mode: cutover && cutover.state === 'READY' ? 'postgres' : 'json-or-unknown' },
        telegram: 'NOT_QUERIED', json_compat: authJson ? 'COMPARED' : 'NOT_COMPARED',
        counts: { vaults: inv.vaults.length, catalog_libraries: libraries, quarantined_users: quarantined, diverging_vaults: inv.vaults.filter((v) => v.json_compat !== 'NOT_COMPARED' && (v.json_compat.vault_id_diverges || v.json_compat.chat_diverges)).length },
        vaults: inv.vaults, inventory_sha256: inv.inventory_sha256,
        discardable: [], discardable_note: 'the owner lists discardable vault_ids here outside the CLI; reset also requires approval.marked_discardable=true per vault',
      };
    });
    if (flags.out) writeJsonAtomic(flags.out, manifest);
    return { exitCode: 0, result: manifest };
  }

  async function activate(flags) {
    const apply = flags.apply === true;
    const manifest = loadManifest(flags);
    const environmentId = requireText(manifest, 'environment_id', { pattern: ID_RE });
    const runId = requireText(manifest, 'run_id');
    const bots = manifest.transport_bot_ids;
    if (!Array.isArray(bots) || !bots.length || bots.some((b) => typeof b !== 'string' || !ID_RE.test(b))) throw stop('STOP-CONTRACT', 'MANIFEST_FIELD_INVALID', 'transport_bot_ids must be a non-empty list of bot ids', { field: 'transport_bot_ids' });
    const exposure = manifest.direct_token_exposure;
    if (exposure === 'WAIVED_TEST_ONLY') throw stop('STOP-CONTRACT', 'TOKEN_EXPOSURE_WAIVED', 'WAIVED_TEST_ONLY was removed by NATIVO r2.1 §5.0: rotate the tokens or use fresh bots');
    if (!['ROTATED', 'FRESH_BOTS'].includes(exposure)) throw stop('STOP-CONTRACT', 'MANIFEST_FIELD_INVALID', 'direct_token_exposure must be ROTATED or FRESH_BOTS', { field: 'direct_token_exposure' });
    const instances = manifest.instance_inventory;
    if (!Array.isArray(instances) || !instances.length) throw stop('STOP-ENV', 'INSTANCES_NOT_INVENTORIED', 'instance_inventory must list every pre-T05 Cloud instance and worker (R14)');
    for (const instance of instances) {
      requireText(instance, 'id', { where: 'instance_inventory' });
      if (instance.stopped !== true) throw stop('STOP-ENV', 'INSTANCES_NOT_DRAINED', `instance ${instance.id} is not stopped (§5.0.1)`, { id: instance.id });
    }
    const inspectRef = manifest.inspect || {};
    const inventorySha = requireText(inspectRef, 'inventory_sha256', { pattern: HEX_RE, where: 'inspect' });
    requireText(inspectRef, 'approval_ref', { where: 'inspect' });
    const fence = manifest.credential_fence || {};
    const oldRole = requireText(fence, 'old_db_role', { where: 'credential_fence' });
    requireText(fence, 'token_rotation_proof_ref', { where: 'credential_fence' });
    requireText(fence, 'transport_fence_proof_ref', { where: 'credential_fence' });
    const staging = Array.isArray(manifest.staging_libraries) ? manifest.staging_libraries.map(String) : [];
    if (!flags['auth-json']) throw usage('activate requires --auth-json <accounts-data.json> to compare the JSON-compat state with SQL (§3.1)');
    const authJson = loadAuthJson(flags['auth-json']);
    const manifestSha = sha256Hex(canonicalJson(manifest));

    return withTx(apply, async (client) => {
      if (apply) await client.query('LOCK TABLE catalog_native_activation IN SHARE ROW EXCLUSIVE MODE');
      const current = await readActivation(client);
      if (current) {
        if (current.environment_id === environmentId && current.manifest_sha256 === manifestSha) {
          return { exitCode: 0, result: { command: 'activate', mode: apply ? 'apply' : 'dry-run', outcome: 'ALREADY_ACTIVATED', activation: current, writes: 0 } };
        }
        throw stop('STOP-CONTRACT', 'ENVIRONMENT_ALREADY_ACTIVATED', 'an activation already exists; activate is idempotent only for the same environment and manifest', { activated: current.environment_id, manifest_sha256: current.manifest_sha256 });
      }
      const role = (await client.query(ROLE_SQL)).rows[0];
      if (role.role === oldRole) throw stop('STOP-ENV', 'OLD_ROLE_IN_USE', 'activate is running with the old DB role; use the new runtime role (§5.0.2)', { role: role.role });
      const cutover = (await client.query(CUTOVER_SQL)).rows[0] || null;
      if (!cutover || cutover.state !== 'READY') throw stop('STOP-ENV', 'CONTROL_PLANE_NOT_POSTGRES', 'the control-plane is not in postgres mode (no READY cutover)', { cutover_state: cutover ? cutover.state : null });
      const compat = await compareJsonCompat(client, authJson);
      if (!compat.match) throw stop('STOP-DATA', 'JSON_SQL_MISMATCH', 'JSON-compat state and SQL differ in users or vaults', compat);
      const quarantined = (await client.query(OPEN_QUARANTINE_SQL)).rows[0].n;
      if (quarantined > 0) throw stop('STOP-DATA', 'VAULTS_PENDING_FLUSH', 'there are users in flush quarantine (vaults pending)', { quarantined_users: quarantined });
      const inv = await inventory(client, { authJson });
      if (inv.inventory_sha256 !== inventorySha) throw stop('STOP-DATA', 'INVENTORY_CHANGED', 'the inventory differs from the approved inspect manifest (TOCTOU)', { expected: inventorySha, actual: inv.inventory_sha256 });
      const diverging = inv.vaults.filter((v) => v.json_compat.vault_id_diverges || v.json_compat.chat_diverges || !v.json_compat.present);
      if (diverging.length) throw stop('STOP-DATA', 'VAULT_ID_DIVERGENCE', 'vaults.id or chat diverge between JSON and SQL (R12): resolve before activating', { users: diverging.map((v) => v.user_id) });
      const libs = (await client.query('SELECT user_id, authority FROM catalog_libraries ORDER BY user_id')).rows;
      const unexpected = libs.filter((l) => !staging.includes(String(l.user_id)) || l.authority !== 'LEGACY');
      if (unexpected.length) throw stop('STOP-DATA', 'CATALOG_LIBRARIES_PRESENT', 'catalog_libraries must be empty except the LEGACY staging listed in the manifest', { users: unexpected.map((l) => l.user_id) });
      const roleRow = (await client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [oldRole])).rows[0];
      if (!roleRow) throw stop('STOP-ENV', 'OLD_ROLE_MISSING', 'the old DB role does not exist in this cluster: the credential fence cannot be verified', { role: oldRole });
      if (roleRow.rolcanlogin === true) throw stop('STOP-ENV', 'OLD_ROLE_CAN_LOGIN', 'the old DB role must be NOLOGIN before activation (§5.0.2)', { role: oldRole });
      const backends = (await client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1', [oldRole])).rows[0].n;
      if (backends > 0) throw stop('STOP-ENV', 'OLD_ROLE_BACKENDS_ALIVE', 'the old DB role still has backends; terminate them before activation (§5.0.2)', { role: oldRole, backends });
      const botRows = (await client.query('SELECT id, quarantined, rotation_pending FROM transport_bots WHERE id = ANY($1::text[])', [bots])).rows;
      for (const bot of bots) {
        const row = botRows.find((b) => String(b.id) === bot);
        if (!row) throw stop('STOP-ENV', 'TRANSPORT_BOT_UNKNOWN', `transport bot ${bot} is not registered`, { bot });
        if (row.quarantined === true || row.rotation_pending === true) throw stop('STOP-ENV', 'TRANSPORT_BOT_NOT_READY', `transport bot ${bot} is quarantined or has a rotation pending`, { bot });
      }
      const plan = {
        environment_id: environmentId, run_id: runId, transport_bot_ids: bots, direct_token_exposure: exposure, manifest_sha256: manifestSha,
        instances: instances.length, staging_libraries: staging, inventory_sha256: inventorySha,
        checks: ['NO_PRIOR_ACTIVATION', 'CONTROL_PLANE_POSTGRES', 'JSON_SQL_MATCH', 'NO_QUARANTINE', 'INVENTORY_MATCH', 'NO_R12_DIVERGENCE', 'LIBRARIES_CLEAN', 'OLD_ROLE_NOLOGIN_0_BACKENDS', 'BOTS_READY', 'INSTANCES_DRAINED'],
      };
      if (!apply) return { exitCode: 0, result: { command: 'activate', mode: 'dry-run', outcome: 'WOULD_ACTIVATE', plan, writes: 0, apply_hint: 'repeat with --apply and the same manifest' } };
      await client.query('INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ($1, $2, $3, $4, $5, $6)',
        [environmentId, runId, JSON.stringify(bots), exposure, manifestSha, canonicalJson(instances)]);
      const activation = await readActivation(client);
      return { exitCode: 0, result: { command: 'activate', mode: 'apply', outcome: 'ACTIVATED', activation, plan, writes: 1 } };
    });
  }

  async function rebindChat(flags) {
    const apply = flags.apply === true;
    const manifest = loadManifest(flags);
    const environmentId = requireText(manifest, 'environment_id', { pattern: ID_RE });
    const userId = requireText(manifest, 'user_id');
    const vaultId = requireText(manifest, 'vault_id');
    const fromChat = requireText(manifest, 'from_chat_id', { pattern: CHAT_RE });
    const toChat = requireText(manifest, 'to_chat_id', { pattern: CHAT_RE });
    const approvalRef = requireText(manifest, 'approval_ref');
    if (fromChat === toChat) throw stop('STOP-CONTRACT', 'SAME_CHAT', 'from_chat_id and to_chat_id are equal');
    const manifestSha = sha256Hex(canonicalJson(manifest));
    const rebindId = manifest.rebind_id ? requireText(manifest, 'rebind_id', { pattern: /^[A-Za-z0-9_-]{1,64}$/ }) : `rebind-${manifestSha.slice(0, 24)}`;
    const authFile = flags['auth-json'] || null;
    const authJson = authFile ? loadAuthJson(authFile) : null;

    return withTx(apply, async (client) => {
      await requireActivation(client, environmentId);
      const vault = (await client.query(`SELECT id, user_id, telegram_chat_id FROM vaults WHERE user_id = $1${apply ? ' FOR UPDATE' : ''}`, [userId])).rows[0] || null;
      if (!vault) throw stop('STOP-DATA', 'VAULT_MISSING', 'no vault for this user', { user_id: userId });
      if (String(vault.id) !== vaultId) throw stop('STOP-DATA', 'VAULT_ID_MISMATCH', 'vaults.id differs from the manifest (R12): resolve the divergence, never pick one by intuition', { sql: vault.id, manifest: vaultId });
      const prior = (await client.query('SELECT rebind_id FROM catalog_vault_rebind_audit WHERE user_id = $1 AND vault_id = $2 AND manifest_sha256 = $3', [userId, vaultId, manifestSha])).rows[0] || null;
      if (prior && String(vault.telegram_chat_id) === toChat) return { exitCode: 0, result: { command: 'rebind-chat', mode: apply ? 'apply' : 'dry-run', outcome: 'ALREADY_APPLIED', rebind_id: prior.rebind_id, writes: 0 } };
      if (String(vault.telegram_chat_id) !== fromChat) throw stop('STOP-DATA', 'FROM_CHAT_MISMATCH', 'the vault does not point to from_chat_id', { sql: String(vault.telegram_chat_id), manifest: fromChat });
      const inUse = (await client.query(`SELECT 'catalog_library_chats' AS src FROM catalog_library_chats WHERE provider = 'telegram' AND chat_id = $1
        UNION ALL SELECT 'vaults' FROM vaults WHERE telegram_chat_id = $1 AND user_id <> $2
        UNION ALL SELECT 'catalog_vault_rebind_audit' FROM catalog_vault_rebind_audit WHERE from_chat_id = $1 OR to_chat_id = $1`, [toChat, userId])).rows;
      if (inUse.length) throw stop('STOP-DATA', 'TO_CHAT_IN_USE', 'the destination chat already belongs to a library, another vault or an abandoned/retired chat (a chat belongs to one library forever)', { sources: inUse.map((r) => r.src) });
      const lib = (await client.query(`SELECT authority, authority_epoch::text AS epoch FROM catalog_libraries WHERE user_id = $1${apply ? ' FOR UPDATE' : ''}`, [userId])).rows[0] || null;
      const live = (await client.query(`SELECT
          (SELECT count(*) FROM direct_operations d WHERE d.vault_id = $2 AND d.state NOT IN ('COMMITTED', 'FAILED'))::int AS legacy_ops,
          (SELECT count(*) FROM catalog_operations o WHERE o.user_id = $1 AND o.status IN ('QUEUED', 'RUNNING', 'CANCELLING'))::int AS catalog_ops`, [userId, vaultId])).rows[0];
      if (live.legacy_ops > 0 || live.catalog_ops > 0) throw stop('STOP-DATA', 'OPERATIONS_IN_FLIGHT', 'operations are in flight for this vault; drain them first', live);
      if (authJson) {
        const user = authJson.users.find((u) => String(u.id) === userId) || null;
        if (!user) throw stop('STOP-DATA', 'JSON_USER_MISSING', 'the user is missing from the JSON-compat state', { user_id: userId });
        if (String(user.storageChatId ?? '') !== fromChat) throw stop('STOP-DATA', 'JSON_CHAT_MISMATCH', 'the JSON-compat storageChatId differs from from_chat_id', { json: user.storageChatId ?? null, manifest: fromChat });
      }
      const quarantineRows = (await client.query('SELECT count(*)::int AS n FROM control_plane_flush_quarantine WHERE user_id = $1 AND resolved_at IS NULL', [userId])).rows[0].n;
      const plan = {
        rebind_id: rebindId, user_id: userId, vault_id: vaultId, from_chat_id: fromChat, to_chat_id: toChat, library_authority: lib ? lib.authority : null,
        writes: [
          ...(lib ? ['catalog_chat_rebinds OPEN→APPLIED'] : []), 'vaults.telegram_chat_id (control-plane write path)',
          ...(lib && lib.authority === 'POSTGRES' ? ['catalog_library_chats CURRENT→RETIRED + new CURRENT', 'catalog_libraries epoch+1 revision+1'] : []),
          ...(quarantineRows ? [`control_plane_flush_quarantine resolved (${quarantineRows}) resolution=REBIND`] : []), 'catalog_vault_rebind_audit append', ...(authJson ? ['auth json storageChatId'] : []),
        ],
      };
      if (!apply) return { exitCode: 0, result: { command: 'rebind-chat', mode: 'dry-run', outcome: 'WOULD_REBIND', plan, writes: 0 } };
      if (lib) await client.query("INSERT INTO catalog_chat_rebinds(rebind_id, user_id, vault_id, from_chat_id, to_chat_id, state, manifest_sha256) VALUES ($1, $2, $3, $4, $5, 'OPEN', $6)", [rebindId, userId, vaultId, fromChat, toChat, manifestSha]);
      await controlPlaneWriter.setVaultChat(client, { userId, vaultId, fromChatId: fromChat, toChatId: toChat });
      if (lib && lib.authority === 'POSTGRES') {
        await client.query("UPDATE catalog_library_chats SET state = 'RETIRED', retired_at = now() WHERE user_id = $1 AND state = 'CURRENT'", [userId]);
        await client.query("INSERT INTO catalog_library_chats(provider, chat_id, user_id, vault_id, state) VALUES ('telegram', $1, $2, $3, 'CURRENT')", [toChat, userId, vaultId]);
        await client.query('UPDATE catalog_libraries SET authority_epoch = authority_epoch + 1, revision = revision + 1 WHERE user_id = $1', [userId]);
      }
      if (lib) await client.query("UPDATE catalog_chat_rebinds SET state = 'APPLIED', closed_at = now() WHERE rebind_id = $1", [rebindId]);
      const resolved = await client.query("UPDATE control_plane_flush_quarantine SET resolved_at = now(), resolution = 'REBIND' WHERE user_id = $1 AND resolved_at IS NULL", [userId]);
      await client.query('INSERT INTO catalog_vault_rebind_audit(rebind_id, environment_id, user_id, vault_id, from_chat_id, to_chat_id, library_authority, manifest_sha256, approval_ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [rebindId, environmentId, userId, vaultId, fromChat, toChat, lib ? lib.authority : null, manifestSha, approvalRef]);
      if (authJson) {
        const user = authJson.users.find((u) => String(u.id) === userId);
        user.storageChatId = toChat;
        writeJsonAtomic(authFile, authJson); // antes del COMMIT: si falla, la transacción SQL se revierte
      }
      const after = (await client.query('SELECT authority_epoch::text AS epoch FROM catalog_libraries WHERE user_id = $1', [userId])).rows[0] || null;
      return { exitCode: 0, result: { command: 'rebind-chat', mode: 'apply', outcome: 'REBOUND', plan, rebind_id: rebindId, quarantine_resolved: resolved.rowCount, authority_epoch: after ? after.epoch : null, writes: plan.writes.length } };
    });
  }

  async function reset(flags) {
    const apply = flags.apply === true;
    const manifest = loadManifest(flags);
    const environmentId = requireText(manifest, 'environment_id', { pattern: ID_RE });
    const runId = requireText(manifest, 'run_id');
    const userId = requireText(manifest, 'user_id');
    const vaultId = requireText(manifest, 'vault_id');
    const inventorySha = requireText(manifest, 'inventory_sha256', { pattern: HEX_RE });
    const legacyChat = requireText(manifest, 'legacy_chat_id', { pattern: CHAT_RE });
    const newChat = requireText(manifest, 'new_chat_id', { pattern: CHAT_RE });
    if (legacyChat === newChat) throw stop('STOP-CONTRACT', 'SAME_CHAT', 'legacy_chat_id and new_chat_id are equal');
    const approval = manifest.approval || {};
    if (approval.marked_discardable !== true) throw stop('STOP-APPROVAL', 'VAULT_NOT_MARKED_DISCARDABLE', 'the owner must mark this vault as discardable in the inspect inventory (approval.marked_discardable=true); without a marked inventory there is no reset');
    const approvalRef = requireText(approval, 'ref', { where: 'approval' });
    const manifestSha = sha256Hex(canonicalJson(manifest));

    return withTx(apply, async (client) => {
      await requireActivation(client, environmentId);
      const vault = (await client.query(`SELECT id, user_id, telegram_chat_id FROM vaults WHERE user_id = $1${apply ? ' FOR UPDATE' : ''}`, [userId])).rows[0] || null;
      if (!vault) throw stop('STOP-DATA', 'VAULT_MISSING', 'no vault for this user', { user_id: userId });
      if (String(vault.id) !== vaultId) throw stop('STOP-DATA', 'VAULT_ID_MISMATCH', 'vaults.id differs from the manifest (R12): resolve the divergence, never pick one by intuition', { sql: vault.id, manifest: vaultId });
      // 3. Fila existente (antes del hash: una biblioteca ya reiniciada cambia el inventario por construcción).
      const lib = (await client.query(`SELECT authority, active_generation_id, authority_epoch::text AS epoch FROM catalog_libraries WHERE user_id = $1${apply ? ' FOR UPDATE' : ''}`, [userId])).rows[0] || null;
      if (lib && lib.authority === 'POSTGRES') {
        const gen = (await client.query("SELECT generation_id, descriptor_json FROM catalog_generations WHERE user_id = $1 AND generation_id = $2 AND origin = 'RESET'", [userId, lib.active_generation_id])).rows[0] || null;
        let descriptor = null;
        try { descriptor = gen ? JSON.parse(gen.descriptor_json) : null; } catch { descriptor = null; }
        if (descriptor && descriptor.manifest_sha256 === manifestSha) return { exitCode: 0, result: { command: 'reset', mode: apply ? 'apply' : 'dry-run', outcome: 'ALREADY_APPLIED', generation_id: gen.generation_id, writes: 0 } };
        throw stop('STOP-DATA', 'LIBRARY_ALREADY_NATIVE', 'this library is already PostgreSQL-native; a reset never empties a native library', { generation_id: lib.active_generation_id });
      }
      // 1. Hash del inventario bajo el lock (TOCTOU).
      const inv = await inventory(client, { userId });
      const entry = inv.vaults[0];
      if (entry.inventory_sha256 !== inventorySha) throw stop('STOP-DATA', 'INVENTORY_CHANGED', 'the vault inventory differs from the manifest (TOCTOU): re-run inspect after rebind-chat and review again', { expected: inventorySha, actual: entry.inventory_sha256 });
      // 2. Operaciones legacy en vuelo.
      if (entry.counts.direct_operations_live > 0 || entry.counts.trash_purges_open > 0) throw stop('STOP-DATA', 'LEGACY_OPERATIONS_IN_FLIGHT', 'legacy operations are in flight for this vault', entry.counts);
      // 4. Chat nuevo puesto por rebind-chat y no registrado.
      if (String(vault.telegram_chat_id) !== newChat) throw stop('STOP-DATA', 'VAULT_CHAT_NOT_REBOUND', 'the vault does not point to new_chat_id yet: run rebind-chat --apply first (§4.2.4)', { sql: String(vault.telegram_chat_id), manifest: newChat });
      const audit = (await client.query('SELECT rebind_id FROM catalog_vault_rebind_audit WHERE user_id = $1 AND vault_id = $2 AND from_chat_id = $3 AND to_chat_id = $4 ORDER BY applied_at DESC LIMIT 1', [userId, vaultId, legacyChat, newChat])).rows[0] || null;
      if (!audit) throw stop('STOP-DATA', 'REBIND_AUDIT_MISSING', 'the chat change was not made by rebind-chat (no audit row legacy→new)', { legacy_chat_id: legacyChat, new_chat_id: newChat });
      const chatRows = (await client.query("SELECT chat_id, user_id, state FROM catalog_library_chats WHERE provider = 'telegram' AND chat_id = ANY($1::text[])", [[newChat, legacyChat]])).rows;
      if (chatRows.some((c) => c.chat_id === newChat)) throw stop('STOP-DATA', 'NEW_CHAT_ALREADY_REGISTERED', 'the new chat is already registered in catalog_library_chats', { chat_id: newChat });
      if (chatRows.some((c) => c.chat_id === legacyChat && String(c.user_id) !== userId)) throw stop('STOP-DATA', 'LEGACY_CHAT_OWNED_ELSEWHERE', 'the legacy chat belongs to another library', { chat_id: legacyChat });
      const generations = (await client.query("SELECT generation_id, status, origin FROM catalog_generations WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
      const uuid = randomUUID();
      const generationId = `reset-${uuid}`;
      const plan = {
        user_id: userId, vault_id: vaultId, library: lib ? `UPDATE (${lib.authority} → POSTGRES, epoch ${lib.epoch}+1)` : 'INSERT POSTGRES', generation_id: generationId, origin: 'RESET',
        retire_generations: generations.filter((g) => g.status !== 'RETIRED').map((g) => g.generation_id), chats: { current: newChat, legacy_abandoned: legacyChat }, rebind_id: audit.rebind_id,
        abandoned: { legacy_chat_id: legacyChat, pointer: entry.pointer, quota_index_message_id: entry.quota_index_message_id, counts: entry.counts },
        not_done: ['no DELETE of legacy rows', 'no media or INDEX deletion in Telegram (T24-N, separate authorization)'],
      };
      if (!apply) return { exitCode: 0, result: { command: 'reset', mode: 'dry-run', outcome: 'WOULD_RESET', plan, writes: 0 } };
      let era;
      if (lib) {
        // 5. LEGACY (staging T04): RETIRED primero (índice único ACTIVE), luego la generación nueva, luego la biblioteca.
        await client.query("UPDATE catalog_generations SET status = 'RETIRED' WHERE user_id = $1 AND status <> 'RETIRED'", [userId]);
      } else {
        era = (await client.query(`INSERT INTO catalog_libraries(user_id, vault_id, authority, migration_state, authority_epoch, revision, active_generation_id,
            active_count, trash_count, purging_count, pending_count, cleanup_enabled, restore_hold)
          VALUES ($1, $2, 'POSTGRES', 'IDLE', 1, 1, $3, 0, 0, 0, 0, false, true) RETURNING authority_era::text AS era`, [userId, vaultId, generationId])).rows[0].era;
      }
      if (lib) {
        era = (await client.query(`UPDATE catalog_libraries SET authority = 'POSTGRES', migration_state = 'IDLE', authority_era = gen_random_uuid(), authority_epoch = authority_epoch + 1,
            revision = revision + 1, active_generation_id = $2, active_count = 0, trash_count = 0, purging_count = 0, pending_count = 0, export_bytes_estimate = 0,
            cleanup_enabled = false, restore_hold = true WHERE user_id = $1 RETURNING authority_era::text AS era`, [userId, generationId])).rows[0].era;
      }
      const descriptor = canonicalJson({ kind: 'RESET', era, vault_id: vaultId, chat_id: newChat, abandoned: plan.abandoned, ledger_sha256: entry.inventory_sha256, manifest_sha256: manifestSha, inventory_sha256: inventorySha, rebind_id: audit.rebind_id, run_id: runId, approval_ref: approvalRef });
      await client.query(`INSERT INTO catalog_generations(user_id, generation_id, snapshot_id, status, source_hash, raw_index, raw_index_sha256, descriptor_json, validated_at, origin)
        VALUES ($1, $2, $3, 'ACTIVE', $4, NULL, NULL, $5, now(), 'RESET')`, [userId, generationId, `reset:${uuid}`, sha256Hex(descriptor), descriptor]);
      // 4/6. Chats: el legacy queda LEGACY_ABANDONED (el worker nativo nunca escribe ni borra en él); el nuevo es CURRENT.
      await client.query(`INSERT INTO catalog_library_chats(provider, chat_id, user_id, vault_id, state, retired_at) VALUES ('telegram', $1, $2, $3, 'LEGACY_ABANDONED', now())
        ON CONFLICT (provider, chat_id) DO UPDATE SET state = 'LEGACY_ABANDONED', retired_at = now() WHERE catalog_library_chats.user_id = EXCLUDED.user_id`, [legacyChat, userId, vaultId]);
      await client.query("INSERT INTO catalog_library_chats(provider, chat_id, user_id, vault_id, state) VALUES ('telegram', $1, $2, $3, 'CURRENT')", [newChat, userId, vaultId]);
      // 7. Capacidades Direct vivas revocadas; el vault deja de esperar bootstrap.
      await client.query("UPDATE direct_capabilities SET status = 'REVOKED', revoked_at = now(), revoke_reason = 'CATALOG_RESET' WHERE user_id = $1 AND status IN ('ACTIVE', 'AUTHORIZED')", [userId]);
      await client.query('UPDATE vaults SET index_bootstrap_pending = false, updated_at = now() WHERE id = $1 AND user_id = $2', [vaultId, userId]);
      const after = (await client.query('SELECT authority, authority_era::text AS era, authority_epoch::text AS epoch, active_generation_id FROM catalog_libraries WHERE user_id = $1', [userId])).rows[0];
      return { exitCode: 0, result: { command: 'reset', mode: 'apply', outcome: 'RESET_APPLIED', plan, context: { authority: after.authority, authority_era: after.era, authority_epoch: after.epoch, generation_id: after.active_generation_id }, writes: 'see plan' } };
    });
  }

  async function run(argv) {
    const parsed = parseArgs(argv);
    const command = parsed._[0];
    if (parsed.flags.help || command === 'help') return { exitCode: 0, result: { help: HELP } };
    if (!command) throw usage('a command is required (inspect | activate | rebind-chat | reset | --help)');
    if (parsed._.length > 1) throw usage(`unexpected positional arguments: ${parsed._.slice(1).join(' ')}`);
    switch (command) {
      case 'inspect': return inspect(parsed.flags);
      case 'activate': return activate(parsed.flags);
      case 'rebind-chat': return rebindChat(parsed.flags);
      case 'reset': return reset(parsed.flags);
      default: throw usage(`unknown command "${command}"; T17 has no import-shadow/compare/freeze/drain/cutover/rollback commands (NATIVO r2.1 §8)`);
    }
  }

  function describeError(error) {
    if (error instanceof NativeCliError) return { stop: error.stop, code: error.code, message: error.message, detail: error.detail, exit_code: error.stop === 'USAGE' ? 2 : 3 };
    return { stop: 'ERROR', code: error && error.code ? String(error.code) : 'UNEXPECTED', message: String(error && error.message ? error.message : error), detail: {}, exit_code: 4 };
  }

  return Object.freeze({ run, describeError, inspect, activate, rebindChat, reset, HELP });
}

module.exports = { createNativeCli, NativeCliError, HELP, VERSION, parseArgs, inventory, compareJsonCompat, sqlControlPlaneWriter, VAULT_INVENTORY_SQL };
