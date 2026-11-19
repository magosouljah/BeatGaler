'use strict';
// T03 — Contrato del esquema (guard), repositorio sin DB y aislamiento de transporte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mig = require('../../postgres-migrations.js');
const { createCatalogRepository } = require('../../catalog/repository.js');
const contract = require('../../catalog/contract.js');

const all = mig.listMigrations();
const core = all.find((m) => m.name === '0026_catalog_core.sql');
const withCore = (sql) => [...all.filter((m) => m !== core), { ...core, sql }];

test('0026 (T03), 0027 (T05-N) y 0028 (T06) son las migraciones del catálogo y el guard reconoce el contrato', () => {
  // T05-N añade 0027_catalog_native.sql; T06 añade 0028_catalog_queries.sql (colación ICU, proyecciones, índices). 0026/0027 intactas: checksum del runner.
  assert.equal(all.length, 41);
  assert.deepEqual(all.map((m) => m.version), Array.from({ length: 41 }, (_, i) => String(i + 1).padStart(4, '0')));
  assert.equal(all.at(-1).name, '0041_catalog_prefix_packs.sql');
  assert.equal(all.at(-2).name, '0040_catalog_autovacuum.sql');
  assert.equal(all.at(-3).name, '0039_catalog_search_gram_counts.sql');
  assert.equal(all.at(-4).name, '0038_catalog_search_indexes.sql');
  assert.equal(all.at(-5).name, '0037_catalog_search_text.sql');
  assert.equal(all.at(-6).name, '0036_catalog_beat_tags_label_stats.sql');
  assert.equal(all.at(-7).name, '0035_catalog_restore.sql');
  assert.equal(all.at(-8).name, '0034_catalog_native_cli.sql');
  assert.equal(all.at(-9).name, '0033_catalog_purge.sql');
  assert.equal(all.at(-10).name, '0032_catalog_playback.sql');
  assert.equal(all.at(-11).name, '0031_catalog_transfer_capabilities.sql');
  assert.equal(all.at(-12).name, '0030_catalog_transfer_operations.sql');
  assert.equal(all.at(-13).name, '0029_catalog_commands.sql');
  assert.equal(all.at(-14).name, '0028_catalog_queries.sql');
  mig.assertInitialSchemaContract(all);
});

test('el guard rechaza desviaciones del contrato del catálogo', () => {
  const cases = {
    'legacy_json jsonb': core.sql.replace('legacy_json text NOT NULL', 'legacy_json jsonb NOT NULL'),
    'value_json jsonb': core.sql.replace('value_json text NOT NULL', 'value_json jsonb NOT NULL'),
    'authority POSTGRES por defecto': core.sql.replace("authority text NOT NULL DEFAULT 'LEGACY'", "authority text NOT NULL DEFAULT 'POSTGRES'"),
    'cleanup habilitado': core.sql.replace('cleanup_enabled boolean NOT NULL DEFAULT false', 'cleanup_enabled boolean NOT NULL DEFAULT true'),
    'sin FK a vault': core.sql.replace('FOREIGN KEY (user_id, vault_id) REFERENCES vaults(user_id, id)', 'FOREIGN KEY (vault_id) REFERENCES vaults(id)'),
    'tabla ausente': core.sql.replace('CREATE TABLE catalog_part_locations (', 'CREATE TABLE catalog_part_locs ('),
  };
  for (const [label, sql] of Object.entries(cases)) assert.throws(() => mig.assertInitialSchemaContract(withCore(sql)), /catalog/i, label);
  assert.throws(() => mig.assertInitialSchemaContract(withCore(`${core.sql}\nCREATE TABLE beats (id text);`)), /Forbidden authority/, 'beats sigue prohibido');
});

