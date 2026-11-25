'use strict';
// T03 — Contrato del esquema (guard), repositorio sin DB y aislamiento de transporte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mig = require('../../postgres-migrations.js');
const contract = require('../../catalog/contract.js');

const all = mig.listMigrations();
const core = all.find((m) => m.name === '0026_catalog_core.sql');
const withCore = (sql) => [...all.filter((m) => m !== core), { ...core, sql }];

test('0026 (T03), 0027 (T05-N) y 0028 (T06) son las migraciones del catálogo y el guard reconoce el contrato', () => {
  // T05-N añade 0027_catalog_native.sql; T06 añade 0028_catalog_queries.sql (colación ICU, proyecciones, índices). 0026/0027 intactas: checksum del runner.
  assert.equal(all.length, 42);
  assert.deepEqual(all.map((m) => m.version), Array.from({ length: 42 }, (_, i) => String(i + 1).padStart(4, '0')));
  assert.equal(all.at(-1).name, '0042_catalog_reused_bots.sql');
  assert.equal(all.at(-2).name, '0041_catalog_prefix_packs.sql');
  assert.equal(all.at(-3).name, '0040_catalog_autovacuum.sql');
  assert.equal(all.at(-4).name, '0039_catalog_search_gram_counts.sql');
  assert.equal(all.at(-5).name, '0038_catalog_search_indexes.sql');
  assert.equal(all.at(-6).name, '0037_catalog_search_text.sql');
  assert.equal(all.at(-7).name, '0036_catalog_beat_tags_label_stats.sql');
  assert.equal(all.at(-8).name, '0035_catalog_restore.sql');
  assert.equal(all.at(-9).name, '0034_catalog_native_cli.sql');
  assert.equal(all.at(-10).name, '0033_catalog_purge.sql');
  assert.equal(all.at(-11).name, '0032_catalog_playback.sql');
  assert.equal(all.at(-12).name, '0031_catalog_transfer_capabilities.sql');
  assert.equal(all.at(-13).name, '0030_catalog_transfer_operations.sql');
  assert.equal(all.at(-14).name, '0029_catalog_commands.sql');
  assert.equal(all.at(-15).name, '0028_catalog_queries.sql');
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

test('catalog/ no importa transporte ni red', () => {
  const dir = path.join(__dirname, '..', '..', 'catalog');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    // T05-N: ./authority es módulo interno del catálogo (solo SQL + crypto); sigue prohibido importar transporte o red.
    // T06: ./cursor y ./queries son módulos internos (SQL + HMAC); routes.js es el único que requiere express (servidor HTTP, no cliente de red).
    // M4.3: ./library-tx es módulo interno (política de transacción + SQL); sin transporte ni red.
    const allowed = ['crypto', './contract', './beat-projection', './authority', './cursor', './queries', './metadata-rules', './commands', './facets', './name-uniqueness', './library-tx'];
    if (f === 'worker.js') allowed.length = 1; // transporte inyectado, nunca importado
    if (f === 'transport-gateway.js') allowed.length = 1; // T11: solo crypto; el SDK (telegram/big-integer) y el cliente se inyectan
    if (['worker.js', 'library-tx.js', 'direct.js'].includes(f)) allowed.push('./queue');
    if (f === 'queue.js') allowed.splice(0, allowed.length, './authority'); // C7: solo JSON canónico; la conexión se recibe del llamador
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

test('partJobId conserva los IDs sin hash hasta 64 caracteres', () => {
  assert.equal(contract.partJobId('verify', 'op1', 'MASTER:0'), 'job-verify-op1-MASTER_0');
  assert.equal(
    contract.partJobId('verify', 'op1', 'x'.repeat(49)),
    'job-verify-op1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  );
});

test('partJobId conserva los IDs largos con un separador NUL en el hash', () => {
  const { createHash } = require('node:crypto');
  const vectors = [
    ['verify', 'op1', 'x'.repeat(50), 'job-verify-op1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-cd13974834646223'],
    ['reconcile', 'top-' + 'a'.repeat(60), 'FILES:0:0', 'job-reconcile-top-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa-303b16269f9410e6'],
  ];
  const suffix = (input) => createHash('sha256').update(input).digest('hex').slice(0, 16);
  for (const [kind, operationId, partKey, expected] of vectors) {
    const id = contract.partJobId(kind, operationId, partKey);
    assert.equal(id, expected);
    assert.equal(id.slice(-16), suffix(operationId + '\u0000' + partKey));
    assert.notEqual(id.slice(-16), suffix(operationId + partKey));
  }
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

test('E77: el router montado rechaza las rutas retiradas de bytes', async (t) => {
  const { CATALOG_PREFIX, createCatalogRouter } = require('../../catalog/routes.js');
  const resolveContext = t.mock.fn(async () => ({ user_id: 'u1' }));
  const router = createCatalogRouter({
    authority: { resolveContext },
    authenticate: () => ({ id: 'u1' }),
    queries: {}, commands: {}, operations: {}, direct: {}, media: {},
  });
  function dispatch(method, pathname) {
    return new Promise((resolve, reject) => {
      const url = CATALOG_PREFIX + pathname;
      router.handle({ method, url, headers: {} }, {
        setHeader() {},
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); },
      }, (error) => reject(error || new Error('El router no respondió a ' + url)));
    });
  }
  const context = await dispatch('GET', '/context');
  assert.equal(context.status, 200);
  assert.deepEqual(resolveContext.mock.calls[0].arguments, [{ userId: 'u1' }]);

  for (const [method, pathname] of [
    ['PUT', '/transfer/upload/fake-token'],
    ['GET', '/media/fake-token'],
    ['PUT', '/operations/op1/parts/PROJECT:0/project'],
    ['POST', '/operations/op1/parts/MASTER:0/capability'],
  ]) {
    const { status, body } = await dispatch(method, pathname);
    assert.equal(status, 501, method + ' ' + pathname);
    assert.equal(body.code, 'NOT_IMPLEMENTED', method + ' ' + pathname);
  }
});

test('T25: INDEX retirado del runtime — ni rutas legacy de INDEX/transporte/bytes ni módulos INDEX cargados por el servidor', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const code = (f) => read(f).split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
  const core = code('server-core.js'); const server = code('server.js');
  const RETIRED = ['/transport/index/', '/transport/project/', '/transport/session/', '/transport/operation/', '/transport/quota/', '/transport/topic/',
    '/transport/trash/', '/transport/upload/', '/transport/routing/', '/library/upsert', '/library/get', '/library/artwork', '/library/move-to-trash-batch',
    '/library/cleanup-garbage', '/metadata/upsert', '/metadata/artwork', '/beats/upload', '/beats/download', '/beats/stream', '/beats/delete-topic',
    '/cloud-files/upload', '/projects/upload'];
  const calls = [...core.matchAll(/app\.(get|post|put|patch|delete|use)\(\s*["'`]([^"'`]+)/g)].map((m) => m[2]);
  assert.ok(calls.length > 10, 'inventario de rutas de server-core');
  for (const r of RETIRED) assert.equal(calls.some((p) => p.startsWith(r)), false, `server-core.js registra ${r}`);
  for (const m of ['library-index-publication', 'vault-index-pointer-store', 'startup-routing-index', 'atomic-library-index', 'direct-index-pin-authority',
    'project-upload-route', 'project-upload-admission', 'project-upload-authority', 'library-beat-quota', 'library-trash-assets']) {
    assert.equal(fs.existsSync(path.join(root, `${m}.js`)), false, `${m}.js debe estar eliminado`);
    assert.equal(core.includes(`./${m}`) || server.includes(`./${m}`), false, `el runtime no debe cargar ${m}`);
  }
  for (const s of ['ensureAll()', 'recoverAll()', 'publishIndexBuffer', 'UpdatePinnedMessage']) assert.equal(server.includes(s) || core.includes(s), false, `arranque/rutas sin ${s}`);
});

