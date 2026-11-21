'use strict';
// T19-N — pruebas unitarias sin base de datos: almacenes de backup, verificación de manifiesto y fallos (BACKUP_MISSING/CORRUPT).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const b = require('../../catalog/backup.js');

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
async function put(store, name, text) { const w = store.openWriter(name); await w.write(Buffer.from(text)); await w.close(); }
async function sample(store) {
  const rows = '{"a":1}\n{"a":2}\n';
  await put(store, 'bk/tables/t.ndjson', rows);
  const body = { schema: b.SCHEMA, backup_id: 'bk', taken_at: new Date(0).toISOString(), snapshot: '1:1:', migrations: [], tables: [{ name: 't', rows: 2, bytes: rows.length, sha256: sha(rows), columns: ['a'] }], activation: null, libraries: [] };
  await put(store, 'bk/manifest.json', JSON.stringify({ ...body, manifest_sha256: sha(Buffer.from(canon(body))) }));
}
const svc = () => b.createCatalogBackup({ pool: {} });

test('verifyBackup acepta un backup íntegro en memoria y en disco', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t19u-'));
  try {
    for (const store of [b.createMemoryBackupStore(), b.createFileBackupStore({ dir })]) { await sample(store); assert.equal((await svc().verifyBackup({ store, backupId: 'bk' })).ok, true); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manifiesto o tabla ausente = BACKUP_MISSING; contenido o manifiesto alterado = BACKUP_CORRUPT', async () => {
  const cases = {
    'sin manifiesto': [(s) => s.files.delete('bk/manifest.json'), 'BACKUP_MISSING'],
    'sin tabla': [(s) => s.files.delete('bk/tables/t.ndjson'), 'BACKUP_MISSING'],
    'tabla alterada': [(s) => s.files.set('bk/tables/t.ndjson', Buffer.from('{"a":9}\n{"a":2}\n')), 'BACKUP_CORRUPT'],
    'manifiesto alterado': [(s) => s.files.set('bk/manifest.json', Buffer.from(s.files.get('bk/manifest.json').toString().replace('"rows":2', '"rows":3'))), 'BACKUP_CORRUPT'],
    'manifiesto no JSON': [(s) => s.files.set('bk/manifest.json', Buffer.from('{')), 'BACKUP_CORRUPT'],
  };
  for (const [label, [mutate, code]] of Object.entries(cases)) {
    const store = b.createMemoryBackupStore(); await sample(store); mutate(store);
    await assert.rejects(svc().verifyBackup({ store, backupId: 'bk' }), (e) => { assert.equal(e.code, code, label); return true; });
  }
});

test('el almacén de archivos no escribe fuera de su directorio y no deja parciales visibles (rename al cerrar)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t19u-'));
  try {
    const store = b.createFileBackupStore({ dir });
    assert.throws(() => store.openWriter('../evil'), /escapes/);
    const w = store.openWriter('x/y.bin'); await w.write(Buffer.from('abc'));
    assert.equal(fs.existsSync(path.join(dir, 'x', 'y.bin')), false, 'sin cerrar no existe el archivo final');
    await w.close(); assert.equal(fs.readFileSync(path.join(dir, 'x', 'y.bin'), 'utf8'), 'abc');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('finalizeRestore bloquea cada hallazgo crítico y reconcilia los informativos', async () => {
  const cases = {
    BYTES_MISMATCH: 'BLOCKED',
    BYTES_MISSING: 'BLOCKED',
    PROVIDER_UNREACHABLE: 'BLOCKED',
    UNRECOVERABLE: 'BLOCKED',
    PRESENT_CONFIRMED: 'RECONCILED',
    DELETED_CONFIRMED: 'RECONCILED',
    BYTES_RESTORED: 'RECONCILED',
    JOURNAL_NOT_IN_SQL: 'RECONCILED',
  };
  for (const [kind, status] of Object.entries(cases)) {
    const finding = { user_id: 'u1', object_id: 'obj1', kind };
    const runs = new Map([['restore-1', 'HELD'], ['otro-restore', 'HELD']]);
    const pool = {
      async query(sql, [id, kinds]) {
        if (sql.includes('FROM catalog_restore_findings')) {
          return { rows: id === 'restore-1' && kinds.includes(kind) ? [finding] : [] };
        }
        const update = /^UPDATE catalog_restore_runs SET status = '(BLOCKED|RECONCILED)'/.exec(sql);
        assert.ok(update && runs.has(id), sql);
        runs.set(id, update[1]);
        return { rows: [], rowCount: 1 };
      },
    };
    const result = await b.createCatalogBackup({ pool }).finalizeRestore({ restoreId: 'restore-1' });
    assert.deepEqual(result, {
      restoreId: 'restore-1', status, blocking: status === 'BLOCKED' ? [finding] : [],
    }, kind);
    assert.equal(runs.get('restore-1'), status, kind);
    assert.equal(runs.get('otro-restore'), 'HELD', kind);
  }
});
