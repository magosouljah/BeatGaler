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
  assert.equal(all.length, 29);
  assert.deepEqual(all.map((m) => m.version), Array.from({ length: 29 }, (_, i) => String(i + 1).padStart(4, '0')));
  assert.equal(all.at(-1).name, '0029_catalog_commands.sql');
  assert.equal(all.at(-2).name, '0028_catalog_queries.sql');
  assert.equal(all.at(-3).name, '0027_catalog_native.sql');
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
    const allowed = ['crypto', './contract', './legacy-codec', './migration', './authority', './cursor', './queries', './metadata-rules'];
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
