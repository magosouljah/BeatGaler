'use strict';
// T17-N — CLI nativa sin PostgreSQL real (pools falsos, red denegada): ayuda, uso, manifiestos (placeholders/secretos),
// inspect solo lectura con rol, dry-run sin escrituras para activate/rebind-chat/reset, y el binario ignora DATABASE_URL.
// Las pruebas contra PostgreSQL real están en catalog-native-cli.integration.cjs (suite T17 del runner).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cli = require('../../catalog/native-cli.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t17-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const H = 'a'.repeat(64);
const write = (name, value) => { const p = path.join(TMP, name); fs.writeFileSync(p, JSON.stringify(value)); return p; };
const ACTIVATION = { environment_id: 'lab', run_id: 'run-1', transport_bot_ids: '["Bot20"]', direct_token_exposure: 'FRESH_BOTS', manifest_sha256: H, activated_at: new Date(0) };
const VAULT_ROW = (over = {}) => ({ id: 'v-u1', user_id: 'u1', telegram_chat_id: '-1001', transport_bot_id: 'Bot20', index_bootstrap_pending: false, catalog_native_eligible: false,
  index_pin_restricted_bot_id: null, index_pin_restricted_at: null, project_media_restricted_bot_id: null, pointer: { index_message_id: '7' }, quota_index_message_id: '7',
  library_beats: 3, trash_purges: 0, trash_purges_open: 0, reservations: 0, project_uploads: 0, legacy_project_copies: 0, direct_operations_live: 0, capabilities_live: 1,
  garbage_journal: 0, index_observations: 0, catalog: null, catalog_chats: null, quarantined: false, ...over });

// Pool falso: responde por patrón y registra toda sentencia; `writes()` lista las que escribirían.
function fakePool({ activation = ACTIVATION, canWrite = false, vaults = [VAULT_ROW()], cutover = 'READY', libraries = [], quarantined = 0, audit = [], respond = null } = {}) {
  const statements = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql); statements.push(text);
      if (respond) { const r = respond(text, params); if (r !== undefined) return r; }
      if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|LOCK TABLE)/.test(text.trim())) return { rows: [], rowCount: 0 };
      if (/has_table_privilege/.test(text)) return { rows: [{ role: 'lab_admin', can_write: canWrite }] };
      if (/FROM catalog_native_activation/.test(text)) return { rows: activation ? [activation] : [] };
      if (/FROM control_plane_cutovers/.test(text)) return { rows: cutover ? [{ state: cutover }] : [] };
      if (/count\(\*\)::int AS n FROM catalog_libraries/.test(text)) return { rows: [{ n: libraries.length }] };
      if (/count\(DISTINCT user_id\)::int AS n FROM control_plane_flush_quarantine/.test(text)) return { rows: [{ n: quarantined }] };
      if (/FROM vaults v WHERE/.test(text)) return { rows: params[0] == null ? vaults : vaults.filter((v) => v.user_id === params[0]) };
      if (/SELECT id, user_id, telegram_chat_id FROM vaults WHERE user_id/.test(text)) return { rows: vaults.filter((v) => v.user_id === params[0]).map((v) => ({ id: v.id, user_id: v.user_id, telegram_chat_id: v.telegram_chat_id })) };
      if (/FROM catalog_vault_rebind_audit WHERE user_id = \$1 AND vault_id = \$2 AND manifest_sha256/.test(text)) return { rows: [] };
      if (/FROM catalog_vault_rebind_audit WHERE user_id = \$1 AND vault_id = \$2 AND from_chat_id/.test(text)) return { rows: audit };
      if (/UNION ALL SELECT 'vaults'/.test(text)) return { rows: [] };
      if (/FROM catalog_libraries WHERE user_id/.test(text)) return { rows: libraries.filter((l) => l.user_id === params[0]) };
      if (/AS legacy_ops/.test(text)) return { rows: [{ legacy_ops: 0, catalog_ops: 0 }] };
      if (/count\(\*\)::int AS n FROM control_plane_flush_quarantine WHERE user_id/.test(text)) return { rows: [{ n: 0 }] };
      if (/FROM catalog_library_chats WHERE provider = 'telegram' AND chat_id = ANY/.test(text)) return { rows: [] };
      if (/FROM catalog_generations WHERE user_id = \$1 ORDER BY created_at/.test(text)) return { rows: [] };
      if (/SELECT id FROM users ORDER BY id/.test(text)) return { rows: vaults.map((v) => ({ id: v.user_id })) };
      if (/SELECT user_id, id, telegram_chat_id FROM vaults ORDER BY user_id/.test(text)) return { rows: vaults.map((v) => ({ user_id: v.user_id, id: v.id, telegram_chat_id: v.telegram_chat_id })) };
      if (/FROM catalog_libraries ORDER BY user_id/.test(text)) return { rows: libraries };
      if (/FROM pg_roles/.test(text)) return { rows: [{ rolcanlogin: false }] };
      if (/FROM pg_stat_activity/.test(text)) return { rows: [{ n: 0 }] };
      if (/FROM transport_bots/.test(text)) return { rows: [{ id: 'Bot20', quarantined: false, rotation_pending: false }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { async connect() { return client; }, statements, writes: () => statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(s)) };
}
const rejects = (p, code, stop = null) => assert.rejects(p, (e) => { assert.equal(e.code, code, `código esperado ${code}, recibido ${e.code}: ${e.message}`); if (stop) assert.equal(e.stop, stop); return true; });

