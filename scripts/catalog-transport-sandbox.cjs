#!/usr/bin/env node
'use strict';
// T11 fase B — runner del sandbox REAL de Telegram (TAREAS §T11; NATIVO r2.1 §8.6, §5.0.3; CONTRATO C7.3–C7.8, C10).
// Ejecuta E2, E4, E5, E6, E8 y E7 (en ese orden) contra recursos de prueba verificados y limpia SOLO los mensajes que creó.
// Cercos (todos antes de cualquier escritura):
//   1. descriptor `scope T11-SANDBOX` vigente (≤ 24 h), `production:false`, + BEATGALER_T11_SANDBOX_APPROVAL = approvalId, + --execute;
//   2. identidad: Bot API getMe del bot = descriptor; sin webhook; MASTER getMe = descriptor;
//   3. aislamiento: cada chat del descriptor tiene EXACTAMENTE {MASTER (creador), bot}; nada más.
// Los secretos (token, api hash, sesiones) solo viven en memoria del proceso; el informe se escanea antes de escribirse y se aborta
// si contiene alguno. La lógica es inyectable (`deps`) para probarla offline con fakes (cloud-server/tests/catalog/…sandbox.test.cjs).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CLOUD = path.join(ROOT, 'cloud-server');
const gateway = require(path.join(CLOUD, 'catalog', 'transport-gateway.js'));

class SandboxStop extends Error { constructor(code, message, exitCode = 3) { super(message); this.name = 'SandboxStop'; this.code = code; this.exitCode = exitCode; } }
const TOKEN_RE = /\d{6,12}:[A-Za-z0-9_-]{30,}/;
const MAX_TTL_MS = 24 * 3600_000;

// ---------- 1. Descriptor + aprobación ----------
function loadDescriptor(descriptorPath, { env = process.env, execute = false, now = Date.now() } = {}) {
  if (!descriptorPath) throw new SandboxStop('STOP-APPROVAL', 'falta --descriptor');
  let d; try { d = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')); } catch (e) { throw new SandboxStop('STOP-APPROVAL', `descriptor ilegible: ${e.message}`); }
  const exp = Date.parse(d && d.expiresAt);
  const okShape = d && d.scope === 'T11-SANDBOX' && typeof d.approvalId === 'string' && d.approvalId.length >= 8 && typeof d.approvedBy === 'string' && d.approvedBy
    && d.production === false && Number.isFinite(exp) && exp > now && exp - now <= MAX_TTL_MS
    && d.bot && /^Bot\d{2}$/.test(d.bot.id) && /^\d{6,12}$/.test(String(d.bot.telegramUserId)) && typeof d.bot.username === 'string'
    && d.master && /^\d{5,15}$/.test(String(d.master.telegramUserId)) && typeof d.master.username === 'string'
    && Array.isArray(d.chats) && d.chats.length > 0 && d.chats.every((c) => /^-100\d{6,16}$/.test(String(c)));
  if (!okShape) throw new SandboxStop('STOP-APPROVAL', 'descriptor incompleto, vencido, con TTL > 24 h o no marcado production:false');
  if (TOKEN_RE.test(JSON.stringify(d))) throw new SandboxStop('STOP-APPROVAL', 'el descriptor no puede contener credenciales');
  if (env.BEATGALER_T11_SANDBOX_APPROVAL !== d.approvalId) throw new SandboxStop('STOP-APPROVAL', 'BEATGALER_T11_SANDBOX_APPROVAL no coincide con approvalId');
  if (!execute) throw new SandboxStop('STOP-APPROVAL', 'descriptor válido; falta --execute (ninguna operación de red ejecutada)', 0);
  return d;
}

// ---------- 2–3. Preflight de identidad y aislamiento (solo lectura) ----------
async function preflight(d, deps) {
  const facts = { bot: {}, master: {}, chats: [] };
  const me = await deps.botApi('getMe');
  facts.bot = { id: String(me.id), username: me.username, is_bot: me.is_bot === true };
  if (facts.bot.id !== String(d.bot.telegramUserId) || facts.bot.username !== d.bot.username || !facts.bot.is_bot) throw new SandboxStop('STOP-ISOLATION', 'el token no pertenece al bot del descriptor');
  const wh = await deps.botApi('getWebhookInfo');
  facts.bot.webhook = Boolean(wh && wh.url);
  if (facts.bot.webhook) throw new SandboxStop('STOP-ISOLATION', 'el bot tiene webhook: otro consumidor posible');
  const m = await deps.master.getMe();
  facts.master = { id: String(m.id), username: m.username, bot: Boolean(m.bot) };
  if (facts.master.id !== String(d.master.telegramUserId) || String(m.username || '').toLowerCase() !== d.master.username.toLowerCase() || m.bot) throw new SandboxStop('STOP-ISOLATION', 'la sesión MASTER no es la cuenta del descriptor');
  for (const chatId of d.chats) {
    const members = await deps.master.chatMembers(chatId);
    const ids = members.map((x) => String(x.id)).sort();
    const want = [facts.master.id, facts.bot.id].sort();
    const creator = members.find((x) => x.role === 'Creator');
    const rec = { chatId, members: members.length, masterIsCreator: Boolean(creator && String(creator.id) === facts.master.id) };
    facts.chats.push(rec);
    if (JSON.stringify(ids) !== JSON.stringify(want) || !rec.masterIsCreator) throw new SandboxStop('STOP-ISOLATION', `chat ${chatId}: miembros distintos de {MASTER creador, bot}`);
  }
  return facts;
}

// ---------- Ledger de mensajes creados (solo esos se limpian) ----------
function createLedger(file) {
  const entries = [];
  return {
    entries,
    add(e) { const row = { at: new Date().toISOString(), ...e }; entries.push(row); if (file) fs.appendFileSync(file, `${JSON.stringify(row)}\n`); return row; },
    ids(chatId) { return entries.filter((e) => e.chatId === chatId && Number.isSafeInteger(e.messageId)).map((e) => e.messageId); },
  };
}

// ---------- Redacción: el informe nunca contiene secretos ----------
function assertNoSecrets(text, secrets = []) {
  if (TOKEN_RE.test(text)) throw new SandboxStop('STOP-SECRET', 'el informe contiene algo con forma de token; no se escribe');
  for (const s of secrets) if (s && String(s).length >= 8 && text.includes(String(s))) throw new SandboxStop('STOP-SECRET', 'el informe contiene un secreto del proceso; no se escribe');
  return true;
}

const errInfo = (e) => (e ? { code: e.code || null, kind: e.classification ? e.classification.kind : null, rpc: e.classification ? e.classification.code : (e.errorMessage || null) } : null);
async function attempt(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: errInfo(e) || { rpc: gateway.classifyError(e).code, kind: gateway.classifyError(e).kind } }; } }

