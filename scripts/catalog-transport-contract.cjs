#!/usr/bin/env node
'use strict';
// T11 — Harness del contrato real de Telegram (TAREAS §T11 pasos 1–5; NATIVO r2.1 §8.6 y §5.0.3; CONTRATO C7.3–C7.8, C10).
// Modo `fake` (por defecto): experimentos cerrados contra un servidor Telegram fake con la forma exacta del SDK instalado
// (`telegram` 2.26.x), sin red. Sus resultados son HIPÓTESIS (evidence=FAKE), nunca G2.
// Modo `sandbox`: cerrado por STOP-APPROVAL. Exige un descriptor de sandbox autorizado y la variable
// BEATGALER_T11_SANDBOX_APPROVAL igual a su approvalId. Este commit NO implementa el cliente real: aunque la aprobación exista,
// termina en STOP-ENV sin tocar red. Nunca lee `.env` ni credenciales.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CLOUD = path.join(ROOT, 'cloud-server');
const gateway = require(path.join(CLOUD, 'catalog', 'transport-gateway.js'));
const { createFakeTelegramServer } = require(path.join(CLOUD, 'tests', 'helpers', 'catalog-fake-mtproto.cjs'));

class HarnessStop extends Error { constructor(code, message, exitCode) { super(message); this.name = 'HarnessStop'; this.code = code; this.exitCode = exitCode; } }

function loadSdk() {
  const telegram = require(path.join(CLOUD, 'node_modules', 'telegram'));
  const bigInt = require(path.join(CLOUD, 'node_modules', 'big-integer'));
  return { Api: telegram.Api, bigInt };
}
// Paso 1: versiones exactas y hashes del lock, solo lectura. No se cambia el SDK para evitar un resultado rojo.
function sdkRecord() {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLOUD, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(CLOUD, 'package-lock.json'), 'utf8'));
  const installed = JSON.parse(fs.readFileSync(path.join(CLOUD, 'node_modules', 'telegram', 'package.json'), 'utf8'));
  let runtimeVersion = null;
  try { runtimeVersion = require(path.join(CLOUD, 'node_modules', 'telegram', 'Version')).version || null; } catch (_) { runtimeVersion = null; }
  const entry = (name) => { const p = lock.packages && lock.packages[`node_modules/${name}`]; return p ? { version: p.version, integrity: p.integrity } : null; };
  return {
    declared: pkg.dependencies && pkg.dependencies.telegram,
    installed: installed.version,
    runtimeVersionField: runtimeVersion,
    versionFieldMismatch: runtimeVersion != null && runtimeVersion !== installed.version,
    lock: { telegram: entry('telegram'), 'big-integer': entry('big-integer') },
    lockfileSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(CLOUD, 'package-lock.json'))).digest('hex'),
    node: process.version,
  };
}

const bot = { senderId: '20' };
const channelPeer = (sdk) => new sdk.Api.InputPeerChannel({ channelId: sdk.bigInt('1001'), accessHash: sdk.bigInt('7') });
const userPeer = (sdk) => new sdk.Api.InputPeerUser({ userId: sdk.bigInt('555'), accessHash: sdk.bigInt('9') });
const file = (name, content) => ({ name, buffer: Buffer.from(content) });
function mkGateway(sdk, client, { channel = true, senderId = bot.senderId } = {}) {
  return gateway.createTelegramGateway({ client, sdk, senderId, resolvePeer: async () => ({ peer: channel ? channelPeer(sdk) : userPeer(sdk), channel }) });
}