test('ayuda y uso: --help documenta los cuatro comandos y el dry-run por defecto; sin comando o con comandos de la ruta histórica → USAGE sin tocar la base', async () => {
  const pool = fakePool();
  const c = cli.createNativeCli({ pool });
  const help = (await c.run(['--help'])).result.help;
  for (const word of ['inspect', 'activate', 'rebind-chat', 'reset', '--apply', 'dry-run', '--database-url', 'NOT_QUERIED', 'STOP-DATA']) assert.ok(help.includes(word), word);
  assert.equal(help, cli.HELP);
  await rejects(c.run([]), 'USAGE');
  for (const old of ['import-shadow', 'compare', 'freeze', 'drain', 'cutover', 'export-rollback', 'return-legacy']) await rejects(c.run([old]), 'USAGE');
  await rejects(c.run(['inspect']), 'USAGE'); // --environment obligatorio
  await rejects(c.run(['inspect', '--environment', 'lab', '--telegram']), 'USAGE'); // Telegram nunca se consulta
  await rejects(c.run(['reset', '--apply']), 'USAGE'); // --manifest obligatorio
  assert.equal(pool.statements.length, 0);
  assert.equal(c.describeError(new Error('x')).exit_code, 4);
});

test('manifiestos: placeholders, formatos, secretos y WAIVED_TEST_ONLY se rechazan con STOP-CONTRACT antes de cualquier consulta', async () => {
  const pool = fakePool();
  const c = cli.createNativeCli({ pool });
  const base = { environment_id: 'lab', run_id: 'run-1', user_id: 'u1', vault_id: 'v-u1', inventory_sha256: H, legacy_chat_id: '-1001', new_chat_id: '-1002', approval: { marked_discardable: true, ref: 'purp-2026-11-09' } };
  await rejects(c.run(['reset', '--manifest', write('r1.json', { ...base, run_id: 'identificador-unico' })]), 'MANIFEST_FIELD_INVALID', 'STOP-CONTRACT');
  await rejects(c.run(['reset', '--manifest', write('r2.json', { ...base, new_chat_id: 'chat' })]), 'MANIFEST_FIELD_INVALID', 'STOP-CONTRACT');
  await rejects(c.run(['reset', '--manifest', write('r3.json', { ...base, new_chat_id: '-1001' })]), 'SAME_CHAT', 'STOP-CONTRACT');
  await rejects(c.run(['reset', '--manifest', write('r4.json', { ...base, approval: { marked_discardable: false, ref: 'x1' } })]), 'VAULT_NOT_MARKED_DISCARDABLE', 'STOP-APPROVAL');
  await rejects(c.run(['reset', '--manifest', write('r5.json', { ...base, notes: { bot_token: '123:abc' } })]), 'MANIFEST_CONTAINS_SECRETS', 'STOP-CONTRACT');
  await rejects(c.run(['reset', '--manifest', write('r6.json', { ...base, source: 'postgres://user:pw@host/db' })]), 'MANIFEST_CONTAINS_SECRETS', 'STOP-CONTRACT');
  fs.writeFileSync(path.join(TMP, 'bad.json'), '{nope');
  await rejects(c.run(['reset', '--manifest', path.join(TMP, 'bad.json')]), 'MANIFEST_INVALID_JSON', 'STOP-CONTRACT');
  const act = { environment_id: 'lab', run_id: 'run-1', transport_bot_ids: ['Bot20'], direct_token_exposure: 'WAIVED_TEST_ONLY', instance_inventory: [{ id: 'cloud-1', stopped: true }], inspect: { inventory_sha256: H, approval_ref: 'ok' }, credential_fence: { old_db_role: 'old', token_rotation_proof_ref: 'p1', transport_fence_proof_ref: 'p2' } };
  await rejects(c.run(['activate', '--manifest', write('a1.json', act), '--auth-json', write('auth.json', { users: [] })]), 'TOKEN_EXPOSURE_WAIVED', 'STOP-CONTRACT');
  await rejects(c.run(['activate', '--manifest', write('a2.json', { ...act, direct_token_exposure: 'FRESH_BOTS', instance_inventory: [{ id: 'cloud-1', stopped: false }] }), '--auth-json', write('auth.json', { users: [] })]), 'INSTANCES_NOT_DRAINED', 'STOP-ENV');
  await rejects(c.run(['activate', '--manifest', write('a3.json', { ...act, direct_token_exposure: 'FRESH_BOTS' })]), 'USAGE'); // --auth-json obligatorio
  assert.equal(pool.statements.length, 0, 'ninguna consulta antes de validar el manifiesto');
});