// ---------- Experimentos ----------
async function runSandbox(d, deps, { outDir, dedupDelaysMs = [0, 5000, 65000], rotation = 'botfather', cleanup = true } = {}) {
  const runId = deps.runId || `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const op = (name) => `t11b-${runId}-${name}`;
  const ledger = createLedger(outDir ? path.join(outDir, 'ledger.jsonl') : null);
  const chatId = d.chats[0];
  const report = { scope: 'T11-SANDBOX', approvalId: d.approvalId, runId, evidence: 'PROVIDER_SANDBOX', g2: 'PENDING_VERDICT', startedAt: new Date().toISOString(), sdk: deps.sdkVersion || null, preflight: null, experiments: {}, cleanup: null, notes: [] };
  report.preflight = await preflight(d, deps);
  const botId = report.preflight.bot.id;
  const masterId = report.preflight.master.id;
  const sdk = deps.sdk;

  const botA = await deps.openBot('A'); // sesión MTProto A (auth key propia)
  const gwBot = (client) => gateway.createTelegramGateway({ client, sdk, senderId: botId, botId: d.bot.id, resolvePeer: (c) => deps.resolvePeer(client, c) });
  const gwMaster = gateway.createTelegramGateway({ client: deps.master.client, sdk, senderId: masterId, resolvePeer: (c) => deps.resolvePeer(deps.master.client, c), resolveSenderPeer: (s) => deps.master.senderPeer(s) });
  const file = (name, size, tag) => deps.makeFile(name, size, `${runId}:${tag}`);
  const send = async (gw, who, opName, partKey, f, randomId = gateway.newRandomId()) => {
    const r = await gw.sendPart({ operationId: op(opName), partKey, randomId, chatId, file: f, mimeType: 'audio/wav', fileName: f.name });
    ledger.add({ chatId, messageId: r.messageId, sender: who, op: op(opName), partKey, randomId, size: r.size });
    return r;
  };
  // Verdad de terreno: historial completo leído por MASTER (creador), filtrado por marcador.
  const groundTruth = async (opName, partKey) => (await deps.master.history(chatId, 100)).filter((m) => m.caption === gateway.captionFor({ operationId: op(opName), partKey }));
  const recordTruth = (rows) => { for (const m of rows) if (!ledger.ids(chatId).includes(m.messageId)) ledger.add({ chatId, messageId: m.messageId, sender: m.senderId === botId ? 'bot' : m.senderId === masterId ? 'master' : 'other', op: 'groundtruth', caption: m.caption }); };

  // E6 — recibo vs verificación del proveedor.
  {
    const f = file('e6.wav', 4096, 'e6');
    const r = await send(gwBot(botA.client), 'bot', 'e6', 'm0', f);
    const v = await attempt(() => gwBot(botA.client).verifyMessage({ chatId, messageId: r.messageId }));
    const vm = await attempt(() => gwMaster.verifyMessage({ chatId, messageId: r.messageId, senderId: botId }));
    const mismatch = await attempt(() => gwMaster.verifyMessage({ chatId, messageId: r.messageId }));
    const missing = await attempt(() => gwBot(botA.client).verifyMessage({ chatId, messageId: r.messageId + 100000 }));
    report.experiments.E6 = { receipt: { size: r.size, complete: r.complete, hasDocumentId: Boolean(r.documentId) }, botVerify: v.ok ? { size: v.value.size, documentIdMatches: v.value.documentId === r.documentId } : v.error,
      masterVerifyExpectingBot: vm.ok ? { size: vm.value.size } : vm.error, masterExpectingSelf: mismatch.ok ? 'NO_MISMATCH' : mismatch.error, missingId: missing.ok ? 'FOUND?' : missing.error,
      pass: v.ok && v.value.size === 4096 && v.value.documentId === r.documentId && !mismatch.ok && mismatch.error.code === 'PROVIDER_SENDER_MISMATCH' && !missing.ok };
  }

  // E2 — envío aceptado con respuesta perdida (descartada en la frontera del cliente DESPUÉS del efecto real) → reconciliación.
  for (const [who, gwFor, client] of [['bot', gwBot, botA.client], ['master', () => gwMaster, deps.master.client]]) {
    const lossy = deps.dropResponses(client);
    const gw = who === 'bot' ? gwFor(lossy) : gateway.createTelegramGateway({ client: lossy, sdk, senderId: masterId, resolvePeer: (c) => deps.resolvePeer(client, c), resolveSenderPeer: (s) => deps.master.senderPeer(s) });
    const f = file(`e2-${who}.wav`, 3000, `e2-${who}`);
    const rid = gateway.newRandomId();
    const s = await attempt(() => gw.sendPart({ operationId: op(`e2${who}`), partKey: 'm0', randomId: rid, chatId, file: f, mimeType: 'audio/wav', fileName: f.name }));
    const truth = await groundTruth(`e2${who}`, 'm0'); recordTruth(truth);
    const viaMaster = await attempt(() => gwMaster.searchByRandomId({ chatId, senderId: who === 'bot' ? botId : masterId, declaredSize: 3000, operationId: op(`e2${who}`), partKey: 'm0' }));
    const viaBotSearch = who === 'bot' ? await attempt(() => gwBot(botA.client).searchByRandomId({ chatId, declaredSize: 3000, operationId: op(`e2${who}`), partKey: 'm0' })) : null;
    const viaBotProbe = who === 'bot' ? await attempt(() => deps.probeRecent(botA.client, chatId, { senderId: botId, operationId: op(`e2${who}`), partKey: 'm0', declaredSize: 3000 })) : null;
    report.experiments[`E2_${who}`] = { send: s.ok ? 'RETURNED' : s.error, groundTruthCopies: truth.length,
      reconcileMasterSearch: viaMaster.ok ? { found: viaMaster.value.length, decision: gateway.reconcileDecision(viaMaster.value) } : viaMaster.error,
      reconcileBotSearch: viaBotSearch ? (viaBotSearch.ok ? { found: viaBotSearch.value.length, decision: gateway.reconcileDecision(viaBotSearch.value) } : viaBotSearch.error) : 'N/A',
      reconcileBotIdProbe: viaBotProbe ? (viaBotProbe.ok ? { found: viaBotProbe.value.length, decision: gateway.reconcileDecision(viaBotProbe.value) } : viaBotProbe.error) : 'N/A',
      pass: !s.ok && s.error.code === 'SEND_UNCERTAIN' && truth.length === 1 && viaMaster.ok && gateway.reconcileDecision(viaMaster.value) === 'ADOPT' };
  }

  // E5 — mismo nombre/archivo distinto; mismo tamaño → AMBIGUOUS; otra parte → UNCERTAIN.
  {
    const gw = gwBot(botA.client);
    const a = await send(gw, 'bot', 'e5', 'm0', file('beat.wav', 1000, 'e5a'));
    const b = await send(gw, 'bot', 'e5', 'm0', file('beat.wav', 1200, 'e5b'));
    const s1200 = await gwMaster.searchByRandomId({ chatId, senderId: botId, declaredSize: 1200, operationId: op('e5'), partKey: 'm0' });
    const s1000 = await gwMaster.searchByRandomId({ chatId, senderId: botId, declaredSize: 1000, operationId: op('e5'), partKey: 'm0' });
    await send(gw, 'bot', 'e5', 'm0', file('beat.wav', 1200, 'e5c'));
    const amb = await gwMaster.searchByRandomId({ chatId, senderId: botId, declaredSize: 1200, operationId: op('e5'), partKey: 'm0' });
    const other = await gwMaster.searchByRandomId({ chatId, senderId: botId, declaredSize: 1200, operationId: op('e5'), partKey: 'm1' });
    report.experiments.E5 = { bySize1200: s1200.map((x) => x.messageId === b.messageId), bySize1000: s1000.map((x) => x.messageId === a.messageId), sameSize: gateway.reconcileDecision(amb), otherPart: gateway.reconcileDecision(other), distinctDocuments: a.documentId !== b.documentId,
      pass: s1200.length === 1 && s1200[0].messageId === b.messageId && s1000.length === 1 && s1000[0].messageId === a.messageId && gateway.reconcileDecision(amb) === 'AMBIGUOUS' && gateway.reconcileDecision(other) === 'UNCERTAIN' && a.documentId !== b.documentId };
  }

  // E4 — mismo random_id reenviado: misma sesión, reconexión (misma auth key) y sesión nueva (auth key nueva); por bot y por MASTER.
  report.experiments.E4 = { delaysMs: dedupDelaysMs, bot: [], master: [] };
  for (const who of ['bot', 'master']) {
    for (const delay of dedupDelaysMs) {
      for (const variant of ['same-session', 'reconnect', 'new-auth-key']) {
        if (who === 'master' && variant === 'new-auth-key') continue; // no se crean logins nuevos de la cuenta MASTER
        const name = `e4${who}${variant.replace(/-/g, '')}${delay}`;
        const rid = gateway.newRandomId();
        const first = who === 'bot' ? await send(gwBot(botA.client), 'bot', name, 'm0', file('e4.wav', 2000, `${name}-1`), rid) : await send(gwMaster, 'master', name, 'm0', file('e4.wav', 2000, `${name}-1`), rid);
        if (delay) await deps.sleep(delay);
        let client2 = null;
        if (who === 'bot') client2 = variant === 'same-session' ? botA.client : variant === 'reconnect' ? await deps.restoreBot(botA.saveSession()) : (await deps.openBot(`E4-${name}`)).client;
        else client2 = variant === 'same-session' ? deps.master.client : await deps.master.reconnect();
        const gw2 = who === 'bot' ? gwBot(client2) : gateway.createTelegramGateway({ client: client2, sdk, senderId: masterId, resolvePeer: (c) => deps.resolvePeer(client2, c) });
        const second = await attempt(() => gw2.sendPart({ operationId: op(name), partKey: 'm0', randomId: rid, chatId, file: file('e4.wav', 2000, `${name}-2`), mimeType: 'audio/wav', fileName: 'e4.wav' }));
        const truth = await groundTruth(name, 'm0'); recordTruth(truth);
        const outcome = !second.ok ? (second.error.rpc === 'RANDOM_ID_DUPLICATE' ? 'RANDOM_ID_DUPLICATE' : `ERROR:${second.error.rpc || second.error.code}`) : second.value.messageId === first.messageId ? 'SAME_MESSAGE' : 'NEW_MESSAGE';
        if (second.ok && second.value.messageId !== first.messageId) ledger.add({ chatId, messageId: second.value.messageId, sender: who, op: op(name), partKey: 'm0', randomId: rid });
        report.experiments.E4[who].push({ delayMs: delay, variant, outcome, copies: truth.length });
        if (client2 !== botA.client && client2 !== deps.master.client && client2.disconnect) await client2.disconnect().catch(() => {});
      }
    }
  }
  report.experiments.E4.dedupHolds = [...report.experiments.E4.bot, ...report.experiments.E4.master].every((x) => x.copies === 1);

  // E8 — alcance de una sesión de bot antigua NO revocada (sesión L, auth key distinta de A).
  const botL = await deps.openBot('L');
  {
    const gwL = gwBot(botL.client);
    const own = await send(gwL, 'bot', 'e8', 'm0', file('e8.wav', 1500, 'e8'));
    const masterMsg = await send(gwMaster, 'master', 'e8m', 'm0', file('e8m.wav', 1500, 'e8m'));
    const edit = await attempt(() => deps.editCaption(botL.client, chatId, own.messageId, `${gateway.captionFor({ operationId: op('e8'), partKey: 'm0' })}`));
    const pin = await attempt(() => deps.pin(botL.client, chatId, own.messageId));
    const delOther = await attempt(() => gwBot(botL.client).deleteMessage({ chatId, messageId: masterMsg.messageId }));
    const delOwn = await attempt(() => gwBot(botL.client).deleteMessage({ chatId, messageId: own.messageId }));
    const ownGone = await attempt(() => gwMaster.probeAbsence({ chatId, messageId: own.messageId }));
    const otherGone = await attempt(() => gwMaster.probeAbsence({ chatId, messageId: masterMsg.messageId }));
    report.experiments.E8 = { botRights: deps.botRights ? await deps.botRights(chatId) : null, editOwn: edit.ok ? 'ALLOWED' : edit.error, pinOwn: pin.ok ? 'ALLOWED' : pin.error,
      deleteMasterMessage: delOther.ok ? 'ALLOWED' : delOther.error, deleteOwn: delOwn.ok ? 'ALLOWED' : delOwn.error,
      ownAbsent: ownGone.ok ? ownGone.value.absent : ownGone.error, masterAbsent: otherGone.ok ? otherGone.value.absent : otherGone.error,
      g2Risk: delOwn.ok && ownGone.ok && ownGone.value.absent === true ? 'CONFIRMED: una sesión antigua no revocada borra mensajes propios aunque no tenga derecho admin de borrar' : 'NOT_OBSERVED' };
  }

  // E7 — rotación del token: sesiones MTProto ya emitidas (A, L), sesión restaurada desde su auth key guardada y Bot API con el token viejo.
  if (rotation === 'skip') report.experiments.E7 = { skipped: true };
  else {
    const savedA = botA.saveSession();
    const before = await attempt(() => deps.botApi('getMe'));
    const rot = await deps.rotateToken(); // { verified: true } — el token nuevo queda en memoria y en el pool local; nunca en el informe
    const oldBotApi = await attempt(() => deps.botApiWith(rot.oldToken, 'getMe'));
    const aSend = await attempt(() => gwBot(botA.client).sendPart({ operationId: op('e7a'), partKey: 'm0', randomId: gateway.newRandomId(), chatId, file: file('e7.wav', 1000, 'e7a'), mimeType: 'audio/wav', fileName: 'e7.wav' }));
    if (aSend.ok) ledger.add({ chatId, messageId: aSend.value.messageId, sender: 'bot', op: op('e7a'), partKey: 'm0' });
    const victim = await send(gwMaster, 'master', 'e7v', 'm0', file('e7v.wav', 1000, 'e7v')); // mensaje que una sesión vieja intentaría borrar
    const lDelete = await attempt(() => gwBot(botL.client).deleteMessage({ chatId, messageId: victim.messageId }));
    const restored = await attempt(async () => { const c = await deps.restoreBot(savedA); try { return await deps.getMe(c); } finally { await c.disconnect?.().catch(() => {}); } });
    const fresh = await attempt(async () => { const c = (await deps.openBot('after-rotation')).client; try { const r = await gwBot(c).sendPart({ operationId: op('e7n'), partKey: 'm0', randomId: gateway.newRandomId(), chatId, file: file('e7n.wav', 1000, 'e7n'), mimeType: 'audio/wav', fileName: 'e7n.wav' }); ledger.add({ chatId, messageId: r.messageId, sender: 'bot', op: op('e7n'), partKey: 'm0' }); return r.messageId > 0; } finally { await c.disconnect?.().catch(() => {}); } });
    report.experiments.E7 = { method: rot.method, newTokenVerified: rot.verified === true, oldTokenBeforeRotation: before.ok ? 'OK' : before.error, oldTokenBotApiAfter: oldBotApi.ok ? 'STILL_VALID' : oldBotApi.error,
      openSessionA_sendAfter: aSend.ok ? 'STILL_WORKS' : aSend.error, openSessionL_deleteAfter: lDelete.ok ? 'STILL_WORKS' : lDelete.error,
      restoredAuthKeyA: restored.ok ? 'STILL_WORKS' : restored.error, newTokenSession: fresh.ok ? 'WORKS' : fresh.error,
      revocationClosesIssuedSessions: !oldBotApi.ok && !aSend.ok && !lDelete.ok && !restored.ok, pass: rot.verified === true && !oldBotApi.ok && !aSend.ok && !lDelete.ok && !restored.ok && fresh.ok };
  }
  await botA.client.disconnect?.().catch(() => {});
  await botL.client.disconnect?.().catch(() => {});

  // Limpieza: SOLO mensajes del ledger, borrados por MASTER (creador) y comprobados por ausencia.
  if (cleanup) {
    const ids = [...new Set(ledger.ids(chatId))];
    const res = { requested: ids.length, deleted: 0, absentVerified: 0, refused: [] };
    const current = await deps.master.getMessages(chatId, ids);
    const mine = new RegExp(`^catalog:v1 op=t11b-${runId}-[A-Za-z0-9_-]+ part=`);
    const deletable = current.filter((m) => m && m.caption && mine.test(m.caption)).map((m) => m.messageId);
    res.refused = ids.filter((id) => !deletable.includes(id) && current.some((m) => m && m.messageId === id && m.present));
    if (deletable.length) { await deps.master.deleteMessages(chatId, deletable); res.deleted = deletable.length; }
    for (const id of ids) { const p = await attempt(() => gwMaster.probeAbsence({ chatId, messageId: id })); if (p.ok && p.value.absent) res.absentVerified++; }
    report.cleanup = res;
  }
  report.ledgerCount = ledger.entries.length;
  report.finishedAt = new Date().toISOString();
  return report;
}

function writeReport(report, outDir, secrets) {
  const text = JSON.stringify(report, null, 2);
  assertNoSecrets(text, secrets);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), text);
  return path.join(outDir, 'report.json');
}

function parseArgs(argv) {
  const out = { descriptorPath: null, execute: false, out: null, rotation: 'botfather', delays: [0, 5000, 65000], cleanup: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--descriptor') out.descriptorPath = argv[++i];
    else if (a === '--execute') out.execute = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--rotation') { out.rotation = argv[++i]; if (!['botfather', 'skip'].includes(out.rotation)) throw new SandboxStop('STOP-ENV', 'rotation ∈ botfather|skip', 2); }
    else if (a === '--dedup-delays') out.delays = String(argv[++i]).split(',').map((x) => Number(x) * 1000).filter((x) => Number.isFinite(x) && x >= 0);
    else if (a === '--no-cleanup') out.cleanup = false;
    else throw new SandboxStop('STOP-ENV', `argumento desconocido: ${a}`, 2);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const d = loadDescriptor(args.descriptorPath, { execute: args.execute });
  const runId = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const outDir = args.out || path.join(ROOT, 'tmp', 't11b', `run-${runId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const { createRealDeps } = require('./catalog-transport-sandbox-real.cjs');
  const deps = await createRealDeps(d, { outDir, runId });
  let report;
  try { report = await runSandbox(d, deps, { outDir, dedupDelaysMs: args.delays, rotation: args.rotation, cleanup: args.cleanup }); }
  catch (e) { report = { scope: 'T11-SANDBOX', runId, aborted: e.code || 'ERROR', message: String(e.message || e).replace(TOKEN_RE, '<redacted>') }; }
  finally { await deps.close().catch(() => {}); }
  const p = writeReport(report, outDir, deps.secrets());
  console.log(`informe=${p}${report.aborted ? ` ABORTADO ${report.aborted}` : ''}`);
  return report.aborted ? 1 : 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error(`${e.code || 'ERROR'}: ${String(e.message).replace(TOKEN_RE, '<redacted>')}`); process.exit(e.exitCode ?? 1); });

module.exports = { SandboxStop, loadDescriptor, preflight, createLedger, assertNoSecrets, runSandbox, writeReport, parseArgs, TOKEN_RE };
