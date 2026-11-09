'use strict';
// T19-N — Backup y restore PostgreSQL del catálogo nativo (NATIVO r2.1 §11; TAREAS §T19). Única vía de recuperación: no hay importador de
// INDEX ni rollback a LEGACY. Sin AWS ni Telegram real: el almacén de backups, el journal externo y el gateway se inyectan.
//   createBackup      snapshot REPEATABLE READ de las tablas del catálogo + cierre de FKs (users, vaults, …); un archivo NDJSON por tabla con
//                     sha256 y manifiesto escrito al final (marca de commit). Las filas viajan como texto jsonb: sin pasar por números JS.
//   verifyBackup      relee todo y compara tamaño/hash; BACKUP_MISSING / BACKUP_CORRUPT. restore lo ejecuta ANTES de tocar el destino.
//   restoreBackup     en una DB aislada y vacía con las mismas migraciones: solo backups posteriores a la activación (STOP-DATA si no);
//                     restore_hold=true y época+1 en TODAS las bibliotecas, capacidades/concesiones revocadas, leases soltados y una corrida
//                     HELD que impide a los workers reclamar jobs hasta reconciliar (operations.claimJobs).
//   reconcileRestore  journal externo posterior al backup contra SQL y proveedor: nunca marca presente por restaurar una fila.
//   verifyBytes       hash de bytes de cada parte vía gateway.downloadPart.
//   releaseRestoreHold solo con la corrida RECONCILED (delegando en purge.releaseRestoreHold, que además exige cleanup aprobado).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CatalogQueryError } = require('./cursor');

const SCHEMA = 'beatgaler.catalog-backup/1';
const BATCH = 1000;
const BLOCKING = Object.freeze(['UNRECOVERABLE', 'PROVIDER_UNREACHABLE', 'BYTES_MISMATCH', 'BYTES_MISSING']);
class BackupError extends CatalogQueryError {
  constructor(code, message, detail = {}) { super(code, 409, message, detail); this.name = 'BackupError'; }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const qi = (id) => `"${String(id).replace(/"/g, '""')}"`;
const canonical = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));