test('inspect: transacción READ ONLY, rol con escritura rechazado salvo --allow-write-role, Telegram NOT_QUERIED, hash determinista, divergencia R12 informada y 0 escrituras', async () => {
  await rejects(cli.createNativeCli({ pool: fakePool({ canWrite: true }) }).run(['inspect', '--environment', 'lab']), 'INSPECT_ROLE_CAN_WRITE', 'STOP-ENV');
  await rejects(cli.createNativeCli({ pool: fakePool({ activation: { ...ACTIVATION, environment_id: 'other' } }) }).run(['inspect', '--environment', 'lab']), 'ENVIRONMENT_MISMATCH', 'STOP-ENV');
  const pool = fakePool({ canWrite: true });
  const c = cli.createNativeCli({ pool, now: () => new Date(0) });
  const authJson = write('auth-r12.json', { users: [{ id: 'u1', storageChatId: '-1009' }] }); // JSON apunta a otro chat → id de vault y chat divergen
  const out = path.join(TMP, 'inspect.json');
  const a = (await c.run(['inspect', '--environment', 'lab', '--allow-write-role', '--auth-json', authJson, '--out', out])).result;
  const b = (await c.run(['inspect', '--environment', 'lab', '--allow-write-role'])).result;
  assert.equal(a.read_only, true); assert.equal(a.telegram, 'NOT_QUERIED'); assert.equal(a.control_plane.mode, 'postgres');
  assert.equal(a.vaults.length, 1); assert.equal(a.vaults[0].counts.library_beats, 3); assert.equal(a.vaults[0].pointer.index_message_id, '7');
  assert.equal(a.vaults[0].json_compat.vault_id_diverges, true); assert.equal(a.vaults[0].json_compat.chat_diverges, true); assert.equal(a.counts.diverging_vaults, 1);
  assert.equal(b.vaults[0].json_compat, 'NOT_COMPARED');
  assert.equal(a.inventory_sha256, b.inventory_sha256, 'el hash cubre solo SQL: no cambia con --auth-json');
  assert.equal(a.vaults[0].inventory_sha256, b.vaults[0].inventory_sha256);
  assert.deepEqual(a.discardable, []);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).inventory_sha256, a.inventory_sha256);
  assert.ok(pool.statements.some((s) => /^BEGIN READ ONLY/.test(s)) && pool.statements.some((s) => /REPEATABLE READ READ ONLY/.test(s)));
  assert.equal(pool.writes().length, 0);
});