test('el repositorio exige tenant y generación', async () => {
  const pool = { async connect() { return { async query() { return { rows: [{}] }; }, release() {} }; } };
  const repo = createCatalogRepository({ pool });
  await repo.withTransaction(async (t) => {
    await assert.rejects(t.getBeat({ userId: 'u' }, 'b'), { code: 'CATALOG_GENERATION_REQUIRED' });
    await assert.rejects(t.getBeat({ generationId: 'g1' }, 'b'), { code: 'CATALOG_TENANT_REQUIRED' });
    await assert.rejects(t.insertBeat(null, {}), { code: 'CATALOG_TENANT_REQUIRED' });
    await assert.rejects(t.getLibrary(''), { code: 'CATALOG_TENANT_REQUIRED' });
    await assert.rejects(t.createGeneration({ userId: 'u', generationId: 'bad id' }, { snapshotId: 's' }), { code: 'CATALOG_GENERATION_REQUIRED' });
  });
  assert.throws(() => createCatalogRepository({}), { code: 'CATALOG_POOL_REQUIRED' });
});

test('withTransaction usa un único cliente y lo libera también ante error', async () => {
  const log = []; let connects = 0; let releases = 0;
  const pool = { async connect() { connects++; const id = connects; return { async query(t) { log.push([id, t]); if (t === 'BOOM') throw new Error('boom'); return { rows: [] }; }, release() { releases++; } }; } };
  const repo = createCatalogRepository({ pool });
  await repo.withTransaction(async (t) => { await t.query('SELECT 1'); await t.query('SELECT 2'); });
  await assert.rejects(repo.withTransaction(async (t) => { await t.query('BOOM'); }), /boom/);
  await assert.rejects(repo.withTransaction(async () => { throw new Error('app'); }), /app/);
  assert.equal(connects, 3); assert.equal(releases, 3);
  assert.deepEqual(log.filter(([id]) => id === 1).map(([, t]) => t), ['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT 1', 'SELECT 2', 'COMMIT']);
  assert.deepEqual(log.filter(([id]) => id === 2).map(([, t]) => t), ['BEGIN ISOLATION LEVEL READ COMMITTED', 'BOOM', 'ROLLBACK']);
  await assert.rejects(repo.withTransaction(async () => {}, { isolation: 'READ UNCOMMITTED; DROP' }), { code: 'CATALOG_ISOLATION_INVALID' });
});

test('catalog/ no importa transporte ni red', () => {
  const dir = path.join(__dirname, '..', '..', 'catalog');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    // T05-N: ./authority es módulo interno del catálogo (solo SQL + crypto); sigue prohibido importar transporte o red.
    // T06: ./cursor y ./queries son módulos internos (SQL + HMAC); routes.js es el único que requiere express (servidor HTTP, no cliente de red).
    const allowed = ['crypto', './contract', './legacy-codec', './migration', './authority', './cursor', './queries', './metadata-rules', './commands', './facets', './name-uniqueness'];
    if (f === 'worker.js') allowed.length = 1; // worker.js: solo crypto; transporte inyectado, nunca importado
    if (f === 'transport-gateway.js') allowed.length = 1; // T11: solo crypto; el SDK (telegram/big-integer) y el cliente se inyectan
    if (f === 'prefix-packs.js') allowed.push('./transport-gateway'); // E75: solo el marcador del paquete; verificador inyectado; sin fs, SDK ni red
    if (f === 'direct.js') allowed.push('./transport-gateway'); // E70: Direct B; solo caption/identidad del gateway (sin SDK ni red); sesión y vinculación inyectadas
    if (f === 'session-guard.js') allowed.push('./legacy-fence'); // T16: capa 2 reutiliza el error 410 de la capa 1
    if (f === 'native-cli.js') allowed.push('fs', '../legacy-import-executor'); // T17: manifiestos en disco y el id determinista de vault del importador (R12)
    if (f === 'backup.js') allowed.push('fs', 'path'); // T19-N: almacén de backups en disco local (fake/laboratorio); journal, gateway y proveedor inyectados
    if (f === 'routes.js') allowed.push('express');
    for (const r of reqs) assert.ok(allowed.includes(r), `${f} requiere ${r}`);
  }
});