// ---------- almacenes de backup (solo local/fake; el destino real lo fija el propietario) ----------
function createMemoryBackupStore() {
  const files = new Map();
  return Object.freeze({
    kind: 'memory', files,
    openWriter(name) { const parts = []; return { async write(b) { parts.push(Buffer.from(b)); }, async close() { files.set(name, Buffer.concat(parts)); } }; },
    async *read(name) { const b = files.get(name); if (!b) throw Object.assign(new Error(`missing ${name}`), { code: 'ENOENT' }); for (let i = 0; i < b.length; i += 65536) yield b.subarray(i, i + 65536); },
  });
}
function createFileBackupStore({ dir }) {
  if (typeof dir !== 'string' || !dir) throw new Error('createFileBackupStore requires a directory');
  fs.mkdirSync(dir, { recursive: true });
  const p = (name) => { const r = path.join(dir, ...String(name).split('/')); if (!r.startsWith(path.resolve(dir))) throw new Error('path escapes the backup directory'); return r; };
  return Object.freeze({
    kind: 'file', dir,
    openWriter(name) {
      const file = p(name); fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`; const fd = fs.openSync(tmp, 'w');
      return { async write(b) { fs.writeSync(fd, b); }, async close() { fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, file); } };
    },
    async *read(name) { const file = p(name); const fd = await fs.promises.open(file, 'r'); try { const buf = Buffer.alloc(65536); for (;;) { const { bytesRead } = await fd.read(buf, 0, buf.length, null); if (!bytesRead) break; yield Buffer.from(buf.subarray(0, bytesRead)); } } finally { await fd.close(); } },
  });
}
async function readAll(store, name) { const parts = []; for await (const c of store.read(name)) parts.push(c); return Buffer.concat(parts); }
async function* lines(store, name) {
  let rest = '';
  for await (const c of store.read(name)) { rest += c.toString('utf8'); let i; while ((i = rest.indexOf('\n')) >= 0) { const l = rest.slice(0, i); rest = rest.slice(i + 1); if (l) yield l; } }
  if (rest) yield rest;
}
async function hashFile(store, name) {
  const h = crypto.createHash('sha256'); let size = 0;
  try { for await (const c of store.read(name)) { h.update(c); size += c.length; } } catch (error) { if (error && error.code === 'ENOENT') throw new BackupError('BACKUP_MISSING', `backup file ${name} is missing`, { file: name }); throw error; }
  return { size, sha256: h.digest('hex') };
}

// ---------- descubrimiento de tablas y orden de carga ----------
async function discoverTables(q) {
  const base = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    AND (table_name LIKE 'catalog\\_%' ESCAPE '\\' OR table_name = 'control_plane_flush_quarantine')`)).rows.map((r) => r.table_name);
  const fks = (await q(`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent, condeferrable AS deferrable FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`)).rows;
  const set = new Set(base);
  for (let grew = true; grew;) { grew = false; for (const f of fks) if (set.has(f.child) && !set.has(f.parent)) { set.add(f.parent); grew = true; } }
  const deps = new Map([...set].map((t) => [t, new Set()]));
  for (const f of fks) if (set.has(f.child) && set.has(f.parent) && f.child !== f.parent && !f.deferrable) deps.get(f.child).add(f.parent);
  const ordered = [];
  const left = new Map(deps);
  while (left.size) {
    const ready = [...left.keys()].filter((t) => [...left.get(t)].every((d) => !left.has(d))).sort();
    if (!ready.length) throw new BackupError('BACKUP_FK_CYCLE', 'non-deferrable foreign key cycle among backed-up tables', { tables: [...left.keys()] });
    for (const t of ready) { ordered.push(t); left.delete(t); }
  }
  return ordered;
}
async function columnsOf(q, table) {
  return (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name);
}
const migrationsOf = async (q) => (await q('SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version')).rows.map((r) => ({ version: r.version, checksum_sha256: r.checksum_sha256 }));

function createCatalogBackup({ pool, clock = () => new Date(), randomUUID = () => crypto.randomUUID(), log = () => {} } = {}) {
  if (!pool) throw new Error('createCatalogBackup requires a pool');
  const metrics = { backups: 0, restores: 0, rowsRestored: 0, findings: 0, bytesVerified: 0 };

  // ---------- backup ----------
  async function createBackup({ store, backupId = `bk-${randomUUID()}` } = {}) {
    if (!store) throw new BackupError('BACKUP_STORE_REQUIRED', 'a backup store is required');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(backupId)) throw new BackupError('BACKUP_ID_INVALID', 'invalid backup id');
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const q = (t, p) => client.query(t, p);
      const takenAt = (await q('SELECT clock_timestamp() AS t')).rows[0].t.toISOString();
      const snapshot = (await q('SELECT pg_current_snapshot()::text AS s')).rows[0].s;
      const tables = [];
      for (const table of await discoverTables(q)) {
        const columns = await columnsOf(q, table);
        const w = store.openWriter(`${backupId}/tables/${table}.ndjson`);
        const h = crypto.createHash('sha256'); let size = 0; let rows = 0;
        const cursor = `bk_${crypto.randomBytes(4).toString('hex')}`;
        await q(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS j FROM ${qi(table)} t ORDER BY to_jsonb(t)::text`);
        for (;;) {
          const r = await q(`FETCH ${BATCH} FROM ${cursor}`);
          if (!r.rows.length) break;
          const buf = Buffer.from(r.rows.map((x) => `${x.j}\n`).join(''), 'utf8');
          await w.write(buf); h.update(buf); size += buf.length; rows += r.rows.length;
        }
        await q(`CLOSE ${cursor}`); await w.close();
        tables.push({ name: table, rows, bytes: size, sha256: h.digest('hex'), columns });
      }
      const activation = (await q('SELECT environment_id, manifest_sha256 FROM catalog_native_activation')).rows[0] || null;
      const libraries = (await q('SELECT user_id, authority_epoch::text AS epoch, authority_era::text AS era, restore_hold FROM catalog_libraries ORDER BY user_id')).rows;
      await q('COMMIT');
      const body = { schema: SCHEMA, backup_id: backupId, taken_at: takenAt, snapshot, migrations: await migrationsOf((t, p) => pool.query(t, p)), tables, activation, libraries,
        coverage: 'POSTGRES_METADATA_ONLY: media bytes are NOT in this backup; they live in Telegram and need their own copies' };
      const manifest = { ...body, manifest_sha256: sha(Buffer.from(canonical(body))) };
      const mw = store.openWriter(`${backupId}/manifest.json`); await mw.write(Buffer.from(JSON.stringify(manifest, null, 1))); await mw.close();
      metrics.backups++;
      return { backupId, takenAt, manifestSha256: manifest.manifest_sha256, tables: tables.length, rows: tables.reduce((n, t) => n + t.rows, 0), activated: Boolean(activation) };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  // ---------- verificación del backup ----------
  async function loadManifest(store, backupId) {
    let raw;
    try { raw = await readAll(store, `${backupId}/manifest.json`); } catch (error) { if (error && error.code === 'ENOENT') throw new BackupError('BACKUP_MISSING', 'backup manifest is missing: the backup is incomplete or does not exist', { backupId }); throw error; }
    let m; try { m = JSON.parse(raw.toString('utf8')); } catch { throw new BackupError('BACKUP_CORRUPT', 'manifest is not valid JSON', { backupId }); }
    const { manifest_sha256: declared, ...body } = m;
    if (m.schema !== SCHEMA || !Array.isArray(m.tables) || sha(Buffer.from(canonical(body))) !== declared) throw new BackupError('BACKUP_CORRUPT', 'manifest hash mismatch', { backupId });
    return m;
  }
  async function verifyBackup({ store, backupId } = {}) {
    const m = await loadManifest(store, backupId);
    for (const t of m.tables) {
      const f = await hashFile(store, `${backupId}/tables/${t.name}.ndjson`);
      if (f.size !== t.bytes || f.sha256 !== t.sha256) throw new BackupError('BACKUP_CORRUPT', `table ${t.name} does not match its manifest`, { backupId, table: t.name });
    }
    return { ok: true, backupId, manifestSha256: m.manifest_sha256, tables: m.tables.length, takenAt: m.taken_at };
  }

  // ---------- restore (DB aislada, vacía, mismas migraciones, backup posterior a la activación) ----------
  async function restoreBackup({ store, backupId, restoreId = `rs-${randomUUID()}` } = {}) {
    const t0 = Date.now();
    const v = await verifyBackup({ store, backupId }); // nada se toca en el destino si el backup no verifica
    const m = await loadManifest(store, backupId);
    const tVerify = Date.now() - t0;
    if (!m.activation) throw new BackupError('RESTORE_BEFORE_ACTIVATION', 'STOP-DATA: the backup predates the native activation; restoring it would bring back index_bootstrap_pending and drop layer 0 (NATIVO §11)', { stop: 'STOP-DATA' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = (t, p) => client.query(t, p);
      const here = await migrationsOf(q);
      const same = here.length === m.migrations.length && here.every((x, i) => x.version === m.migrations[i].version && x.checksum_sha256 === m.migrations[i].checksum_sha256);
      if (!same) throw new BackupError('RESTORE_SCHEMA_MISMATCH', 'target migrations differ from the backup (forward-only compatibility: binary and schema must match)', { backup: m.migrations.map((x) => x.version), target: here.map((x) => x.version) });
      const order = await discoverTables(q);
      const backed = new Map(m.tables.map((t) => [t.name, t]));
      if (order.length !== backed.size || order.some((t) => !backed.has(t))) throw new BackupError('RESTORE_SCHEMA_MISMATCH', 'target tables differ from the backup', {});
      for (const t of order) if ((await q(`SELECT 1 FROM ${qi(t)} LIMIT 1`)).rows.length) throw new BackupError('RESTORE_TARGET_NOT_EMPTY', `target table ${t} is not empty: restore only into an isolated empty instance`, { table: t });
      for (const t of order) await q(`ALTER TABLE ${qi(t)} DISABLE TRIGGER USER`);
      let rows = 0;
      for (const t of order) {
        const meta = backed.get(t); const cols = meta.columns.map(qi).join(', ');
        let batch = [];
        const flush = async () => { if (!batch.length) return; await q(`INSERT INTO ${qi(t)} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM jsonb_populate_recordset(NULL::${qi(t)}, $1::jsonb)`, [`[${batch.join(',')}]`]); rows += batch.length; batch = []; };
        for await (const l of lines(store, `${backupId}/tables/${t}.ndjson`)) { batch.push(l); if (batch.length >= BATCH) await flush(); }
        await flush();
        for (const c of (await q(`SELECT column_name, pg_get_serial_sequence($1, column_name) AS seq FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $2`, [qi(t), t])).rows) {
          if (c.seq) await q('SELECT setval($1, greatest(1, coalesce((SELECT max(' + qi(c.column_name) + ') FROM ' + qi(t) + '), 1)))', [c.seq]);
        }
      }
      await q('SET CONSTRAINTS ALL IMMEDIATE'); // las FKs diferidas se validan aquí (y evitan eventos pendientes que impiden el ALTER)
      for (const t of order) await q(`ALTER TABLE ${qi(t)} ENABLE TRIGGER USER`);
      // ---- postura de seguridad del restore ----
      const bumped = (await q('UPDATE catalog_libraries SET restore_hold = true, authority_epoch = authority_epoch + 1, updated_at = now()')).rowCount;
      await q("UPDATE catalog_transfer_capabilities SET status = 'REVOKED', resolved_at = now(), last_error = 'RESTORE' WHERE status IN ('ISSUED', 'REDEEMED')");
      await q("UPDATE catalog_media_grants SET status = 'REVOKED' WHERE status = 'ACTIVE'");
      await q("UPDATE catalog_jobs SET state = 'QUEUED', lease_owner = NULL, lease_until = NULL, next_attempt_at = now() WHERE state = 'LEASED'");
      await q(`INSERT INTO catalog_restore_runs(restore_id, backup_id, manifest_sha256, source_taken_at, status, libraries_epoch_bumped) VALUES ($1, $2, $3, $4, 'HELD', $5)`, [restoreId, backupId, v.manifestSha256, m.taken_at, bumped]);
      await q('COMMIT');
      metrics.restores++; metrics.rowsRestored += rows;
      return { restoreId, status: 'HELD', rows, tables: order.length, librariesEpochBumped: bumped, timings: { verifyMs: tVerify, totalMs: Date.now() - t0 }, backupTakenAt: m.taken_at };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  // ---------- bytes ----------
  async function hashPart(gateway, loc) {
    const h = crypto.createHash('sha256'); let size = 0;
    const it = await gateway.downloadPart({ chatId: loc.chat_id, messageId: loc.message_id });
    for await (const c of it) { h.update(c); size += c.length; }
    return { size, sha256: h.digest('hex') };
  }
  async function addFinding(q, restoreId, userId, objectId, kind, detail = null) {
    metrics.findings++;
    await q(`INSERT INTO catalog_restore_findings(restore_id, user_id, object_id, kind, detail) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (restore_id, user_id, object_id) DO UPDATE SET kind = EXCLUDED.kind, detail = EXCLUDED.detail
      WHERE catalog_restore_findings.kind <> ALL($6::text[]) OR EXCLUDED.kind = ANY($6::text[]) AND catalog_restore_findings.kind IN ('BYTES_MISSING', 'BYTES_MISMATCH')`, [restoreId, userId, objectId, kind, detail && String(detail).slice(0, 900), ['UNRECOVERABLE', 'PROVIDER_UNREACHABLE']]);
  }
  // Verifica por hash los bytes de cada parte PRIMARY conocida cuyo objeto SQL siga PRESENT. Un faltante o discrepancia es un hallazgo bloqueante.
  async function verifyBytes({ gateway, restoreId = null, userId = null } = {}) {
    if (!gateway || typeof gateway.downloadPart !== 'function') throw new BackupError('BYTES_GATEWAY_REQUIRED', 'a gateway with downloadPart is required to verify bytes');
    const parts = (await pool.query(`SELECT l.user_id, l.file_id, l.part_index, l.object_id, o.chat_id, o.message_id::text AS message_id,
        coalesce(p.verified_sha256, p.declared_sha256) AS want_sha, p.size_bytes::text AS want_size
      FROM catalog_part_locations l
      JOIN catalog_media_objects o ON o.user_id = l.user_id AND o.object_id = l.object_id AND o.status = 'PRESENT'
      JOIN catalog_file_parts p ON p.user_id = l.user_id AND p.generation_id = l.generation_id AND p.file_id = l.file_id AND p.part_index = l.part_index
      JOIN catalog_file_versions v ON v.user_id = l.user_id AND v.generation_id = l.generation_id AND v.file_id = l.file_id AND v.status = 'VERIFIED'
      JOIN catalog_libraries lib ON lib.user_id = l.user_id AND lib.active_generation_id = l.generation_id
      WHERE l.location = 'PRIMARY' AND l.reference_class = 'KNOWN' AND ($1::text IS NULL OR l.user_id = $1) ORDER BY l.user_id, l.file_id, l.part_index`, [userId])).rows;
    const report = { checked: 0, ok: 0, mismatches: [], missing: [] };
    for (const p of parts) {
      report.checked++;
      const ref = { userId: p.user_id, fileId: p.file_id, partIndex: p.part_index, objectId: p.object_id };
      try {
        const got = await hashPart(gateway, p);
        metrics.bytesVerified += got.size;
        if (!p.want_sha || got.sha256 !== p.want_sha || (p.want_size != null && String(got.size) !== p.want_size)) {
          report.mismatches.push({ ...ref, expected: p.want_sha, actual: got.sha256 });
          if (restoreId) await addFinding((t, a) => pool.query(t, a), restoreId, p.user_id, p.object_id, 'BYTES_MISMATCH', `${p.file_id}#${p.part_index}`);
        } else report.ok++;
      } catch (error) {
        if (error && (error.code === 'PROVIDER_MESSAGE_NOT_FOUND' || error.status === 404)) {
          report.missing.push(ref);
          if (restoreId) await addFinding((t, a) => pool.query(t, a), restoreId, p.user_id, p.object_id, 'BYTES_MISSING', `${p.file_id}#${p.part_index}`);
        } else throw error; // proveedor inaccesible: no se concluye nada (no es "ausente")
      }
    }
    return report;
  }

  // ---------- reconciliación del journal externo ----------
  async function reconcileJournal({ restoreId, journal, gateway, recoverBytes = null } = {}) {
    if (!journal || typeof journal.list !== 'function') throw new BackupError('JOURNAL_UNAVAILABLE', 'the external deletion journal is required to reconcile a restore');
    const run = (await pool.query('SELECT status FROM catalog_restore_runs WHERE restore_id = $1', [restoreId])).rows[0];
    if (!run) throw new BackupError('RESTORE_RUN_UNKNOWN', 'unknown restore run', { restoreId });
    const q = (t, a) => pool.query(t, a);
    const out = { entries: 0, byKind: {} };
    // el journal es la fuente por objeto: su dictamen reemplaza hallazgos previos de la misma corrida (p. ej. UNRECOVERABLE → BYTES_RESTORED)
    const note = async (uid, oid, kind, detail) => { out.byKind[kind] = (out.byKind[kind] || 0) + 1; await q('DELETE FROM catalog_restore_findings WHERE restore_id = $1 AND user_id = $2 AND object_id = $3', [restoreId, uid, oid]); await addFinding(q, restoreId, uid, oid, kind, detail); };
    const users = (await q('SELECT user_id FROM catalog_libraries ORDER BY user_id')).rows.map((r) => r.user_id);
    for (const uid of users) {
      for (const e of await journal.list(uid)) {
        out.entries++;
        const obj = (await q('SELECT object_id, chat_id, message_id::text AS message_id, status FROM catalog_media_objects WHERE user_id = $1 AND object_id = $2', [uid, e.objectId])).rows[0];
        if (!obj) { await note(uid, e.objectId, 'JOURNAL_NOT_IN_SQL', 'journal entry has no SQL object (created and deleted after the backup)'); continue; }
        if (obj.status === 'DELETED') continue;
        let probe;
        try { probe = await gateway.probeAbsence({ chatId: obj.chat_id, messageId: obj.message_id }); } catch (error) { await note(uid, e.objectId, 'PROVIDER_UNREACHABLE', error && error.code); continue; }
        if (!probe.absent) { await note(uid, e.objectId, 'PRESENT_CONFIRMED', 'journal says deleted but the provider still holds the message'); continue; }
        const live = (await q(`SELECT coalesce(bool_or(b.state = 'ACTIVE'), false) AS live FROM catalog_part_locations l
          JOIN catalog_file_versions v ON v.user_id = l.user_id AND v.generation_id = l.generation_id AND v.file_id = l.file_id
          JOIN catalog_beats b ON b.user_id = v.user_id AND b.generation_id = v.generation_id AND b.beat_id = v.beat_id
          WHERE l.user_id = $1 AND l.object_id = $2`, [uid, e.objectId])).rows[0].live;
        if (!live) { // solo lo referencia papelera/purgado (o nada): el borrado post-backup fue una acción real del usuario
          await q("UPDATE catalog_media_objects SET status = 'DELETED' WHERE user_id = $1 AND object_id = $2", [uid, e.objectId]);
          await note(uid, e.objectId, 'DELETED_CONFIRMED', 'absence proven by the provider and journal entry present');
          continue;
        }
        // referencia viva a bytes eliminados: recuperar de una copia verificada o declararlo irrecuperable (no se marca presente por la fila)
        let restored = false;
        if (typeof recoverBytes === 'function') {
          const src = (await q(`SELECT l.file_id, l.part_index, coalesce(p.verified_sha256, p.declared_sha256) AS want FROM catalog_part_locations l
            JOIN catalog_file_parts p ON p.user_id = l.user_id AND p.generation_id = l.generation_id AND p.file_id = l.file_id AND p.part_index = l.part_index
            WHERE l.user_id = $1 AND l.object_id = $2 LIMIT 1`, [uid, e.objectId])).rows[0];
          const copy = await recoverBytes({ userId: uid, objectId: e.objectId, fileId: src.file_id, partIndex: src.part_index, sha256: src.want, journalEntry: e }).catch((err) => { log('recoverBytes failed', err && err.code, err && err.message); return null; });
          if (copy && copy.chatId && copy.messageId) {
            const got = await hashPart(gateway, { chat_id: String(copy.chatId), message_id: String(copy.messageId) }).catch((err) => { log('copy download failed', err && err.code, err && err.message); return null; });
            if (got && got.sha256 === src.want) {
              await q("UPDATE catalog_media_objects SET chat_id = $3, message_id = $4, status = 'PRESENT', verified_at = now() WHERE user_id = $1 AND object_id = $2", [uid, e.objectId, String(copy.chatId), String(copy.messageId)]);
              restored = true;
            }
          }
        }
        if (restored) await note(uid, e.objectId, 'BYTES_RESTORED', 're-created from a copy whose hash was verified');
        else await note(uid, e.objectId, 'UNRECOVERABLE', 'live beat references deleted bytes and no verified copy exists: reactivation is blocked');
      }
    }
    return out;
  }
  async function finalizeRestore({ restoreId } = {}) {
    const blocking = (await pool.query('SELECT user_id, object_id, kind FROM catalog_restore_findings WHERE restore_id = $1 AND kind = ANY($2::text[]) ORDER BY user_id, object_id', [restoreId, BLOCKING])).rows;
    if (blocking.length) {
      await pool.query("UPDATE catalog_restore_runs SET status = 'BLOCKED' WHERE restore_id = $1 AND status <> 'RECONCILED'", [restoreId]);
      return { restoreId, status: 'BLOCKED', blocking };
    }
    await pool.query("UPDATE catalog_restore_runs SET status = 'RECONCILED', reconciled_at = now() WHERE restore_id = $1", [restoreId]);
    return { restoreId, status: 'RECONCILED', blocking: [] };
  }
  // Reconcilia journal → verifica bytes → dictamina. Re-ejecutable: un BLOCKED vuelve a evaluarse (los hallazgos se reemplazan por objeto).
  async function reconcileRestore({ restoreId, journal, gateway, recoverBytes = null, checkBytes = true } = {}) {
    await pool.query("DELETE FROM catalog_restore_findings WHERE restore_id = $1 AND kind IN ('PROVIDER_UNREACHABLE', 'BYTES_MISSING', 'BYTES_MISMATCH')", [restoreId]);
    const j = await reconcileJournal({ restoreId, journal, gateway, recoverBytes });
    const b = checkBytes ? await verifyBytes({ gateway, restoreId }) : null;
    return { journal: j, bytes: b, ...(await finalizeRestore({ restoreId })) };
  }

  async function openRuns() { return (await pool.query("SELECT restore_id, status FROM catalog_restore_runs WHERE status <> 'RECONCILED' ORDER BY restored_at")).rows; }
  async function releaseRestoreHold({ purge, ...args } = {}) {
    const open = await openRuns();
    if (open.length) throw new BackupError('RESTORE_NOT_RECONCILED', 'restore_hold stays: the restore run has not been reconciled without blocking findings', { runs: open });
    return purge.releaseRestoreHold(args);
  }

  return Object.freeze({ createBackup, verifyBackup, restoreBackup, verifyBytes, reconcileJournal, finalizeRestore, reconcileRestore, openRuns, releaseRestoreHold, metrics, BLOCKING });
}

module.exports = { SCHEMA, BLOCKING, BackupError, createMemoryBackupStore, createFileBackupStore, createCatalogBackup };