test('dry-run por defecto: activate, rebind-chat y reset solo leen (BEGIN READ ONLY), devuelven el plan WOULD_* y writes=0; activate repetido con el mismo manifiesto → ALREADY_ACTIVATED', async () => {
  const auth = write('auth-ok.json', { users: [{ id: 'u1', storageChatId: '-1001' }] });
  // activate sin activación previa, con vault cuyo id coincide con el determinista del importador
  const { deterministicId } = require('../../legacy-import-executor.js');
  const vault = VAULT_ROW({ id: deterministicId('vlt', 'u1', '-1001') });
  const p1 = fakePool({ activation: null, vaults: [vault] });
  const c1 = cli.createNativeCli({ pool: p1 });
  const invSha = (await c1.run(['inspect', '--environment', 'lab', '--allow-write-role'])).result.inventory_sha256;
  const act = { environment_id: 'lab', run_id: 'run-1', transport_bot_ids: ['Bot20'], direct_token_exposure: 'FRESH_BOTS', instance_inventory: [{ id: 'cloud-1', stopped: true }], inspect: { inventory_sha256: invSha, approval_ref: 'sol-ok' }, credential_fence: { old_db_role: 'old_role', token_rotation_proof_ref: 'E29', transport_fence_proof_ref: 'E29-b' } };
  const r1 = (await c1.run(['activate', '--manifest', write('act.json', act), '--auth-json', auth])).result;
  assert.equal(r1.outcome, 'WOULD_ACTIVATE'); assert.equal(r1.writes, 0); assert.equal(r1.mode, 'dry-run'); assert.ok(r1.plan.checks.includes('OLD_ROLE_NOLOGIN_0_BACKENDS'));
  assert.equal(p1.writes().length, 0); assert.ok(p1.statements.every((s) => !/^BEGIN$/.test(s.trim())));
  await rejects(c1.run(['activate', '--manifest', write('act-bad.json', { ...act, inspect: { ...act.inspect, inventory_sha256: 'b'.repeat(64) } }), '--auth-json', auth]), 'INVENTORY_CHANGED', 'STOP-DATA');
  await rejects(c1.run(['activate', '--manifest', write('act.json', act), '--auth-json', write('auth-bad.json', { users: [{ id: 'u1', storageChatId: '-1001' }, { id: 'u2' }] })]), 'JSON_SQL_MISMATCH', 'STOP-DATA');
  await rejects(cli.createNativeCli({ pool: fakePool({ activation: null, vaults: [vault], cutover: null }) }).run(['activate', '--manifest', write('act.json', act), '--auth-json', auth]), 'CONTROL_PLANE_NOT_POSTGRES', 'STOP-ENV');
  await rejects(cli.createNativeCli({ pool: fakePool({ activation: null, vaults: [vault], respond: (t) => (/FROM pg_roles/.test(t) ? { rows: [{ rolcanlogin: true }] } : undefined) }) }).run(['activate', '--manifest', write('act.json', act), '--auth-json', auth]), 'OLD_ROLE_CAN_LOGIN', 'STOP-ENV');
  // ya activado con el mismo manifiesto → no-op; con otro → STOP-CONTRACT
  const sha = require('crypto').createHash('sha256').update(require('../../catalog/authority.js').canonicalJson(act)).digest('hex');
  assert.equal((await cli.createNativeCli({ pool: fakePool({ activation: { ...ACTIVATION, manifest_sha256: sha }, vaults: [vault] }) }).run(['activate', '--manifest', write('act.json', act), '--auth-json', auth])).result.outcome, 'ALREADY_ACTIVATED');
  await rejects(cli.createNativeCli({ pool: fakePool({ vaults: [vault] }) }).run(['activate', '--manifest', write('act.json', act), '--auth-json', auth]), 'ENVIRONMENT_ALREADY_ACTIVATED', 'STOP-CONTRACT');
  // rebind-chat y reset en dry-run
  const p2 = fakePool();
  const c2 = cli.createNativeCli({ pool: p2 });
  const rb = (await c2.run(['rebind-chat', '--manifest', write('rb.json', { environment_id: 'lab', user_id: 'u1', vault_id: 'v-u1', from_chat_id: '-1001', to_chat_id: '-1002', approval_ref: 'purp-ok' })])).result;
  assert.equal(rb.outcome, 'WOULD_REBIND'); assert.equal(rb.writes, 0); assert.ok(rb.plan.writes.includes('catalog_vault_rebind_audit append'));
  await rejects(c2.run(['rebind-chat', '--manifest', write('rb2.json', { environment_id: 'lab', user_id: 'u1', vault_id: 'v-OTHER', from_chat_id: '-1001', to_chat_id: '-1002', approval_ref: 'purp-ok' })]), 'VAULT_ID_MISMATCH', 'STOP-DATA');
  await rejects(c2.run(['rebind-chat', '--manifest', write('rb3.json', { environment_id: 'lab', user_id: 'u1', vault_id: 'v-u1', from_chat_id: '-1999', to_chat_id: '-1002', approval_ref: 'purp-ok' })]), 'FROM_CHAT_MISMATCH', 'STOP-DATA');
  const invU1 = (await c2.run(['inspect', '--environment', 'lab', '--allow-write-role', '--user', 'u1'])).result.vaults[0].inventory_sha256;
  const rs = { environment_id: 'lab', run_id: 'run-1', user_id: 'u1', vault_id: 'v-u1', inventory_sha256: invU1, legacy_chat_id: '-1002', new_chat_id: '-1001', approval: { marked_discardable: true, ref: 'purp-ok' } };
  await rejects(c2.run(['reset', '--manifest', write('rs0.json', rs)]), 'REBIND_AUDIT_MISSING', 'STOP-DATA'); // vault apunta al chat nuevo pero nadie lo rebindeó
  const p3 = fakePool({ audit: [{ rebind_id: 'rebind-1' }] });
  const r3 = (await cli.createNativeCli({ pool: p3, randomUUID: () => '0000-fixed' }).run(['reset', '--manifest', write('rs1.json', rs)])).result;
  assert.equal(r3.outcome, 'WOULD_RESET'); assert.equal(r3.writes, 0); assert.equal(r3.plan.generation_id, 'reset-0000-fixed'); assert.equal(r3.plan.library, 'INSERT POSTGRES');
  assert.deepEqual(r3.plan.not_done, ['no DELETE of legacy rows', 'no media or INDEX deletion in Telegram (T24-N, separate authorization)']);
  await rejects(cli.createNativeCli({ pool: fakePool({ audit: [{ rebind_id: 'rebind-1' }] }) }).run(['reset', '--manifest', write('rs2.json', { ...rs, inventory_sha256: 'c'.repeat(64) })]), 'INVENTORY_CHANGED', 'STOP-DATA');
  await rejects(cli.createNativeCli({ pool: fakePool({ audit: [{ rebind_id: 'rebind-1' }], vaults: [VAULT_ROW({ direct_operations_live: 1 })] }) }).run(['reset', '--manifest', write('rs3.json', { ...rs, inventory_sha256: (await cli.createNativeCli({ pool: fakePool({ vaults: [VAULT_ROW({ direct_operations_live: 1 })] }) }).run(['inspect', '--environment', 'lab', '--allow-write-role'])).result.vaults[0].inventory_sha256 })]), 'LEGACY_OPERATIONS_IN_FLIGHT', 'STOP-DATA');
  await rejects(cli.createNativeCli({ pool: fakePool({ libraries: [{ user_id: 'u1', authority: 'POSTGRES', active_generation_id: 'native-1', epoch: '1' }] }) }).run(['reset', '--manifest', write('rs4.json', rs)]), 'LIBRARY_ALREADY_NATIVE', 'STOP-DATA');
  await rejects(cli.createNativeCli({ pool: fakePool({ activation: null }) }).run(['reset', '--manifest', write('rs5.json', rs)]), 'NOT_ACTIVATED', 'STOP-ENV');
  for (const p of [p2, p3]) assert.equal(p.writes().length, 0);
});

test('binario: --help sale 0; sin --database-url sale 2 e ignora DATABASE_URL heredada; nunca imprime la URL', () => {
  const bin = path.join(__dirname, '..', '..', 'scripts', 'catalog-native.cjs');
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.ok(help.stdout.includes('rebind-chat'));
  const noUrl = spawnSync(process.execPath, [bin, 'inspect', '--environment', 'lab'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://ignored:secret@127.0.0.1:1/ignored' } });
  assert.equal(noUrl.status, 2);
  assert.ok(noUrl.stderr.includes('DATABASE_URL_REQUIRED'));
  assert.ok(!noUrl.stderr.includes('secret') && !noUrl.stdout.includes('secret'));
  const none = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
  assert.equal(none.status, 2); assert.ok(none.stdout.includes('Uso:'));
});