// Cada experimento devuelve { outcome, details }. outcome ∈ PASS_FAKE | REQUIRES_SANDBOX | FAIL.
const EXPERIMENTS = [
  {
    id: 'E1', step: 1, title: 'Identidad explícita: random_id int64 persistido se pasa al SDK y se serializa; caption no ambiguo',
    expected: 'PASS_FAKE',
    async run({ sdk }) {
      const ids = ['-9223372036854775808', '9223372036854775807', '0', '-1', gateway.newRandomId()];
      const bytes = ids.map((rid) => gateway.buildSendMedia(sdk, { peer: channelPeer(sdk), inputFile: new sdk.Api.InputFile({ id: sdk.bigInt('1'), parts: 1, name: 'a.wav', md5Checksum: '' }), mimeType: 'audio/wav', fileName: 'a.wav', caption: gateway.captionFor({ operationId: 'top-1', partKey: 'm0' }), randomId: rid }).getBytes().length);
      const roundtrip = ids.every((rid) => gateway.longToText(gateway.randomIdToLong(rid, sdk.bigInt)) === rid);
      let outOfRange = false; try { gateway.randomIdToLong('9223372036854775808', sdk.bigInt); } catch (e) { outOfRange = e.code === 'RANDOM_ID_INVALID'; }
      const caption = gateway.captionFor({ operationId: 'top-abc', partKey: 'f1' });
      const parsed = gateway.parseCaption(caption);
      const ok = roundtrip && outOfRange && new Set(bytes).size === 1 && parsed.operationId === 'top-abc' && parsed.partKey === 'f1' && gateway.parseCaption('catalog:v1 op=top-abc part=f1 extra') === null;
      return { outcome: ok ? 'PASS_FAKE' : 'FAIL', details: { ids: ids.length, serializedBytes: bytes[0], roundtrip, outOfRange, caption } };
    },
  },
  {
    id: 'E2', step: 2, title: 'Envío aceptado con respuesta perdida → UNCERTAIN → RECONCILE encuentra exactamente 1 → adopta sin reenviar',
    expected: 'PASS_FAKE',
    async run({ sdk }) {
      const server = createFakeTelegramServer(); const client = server.session({ selfId: bot.senderId }); const gw = mkGateway(sdk, client);
      const rid = gateway.newRandomId();
      client.script({ type: 'loseResponse' });
      let err = null; try { await gw.sendPart({ operationId: 'top-e2', partKey: 'm0', randomId: rid, chatId: '1001', file: file('a.wav', 'x'.repeat(1000)), mimeType: 'audio/wav', fileName: 'a.wav' }); } catch (e) { err = e; }
      const found = await gw.searchByRandomId({ chatId: '1001', declaredSize: 1000, operationId: 'top-e2', partKey: 'm0' });
      const decision = gateway.reconcileDecision(found);
      const ok = err?.code === 'SEND_UNCERTAIN' && err.classification.action === 'RECONCILE' && err.resend === false && server.counters().sends === 1 && server.messages().length === 1 && decision === 'ADOPT' && found[0].size === 1000;
      return { outcome: ok ? 'PASS_FAKE' : 'FAIL', details: { error: err?.code, decision, sends: server.counters().sends, messages: server.messages().length } };
    },
  },
  {
    id: 'E3', step: 2, title: 'FLOOD_WAIT es un rechazo explícito sin efecto: Retry-After y reintento con la MISMA identidad (ASSUMED por protocolo)',
    expected: 'PASS_FAKE',
    async run({ sdk }) {
      const server = createFakeTelegramServer(); const client = server.session({ selfId: bot.senderId }); const gw = mkGateway(sdk, client);
      const rid = gateway.newRandomId(); const part = { operationId: 'top-e3', partKey: 'm0', randomId: rid, chatId: '1001', file: file('a.wav', 'y'.repeat(10)), mimeType: 'audio/wav', fileName: 'a.wav' };
      client.script({ type: 'flood', seconds: 37 });
      let err = null; try { await gw.sendPart(part); } catch (e) { err = e; }
      const afterReject = server.messages().length;
      const receipt = await gw.sendPart(part);
      const ok = err?.code === 'SEND_REJECTED' && err.retryAfterMs === 37_000 && err.classification.kind === 'REJECTED' && afterReject === 0 && receipt.messageId > 0 && receipt.size === 10 && server.messages().length === 1 && server.messages()[0].randomId === rid;
      return { outcome: ok ? 'PASS_FAKE' : 'FAIL', details: { error: err?.code, retryAfterMs: err?.retryAfterMs, messagesAfterReject: afterReject, messagesAfterRetry: server.messages().length, evidence: 'ASSUMED: un error RPC explícito implica que no hubo efecto; confirmar en sandbox' } };
    },
  },
  {
    id: 'E4', step: 2, title: 'Reinicio/reconexión y reenvío con el mismo random_id: la deduplicación del proveedor NO está probada → ambigüedad → BLOCKED',
    expected: 'REQUIRES_SANDBOX',
    async run({ sdk }) {
      // Hipótesis pesimista (dedupWindowMs=null): el proveedor crea un segundo mensaje → 2 coincidencias → AMBIGUOUS.
      const pess = createFakeTelegramServer({ dedupWindowMs: null }); const c1 = pess.session({ selfId: bot.senderId }); const g1 = mkGateway(sdk, c1);
      const rid = gateway.newRandomId(); const part = { operationId: 'top-e4', partKey: 'm0', randomId: rid, chatId: '1001', file: file('a.wav', 'z'.repeat(50)), mimeType: 'audio/wav', fileName: 'a.wav' };
      c1.script({ type: 'loseResponse' });
      try { await g1.sendPart(part); } catch (_) { /* respuesta perdida */ }
      const c1b = pess.session({ selfId: bot.senderId }); const g1b = mkGateway(sdk, c1b); // "reinicio": nueva sesión, misma identidad
      await g1b.sendPart(part);
      const pessFound = await g1b.searchByRandomId({ chatId: '1001', declaredSize: 50, operationId: 'top-e4', partKey: 'm0' });
      // Hipótesis optimista (ventana 60 s): el proveedor devuelve el mismo mensaje → 1 coincidencia.
      const opt = createFakeTelegramServer({ dedupWindowMs: 60_000 }); const c2 = opt.session({ selfId: bot.senderId }); const g2 = mkGateway(sdk, c2);
      c2.script({ type: 'loseResponse' });
      try { await g2.sendPart(part); } catch (_) { /* respuesta perdida */ }
      await mkGateway(sdk, opt.session({ selfId: bot.senderId })).sendPart(part);
      const optFound = await g2.searchByRandomId({ chatId: '1001', declaredSize: 50, operationId: 'top-e4', partKey: 'm0' });
      const consistent = gateway.reconcileDecision(pessFound) === 'AMBIGUOUS' && gateway.reconcileDecision(optFound) === 'ADOPT' && gateway.RESEND_POLICY.uncertain === 'BLOCKED';
      return { outcome: consistent ? 'REQUIRES_SANDBOX' : 'FAIL', details: { pessimistic: { messages: pess.messages().length, decision: gateway.reconcileDecision(pessFound) }, optimistic: { messages: opt.messages().length, decision: gateway.reconcileDecision(optFound) }, rule: 'C7.8: sin prueba real de deduplicación por random_id para esta identidad/SDK/sesión, el reenvío queda BLOCKED; la ventana real se mide en sandbox y no se extrapola' } };
    },
  },
  {
    id: 'E5', step: 2, title: 'Recibos duplicados / varias coincidencias / mismo nombre con archivo distinto: tamaño discrimina; igual tamaño → AMBIGUOUS',
    expected: 'PASS_FAKE',
    async run({ sdk }) {
      const server = createFakeTelegramServer(); const client = server.session({ selfId: bot.senderId }); const gw = mkGateway(sdk, client);
      const a = await gw.sendPart({ operationId: 'top-e5', partKey: 'm0', randomId: gateway.newRandomId(), chatId: '1001', file: file('beat.wav', 'a'.repeat(100)), mimeType: 'audio/wav', fileName: 'beat.wav' });
      const b = await gw.sendPart({ operationId: 'top-e5', partKey: 'm0', randomId: gateway.newRandomId(), chatId: '1001', file: file('beat.wav', 'b'.repeat(120)), mimeType: 'audio/wav', fileName: 'beat.wav' }); // mismo nombre, archivo distinto
      const bySize = await gw.searchByRandomId({ chatId: '1001', declaredSize: 120, operationId: 'top-e5', partKey: 'm0' });
      const other = await gw.searchByRandomId({ chatId: '1001', declaredSize: 100, operationId: 'top-e5', partKey: 'm0' });
      await gw.sendPart({ operationId: 'top-e5', partKey: 'm0', randomId: gateway.newRandomId(), chatId: '1001', file: file('beat.wav', 'c'.repeat(120)), mimeType: 'audio/wav', fileName: 'beat.wav' }); // mismo tamaño que b
      const ambiguous = await gw.searchByRandomId({ chatId: '1001', declaredSize: 120, operationId: 'top-e5', partKey: 'm0' });
      const otherPart = await gw.searchByRandomId({ chatId: '1001', declaredSize: 120, operationId: 'top-e5', partKey: 'm1' });
      const ok = bySize.length === 1 && bySize[0].messageId === b.messageId && other.length === 1 && other[0].messageId === a.messageId && gateway.reconcileDecision(ambiguous) === 'AMBIGUOUS' && gateway.reconcileDecision(otherPart) === 'UNCERTAIN' && a.documentId !== b.documentId;
      return { outcome: ok ? 'PASS_FAKE' : 'FAIL', details: { bySize: bySize.length, other: other.length, ambiguous: ambiguous.length, otherPart: otherPart.length } };
    },
  },
  {
    id: 'E6', step: 3, title: 'Recibo del cliente ≠ verificación del proveedor: tamaño/remitente se leen del proveedor; hash declarado no autoriza',
    expected: 'PASS_FAKE',
    async run({ sdk }) {
      const server = createFakeTelegramServer(); const client = server.session({ selfId: bot.senderId }); const gw = mkGateway(sdk, client);
      const r = await gw.sendPart({ operationId: 'top-e6', partKey: 'm0', randomId: gateway.newRandomId(), chatId: '1001', file: file('a.wav', 'q'.repeat(999)), mimeType: 'audio/wav', fileName: 'a.wav' });
      const v = await gw.verifyMessage({ chatId: '1001', messageId: r.messageId });
      let notFound = null; try { await gw.verifyMessage({ chatId: '1001', messageId: r.messageId + 50 }); } catch (e) { notFound = e; }
      const otherBot = mkGateway(sdk, server.session({ selfId: '21' }), { senderId: '21' });
      let mismatch = null; try { await otherBot.verifyMessage({ chatId: '1001', messageId: r.messageId }); } catch (e) { mismatch = e; }
      const ok = v.size === 999 && v.sha256 === null && v.provider === 'telegram' && v.documentId === r.documentId && notFound?.code === 'PROVIDER_MESSAGE_NOT_FOUND' && notFound.transient === false && mismatch?.code === 'PROVIDER_SENDER_MISMATCH';
      return { outcome: ok ? 'PASS_FAKE' : 'FAIL', details: { providerSize: v.size, remoteSha256: v.sha256, notFound: notFound?.code, senderMismatch: mismatch?.code, note: 'recordVerification (T09) compara size proveedor vs declarado → VERIFICATION_MISMATCH si difieren; sha256 remoto no se calcula sin descargar bytes' } };
    },
  },
  {
    id: 'E7', step: 4, title: 'Revocación del token: las sesiones Bot API/MTProto ya abiertas (auth key emitida) deben quedar cerradas → FENCE_REVOKED',
    expected: 'REQUIRES_SANDBOX',
    async run({ sdk }) {
      const server = createFakeTelegramServer(); const oldSession = server.session({ selfId: bot.senderId }); const gwOld = mkGateway(sdk, oldSession);
      const r = await gwOld.sendPart({ operationId: 'top-e7', partKey: 'm0', randomId: gateway.newRandomId(), chatId: '1001', file: file('a.wav', 'r'.repeat(10)), mimeType: 'audio/wav', fileName: 'a.wav' });
      server.revokeBot(bot.senderId); // hipótesis: la revocación invalida TODAS las sesiones del bot, incluidas las ya abiertas
      let send = null; try { await gwOld.sendPart({ operationId: 'top-e7', partKey: 'm1', randomId: gateway.newRandomId(), chatId: '1001', file: file('b.wav', 's'), mimeType: 'audio/wav', fileName: 'b.wav' }); } catch (e) { send = e; }
      let del = null; try { await oldSession.invoke({ className: 'channels.DeleteMessages', id: [r.messageId] }); } catch (e) { del = gateway.classifyError(e); }
      const modeled = send?.code === 'CREDENTIAL_REVOKED' && send.transient === false && del?.kind === 'REVOKED' && server.messages().length === 1;
      return { outcome: modeled ? 'REQUIRES_SANDBOX' : 'FAIL', details: { modeledSend: send?.code, modeledDelete: del?.kind, retainedMessages: server.messages().length, mustProve: ['sesión MTProto con auth key previa', 'Bot API getUpdates/sendDocument con token viejo', 'bot compartido de laboratorio entre vaults', 'efecto de rotación (nuevo token) vs revocación'], reference: 'NATIVO r2.1 §5.0.3 / CONTRATO C10 (G2 falla si un cliente antiguo puede destruir medios retenidos)' } };
    },
  },
  {
    id: 'E8', step: 4, title: 'Alcance de una sesión antigua NO revocada: puede borrar mensajes propios (riesgo G2) → cercado fail-closed hasta revocar',
    expected: 'REQUIRES_SANDBOX',
    async run({ sdk }) {
      const server = createFakeTelegramServer({ legacyCanDelete: true }); const gw = mkGateway(sdk, server.session({ selfId: bot.senderId }));
      const r = await gw.sendPart({ operationId: 'top-e8', partKey: 'm0', randomId: gateway.newRandomId(), chatId: '1001', file: file('a.wav', 't'.repeat(10)), mimeType: 'audio/wav', fileName: 'a.wav' });
      const legacy = server.session({ selfId: bot.senderId }); // cliente antiguo con las mismas credenciales, sin revocar
      const res = await legacy.invoke({ className: 'channels.DeleteMessages', id: [r.messageId] });
      const destroyed = res.ptsCount === 1 && server.messages().length === 0;
      return { outcome: destroyed ? 'REQUIRES_SANDBOX' : 'FAIL', details: { legacyDeletedRetainedMessage: destroyed, consequence: 'Quitar permisos admin no impide borrar mensajes propios (ASSUMED): el cercado efectivo exige revocar/rotar credenciales y apagar procesos antiguos ANTES de activar (C10, §5.0.3). Sin esa prueba, G2 = FAIL.' } };
    },
  },
  {
    id: 'E9', step: 2, title: 'Direct (canal/vault) y MASTER PROJECT (usuario): formas TL de envío, búsqueda y lectura por tipo de peer',
    expected: 'PASS_FAKE',
    async run({ sdk }) {
      const inputFile = new sdk.Api.InputFile({ id: sdk.bigInt('1'), parts: 1, name: 'p.zip', md5Checksum: '' });
      const caption = gateway.captionFor({ operationId: 'top-e9', partKey: 'p0' });
      const ch = gateway.buildSendMedia(sdk, { peer: channelPeer(sdk), inputFile, mimeType: 'application/zip', fileName: 'p.zip', caption, randomId: '5' });
      const us = gateway.buildSendMedia(sdk, { peer: userPeer(sdk), inputFile, mimeType: 'application/zip', fileName: 'p.zip', caption, randomId: '5' });
      const sCh = gateway.buildSearch(sdk, { peer: channelPeer(sdk), caption, limit: 500 });
      const gCh = gateway.buildGetMessages(sdk, { peer: channelPeer(sdk), messageId: 7, channel: true });
      const gUs = gateway.buildGetMessages(sdk, { peer: userPeer(sdk), messageId: 7, channel: false });
      const ok = ch.className === 'messages.SendMedia' && us.className === 'messages.SendMedia' && ch.media.forceFile === true && ch.media.attributes[0].fileName === 'p.zip' && sCh.className === 'messages.Search' && sCh.limit === 100 && sCh.filter.className === 'InputMessagesFilterDocument' && gCh.className === 'channels.GetMessages' && gUs.className === 'messages.GetMessages' && ch.getBytes().length > 0 && sCh.getBytes().length > 0 && gCh.getBytes().length > 0 && gUs.getBytes().length > 0;
      return { outcome: ok ? 'PASS_FAKE' : 'FAIL', details: { send: ch.className, search: sCh.className, getChannel: gCh.className, getUser: gUs.className } };
    },
  },
  {
    id: 'E10', step: 1, title: 'Registro del SDK instalado: versión declarada/instalada/campo Version, integridad del lock, sin cambios de SDK',
    expected: 'PASS_FAKE',
    async run() {
      const rec = sdkRecord();
      const ok = typeof rec.installed === 'string' && /^2\.26\./.test(rec.installed) && rec.lock.telegram && /^sha512-/.test(rec.lock.telegram.integrity) && rec.lock['big-integer'] && /^[0-9a-f]{64}$/.test(rec.lockfileSha256);
      return { outcome: ok ? 'PASS_FAKE' : 'FAIL', details: rec };
    },
  },
];

