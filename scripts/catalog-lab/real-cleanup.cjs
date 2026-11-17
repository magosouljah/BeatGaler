'use strict';
// LAB REAL: limpieza de los mensajes creados por la prueba integrada. SOLO borra mensajes del chat del descriptor T11-SANDBOX que (a) tengan el
// marcador `catalog:v1 op=` en el caption y (b) estén en el ledger de esta prueba o sean posteriores a la línea base registrada al iniciar el LAB.
// Nunca toca ids ≤ línea base (p. ej. los mensajes 12–15 antiguos) ni mensajes sin marcador. Borra con la sesión MASTER (creadora) y verifica ausencia.
//   . /tmp/realenv.sh; node scripts/catalog-lab/real-cleanup.cjs [--execute]      (sin --execute: solo lista)
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lab-env.cjs');
const R = path.join(L.ROOT, 'cloud-server') + '/';
const execute = process.argv.includes('--execute');
const { loadDescriptor } = require(path.join(L.ROOT, 'scripts', 'catalog-transport-sandbox.cjs'));
const d = loadDescriptor(process.env.LAB_REAL_DESCRIPTOR, { env: process.env, execute: true });
const chatId = String(d.chats[0]);
const baseFile = path.join(L.STATE_DIR, process.env.LAB_BASELINE_FILE || 'baseline.orig.json');
if (!fs.existsSync(baseFile)) { console.error('STOP-DATA: sin línea base (baseline.orig.json): no se borra nada'); process.exit(3); }
const baseline = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
if (String(baseline.chatId) !== chatId) { console.error('STOP-ISOLATION: la línea base es de otro chat'); process.exit(3); }
const kv = {}; for (const line of fs.readFileSync(path.join(L.ROOT, 'cloud-server', '.env.telegram-test'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); }
const ledgerFile = path.join(L.STATE_DIR, 'ledger.jsonl');
const ledgerIds = new Set(fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && String(r.chatId) === chatId && Number.isSafeInteger(Number(r.messageId))).map((r) => Number(r.messageId)) : []);
(async () => {
  const { TelegramClient } = require(R + 'node_modules/telegram'); const { StringSession } = require(R + 'node_modules/telegram/sessions');
  const c = new TelegramClient(new StringSession(fs.readFileSync(path.join(L.ROOT, 'cloud-server', 'master-session.txt'), 'utf8').trim()), Number(kv.TELEGRAM_API_ID), kv.TELEGRAM_API_HASH, { connectionRetries: 3 });
  c.setLogLevel?.('none'); await c.connect();
  try {
    const me = await c.getMe(); if (String(me.id) !== String(d.master.telegramUserId)) throw new Error('STOP-ISOLATION: MASTER distinto del descriptor');
    const ent = await c.getInputEntity(chatId);
    const msgs = await c.getMessages(ent, { limit: 400 });
    const mine = msgs.filter((m) => m && Number(m.id) > Number(baseline.lastMessageId) && /^catalog:v1 op=/.test(String(m.message || '')));
    const fromLedger = msgs.filter((m) => m && ledgerIds.has(Number(m.id)) && /^catalog:v1 op=/.test(String(m.message || '')) && Number(m.id) > Number(baseline.lastMessageId));
    const ids = [...new Set([...mine, ...fromLedger].map((m) => Number(m.id)))].sort((a, b) => a - b);
    const untouched = msgs.filter((m) => m && !ids.includes(Number(m.id))).map((m) => Number(m.id)).sort((a, b) => a - b);
    console.log(JSON.stringify({ chatId, baseline: baseline.lastMessageId, inLedger: ledgerIds.size, toDelete: ids.length, untouchedCount: untouched.length, untouchedIdsSample: untouched.slice(0, 20) }));
    if (!execute) { console.log('dry-run: nada borrado (use --execute)'); return; }
    for (let i = 0; i < ids.length; i += 50) await c.deleteMessages(ent, ids.slice(i, i + 50), { revoke: true });
    const after = await c.getMessages(ent, { ids });
    const still = after.filter((m) => m && m.id && !(m.className === 'MessageEmpty')).map((m) => Number(m.id));
    console.log(JSON.stringify({ deleted: ids.length - still.length, stillPresent: still, remainingOwnMarker: (await c.getMessages(ent, { limit: 400 })).filter((m) => m && Number(m.id) > Number(baseline.lastMessageId) && /^catalog:v1 op=/.test(String(m.message || ''))).length }));
  } finally { await c.disconnect().catch(() => {}); }
})().catch((e) => { console.error('ERROR', String(e.message || e).slice(0, 200)); process.exit(1); });