test('beatIdIssues coincide con D-06 y el fixture t01-id-astral', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'catalog', 't01-id-astral.json'), 'utf8'));
  const [ok, tooLong, mixed] = fx.beats.map((b) => b.id);
  assert.deepEqual(contract.beatIdIssues(ok), []);
  assert.ok(contract.beatIdIssues(tooLong).includes('UTF16_LENGTH'));
  assert.ok(contract.beatIdIssues(mixed).includes('UTF16_LENGTH'));
  assert.deepEqual(contract.beatIdIssues(' solo'), ['EDGE_WHITESPACE']);
  assert.ok(contract.beatIdIssues('a\u0000b').includes('NUL'));
  assert.ok(contract.beatIdIssues('x\ud800').includes('LONE_SURROGATE'));
  assert.deepEqual(contract.beatIdIssues(1), ['NOT_STRING']);
  assert.equal(contract.DIRECT_SCOPE_ID_RE.test(ok), false);
});

test('partJobId (T16/V09): ids válidos para catalog_jobs con partKeys del cliente real, distintos por parte y nunca recortados con colisión', () => {
  const { partJobId } = require('../../catalog/contract.js');
  const op = 'top-' + 'a'.repeat(36);
  const ids = ['MASTER:0', 'FILES:0:0', 'FILES:1:0', 'ARTWORK:0', 'PROJECT:0', 'x'.repeat(64)].map((k) => partJobId('verify', op, k));
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/, id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(partJobId('verify', 'op1', 'MASTER:0'), 'job-verify-op1-MASTER_0');
  assert.notEqual(partJobId('verify', op, 'FILES:0:0'), partJobId('verify', op, 'FILES:1:0'));
  assert.notEqual(partJobId('verify', op, 'y'.repeat(60)), partJobId('verify', op, 'y'.repeat(59) + 'z'));
});

// E77 — El Cloud no transporta bytes de archivos: ni rutas, ni métodos del gateway, ni carga del módulo de operador desde el runtime.
test('E77: sin rutas ni métodos de transporte de bytes en el Cloud; el módulo de operador no se carga desde el servidor', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
  const routes = read('catalog', 'routes.js');
  for (const gone of ['/transfer/upload', '/media/:token', '/parts/:partKey/project', '/parts/:partKey/capability', 'req, contentLength', 'stream: req']) assert.equal(routes.includes(gone), false, `routes.js conserva ${gone}`);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'catalog', 'transport.js')), false, 'catalog/transport.js eliminado');
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'catalog-project-master-adapter.js')), false, 'adaptador MASTER de PROJECT eliminado');
  const gateway = require('../../catalog/transport-gateway.js');
  const g = gateway.createTelegramGateway({ client: { invoke: async () => ({}) }, sdk: { Api: {}, bigInt: () => 0 }, senderId: '20', resolvePeer: async () => ({}) });
  assert.deepEqual(Object.keys(g).filter((k) => typeof g[k] === 'function').sort(), ['deleteMessage', 'probeAbsence', 'searchByRandomId', 'verifyMessage'], 'el gateway solo expone RPC de metadatos');
  const runtime = ['server.js', 'server-core.js', 'catalog-worker.js', 'catalog-gateway-runtime.js', ...fs.readdirSync(path.join(__dirname, '..', '..', 'catalog')).filter((f) => f.endsWith('.js')).map((f) => path.join('catalog', f))];
  for (const f of runtime) assert.equal(read(f).split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join(' ').includes('telegram-file-io'), false, `${f} no debe cargar el módulo de operador`);
  const manifest = JSON.parse(read('catalog', 'api-manifest.json'));
  assert.equal(manifest.endpoints.some((e) => ['/transfer/upload', '/media/', '/capability'].some((x) => e.path.includes(x)) || e.path.endsWith('/project')), false, 'el manifiesto no declara rutas de bytes');
});
