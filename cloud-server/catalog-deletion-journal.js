'use strict';
// T15 — Journal externo de borrados (CONTRATO C9: "antes de cada eliminación física escribir evidencia inmutable fuera de la línea de
// restauración de DB … y verificar persistencia. Si falla, no borrar"). Interfaz que consume catalog/purge.js:
//   append(entry) → { ref, sha256 }        escribe una entrada inmutable y devuelve su referencia
//   verify(ref, sha256) → true | false     relee la entrada persistida y comprueba su hash (persistencia demostrada, no asumida)
//   list(userId) → entradas del usuario    reconciliación tras restore (restore_hold)
// Dos adaptadores: en memoria (pruebas; con fallos programables) y en disco (JSON Lines + fsync + relectura). El de disco NO es el
// almacenamiento de backups de producción: su destino lo fija el propietario (C12/G4); hasta entonces el cleanup real sigue apagado.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const canonical = (entry) => JSON.stringify(entry, Object.keys(entry).sort());
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function validateEntry(entry) {
  for (const k of ['userId', 'purgeId', 'objectId', 'chatId', 'messageId', 'beatId']) if (entry == null || entry[k] == null || entry[k] === '') throw Object.assign(new Error(`journal entry requires ${k}`), { code: 'JOURNAL_ENTRY_INVALID' });
  if (JSON.stringify(entry).length > 4096) throw Object.assign(new Error('journal entry too large'), { code: 'JOURNAL_ENTRY_INVALID' });
}

function createMemoryDeletionJournal({ failAppend = () => false, failVerify = () => false, clock = () => Date.now() } = {}) {
  const entries = new Map(); const counters = { appends: 0, verifies: 0, failures: 0 };
  return Object.freeze({
    kind: 'memory',
    async append(entry) {
      validateEntry(entry); counters.appends++;
      if (failAppend(entry)) { counters.failures++; throw Object.assign(new Error('journal storage unavailable'), { code: 'JOURNAL_UNAVAILABLE', transient: true }); }
      const record = { ...entry, at: new Date(clock()).toISOString(), seq: entries.size + 1 };
      const text = canonical(record); const ref = `mem:${record.seq}`;
      entries.set(ref, { text, sha256: sha(text) });
      return { ref, sha256: sha(text) };
    },
    async verify(ref, sha256) { counters.verifies++; if (failVerify(ref)) return false; const e = entries.get(ref); return Boolean(e && e.sha256 === sha256); },
    async list(userId) { return [...entries.entries()].map(([ref, e]) => ({ ref, ...JSON.parse(e.text) })).filter((e) => e.userId === userId); },
    counters, entries,
  });
}

// Disco: un archivo JSON Lines por usuario; cada append escribe, hace fsync y relee la línea para verificar. Nunca sobrescribe.
function createFileDeletionJournal({ dir, clock = () => Date.now() } = {}) {
  if (typeof dir !== 'string' || !dir) throw new Error('createFileDeletionJournal requires a directory');
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (userId) => path.join(dir, `${String(userId).replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);
  const counters = { appends: 0, verifies: 0, failures: 0 };
  return Object.freeze({
    kind: 'file', dir,
    async append(entry) {
      validateEntry(entry); counters.appends++;
      const record = { ...entry, at: new Date(clock()).toISOString(), nonce: crypto.randomBytes(8).toString('hex') };
      const text = canonical(record); const sha256 = sha(text);
      const line = JSON.stringify({ sha256, record: text }) + '\n';
      const fd = await fs.promises.open(fileOf(entry.userId), 'a');
      try { await fd.appendFile(line, 'utf8'); await fd.sync(); } catch (error) { counters.failures++; throw Object.assign(error, { code: 'JOURNAL_UNAVAILABLE', transient: true }); } finally { await fd.close(); }
      return { ref: `file:${path.basename(fileOf(entry.userId))}:${sha256}`, sha256 };
    },
    async verify(ref, sha256) {
      counters.verifies++;
      const m = /^file:([^:]+):([0-9a-f]{64})$/.exec(String(ref)); if (!m || m[2] !== sha256) return false;
      let text; try { text = await fs.promises.readFile(path.join(dir, m[1]), 'utf8'); } catch { return false; }
      return text.split('\n').some((l) => { if (!l) return false; try { const j = JSON.parse(l); return j.sha256 === sha256 && sha(j.record) === sha256; } catch { return false; } });
    },
    async list(userId) {
      let text; try { text = await fs.promises.readFile(fileOf(userId), 'utf8'); } catch { return []; }
      return text.split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return { ref: `file:${path.basename(fileOf(userId))}:${j.sha256}`, ...JSON.parse(j.record) }; });
    },
    counters,
  });
}

module.exports = { createMemoryDeletionJournal, createFileDeletionJournal, validateEntry };