function assertSandboxApproved({ descriptorPath, env = process.env } = {}) {
  if (!descriptorPath) throw new HarnessStop('STOP-APPROVAL', 'modo sandbox sin descriptor de sandbox autorizado (--descriptor <ruta>). No hay permiso de Purp/Sol registrado para T11 real.', 3);
  let d;
  try { d = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')); } catch (e) { throw new HarnessStop('STOP-APPROVAL', `descriptor ilegible: ${e.message}`, 3); }
  const ok = d && d.scope === 'T11-SANDBOX' && typeof d.approvalId === 'string' && d.approvalId.length >= 8 && typeof d.approvedBy === 'string' && Array.isArray(d.botIds) && d.botIds.length > 0 && Array.isArray(d.vaultIds) && d.vaultIds.length > 0 && typeof d.expiresAt === 'string' && Date.parse(d.expiresAt) > Date.now() && d.production !== true;
  if (!ok) throw new HarnessStop('STOP-APPROVAL', 'descriptor de sandbox incompleto, vencido o marcado como producción.', 3);
  if (env.BEATGALER_T11_SANDBOX_APPROVAL !== d.approvalId) throw new HarnessStop('STOP-APPROVAL', 'BEATGALER_T11_SANDBOX_APPROVAL no coincide con approvalId del descriptor.', 3);
  // Aprobación formalmente válida: el cliente real todavía no existe en este commit (fase B pendiente de Sol/Purp).
  throw new HarnessStop('STOP-ENV', 'sandbox aprobado pero el runner real de T11 fase B no está implementado en este commit; ninguna operación de red fue ejecutada.', 4);
}

async function runExperiments({ mode = 'fake', descriptorPath = null, env = process.env, only = null } = {}) {
  if (mode === 'sandbox') assertSandboxApproved({ descriptorPath, env });
  if (mode !== 'fake') throw new HarnessStop('STOP-ENV', `modo desconocido: ${mode}`, 2);
  const sdk = loadSdk();
  const results = [];
  for (const exp of EXPERIMENTS) {
    if (only && !only.includes(exp.id)) continue;
    let r;
    try { r = await exp.run({ sdk }); } catch (error) { r = { outcome: 'FAIL', details: { error: error && (error.code || error.message) } }; }
    results.push({ id: exp.id, step: exp.step, title: exp.title, expected: exp.expected, outcome: r.outcome, matchesExpected: r.outcome === exp.expected, evidence: 'FAKE', details: r.details });
  }
  const allMatch = results.every((r) => r.matchesExpected);
  return {
    mode, evidence: 'FAKE', g2: 'NOT_PROVEN', stop: 'STOP-APPROVAL: fase B (sandbox real) requiere permiso explícito; sin él no se declara T11 PASS',
    sdk: sdkRecord(), sdkContract: gateway.SDK_CONTRACT, resendPolicy: gateway.RESEND_POLICY,
    errorTable: gateway.ERROR_TABLE.map((row) => ({ pattern: row.re.source, kind: row.kind, action: row.action })),
    experiments: results, allMatch, generatedAt: new Date().toISOString(),
  };
}

function parseArgs(argv) {
  const out = { mode: 'fake', out: null, descriptorPath: null, list: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--descriptor') out.descriptorPath = argv[++i];
    else if (a === '--only') out.only = String(argv[++i]).split(',');
    else if (a === '--list') out.list = true;
    else throw new HarnessStop('STOP-ENV', `argumento desconocido: ${a}`, 2);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) { for (const e of EXPERIMENTS) console.log(`${e.id}\tpaso ${e.step}\t${e.expected}\t${e.title}`); return 0; }
  const report = await runExperiments(args);
  const outPath = args.out || path.join(ROOT, 'tmp', 'catalog-transport-contract', 'report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  for (const r of report.experiments) console.log(`${r.matchesExpected ? 'ok ' : 'NOK'} ${r.id} ${r.outcome} (esperado ${r.expected}) — ${r.title}`);
  console.log(`evidencia=${report.evidence} g2=${report.g2} sdk=${report.sdk.installed} informe=${outPath}`);
  console.log(report.stop);
  return report.allMatch ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(`${e.code || 'ERROR'}: ${e.message}`); process.exit(e.exitCode || 1); });
}

module.exports = { EXPERIMENTS, runExperiments, assertSandboxApproved, sdkRecord, loadSdk, HarnessStop, parseArgs };
