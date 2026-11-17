// LAB REAL: eliminación definitiva (purge) con un beat DESECHABLE creado para la prueba. Garantía de alcance: los ids de mensaje del beat salen del ledger
// (op de su importación); un beat de control sigue intacto; la ausencia se verifica con MASTER (MessageEmpty). Purge solo con beatIds explícitos (nunca ALL_TRASH).
//   . /tmp/realenv2.sh; node scripts/catalog-lab/real-purge.mjs
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { createRequire } from 'node:module';
import { login, importBeat, find, req, E, rec, results } from './real-api.mjs';
const require = createRequire(import.meta.url);
const ROOT = 'E:/777/app/BeatGaler'; const STATE = process.env.LAB_STATE_DIR; const R = `${ROOT}/cloud-server/node_modules/`;
const d = JSON.parse(fs.readFileSync(process.env.LAB_REAL_DESCRIPTOR, 'utf8')); const chat = String(d.chats[0]);
const ledger = () => fs.readFileSync(path.join(STATE, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const kv = {}; for (const l of fs.readFileSync(`${ROOT}/cloud-server/.env.telegram-test`, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); }
const { TelegramClient } = require(R + 'telegram'); const { StringSession } = require(R + 'telegram/sessions');
const master = new TelegramClient(new StringSession(fs.readFileSync(`${ROOT}/cloud-server/master-session.txt`, 'utf8').trim()), Number(kv.TELEGRAM_API_ID), kv.TELEGRAM_API_HASH, { connectionRetries: 3 }); master.setLogLevel?.('none');
const mp3 = (n, tag) => { const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; return Buffer.concat([...Array.from({ length: n }, () => f), Buffer.from(tag)]); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==', 'base64');
try {
  await login(); await master.connect(); const ent = await master.getInputEntity(chat);
  const S = String(Date.now() % 1e6); const nameD = `Desechable ${S}`; const nameC = `Control ${S}`;
  const rD = await importBeat(nameD, [{ role: 'MASTER', bytes: mp3(300, 'D' + S), filename: 'd.mp3', mime: 'audio/mpeg' }, { role: 'ARTWORK', bytes: PNG, filename: 'd.png', mime: 'image/png' }, { role: 'WAV', bytes: crypto.randomBytes(300000), filename: 'd.wav', mime: 'audio/wav' }]);
  const rC = await importBeat(nameC, [{ role: 'MASTER', bytes: mp3(300, 'C' + S), filename: 'c.mp3', mime: 'audio/mpeg' }]);
  const idsOf = (opId) => [...new Set(ledger().filter((r) => r.op === opId && r.messageId).map((r) => Number(r.messageId)))];
  const D = idsOf(rD.op.body.operationId); const C = idsOf(rC.op.body.operationId);
  rec('PURGE-0-SCOPE-FROM-LEDGER', D.length === 3 && C.length === 1 && !D.some((x) => C.includes(x)), { disposableMessages: D.length, controlMessages: C.length });
  const present = async (ids) => (await master.getMessages(ent, { ids })).filter((m) => m && m.className !== 'MessageEmpty' && m.id).map((m) => Number(m.id));
  rec('PURGE-1-PRESENT-BEFORE', (await present(D)).length === 3 && (await present(C)).length === 1, {});
  const beat = await find(nameD);
  const tr = await req('POST', '/catalog/v1/beats/trash', { body: { items: [{ beatId: beat.id, expectedVersion: beat.version }] }, headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
  rec('PURGE-2-TRASHED', tr.status === 200 && !(await find(nameD)) && Boolean(await find(nameD, 'TRASH')), { http: tr.status });
  const pg = await req('POST', '/catalog/v1/operations', { body: { kind: 'PURGE', beatIds: [beat.id] }, headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
  let st = pg.body; for (let i = 0; i < 60 && st && !['PURGED', 'PARTIAL', 'BLOCKED', 'CANCELLED'].includes(st.status); i++) { await new Promise((r) => setTimeout(r, 1500)); st = (await req('GET', `/catalog/v1/operations/${pg.body.operationId}`)).body; }
  rec('PURGE-3-PURGED', pg.status < 300 && st.status === 'PURGED', { accepted: pg.status, final: st.status, op: JSON.stringify(st).slice(0, 900) });
  rec('PURGE-4-DISPOSABLE-MESSAGES-ABSENT', (await present(D)).length === 0, { stillPresent: await present(D) });
  rec('PURGE-5-CONTROL-INTACT', (await present(C)).length === 1 && Boolean(await find(nameC)), {});
  rec('PURGE-6-BEAT-GONE-FROM-CATALOG', !(await find(nameD)) && !(await find(nameD, 'TRASH')), {});
} catch (e) { rec('PURGE-ERROR', false, { message: String(e.message || e).slice(0, 200) }); } finally { await master.disconnect().catch(() => {}); }
console.log(`SUMMARY PASS=${results.filter(Boolean).length} FAIL=${results.filter((x) => !x).length}`);
