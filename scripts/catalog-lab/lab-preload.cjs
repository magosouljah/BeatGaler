'use strict';
// LAB navegador: preload para `cloud-server/server.js` (--require). E77: el Cloud no mueve bytes; aquí vive el «Telegram» FAKE en memoria:
//  - el Cloud recibe un gateway de SOLO metadatos sobre ese fake (verificar, purgar, MAIN) y el worker del catálogo corre EN PROCESO;
//  - el NAVEGADOR del LAB habla con el fake por un doble HTTP propio de este proceso de pruebas (/lab-telegram/read|send, puerto Cloud+5), que
//    sustituye a MTProto solo en `vite dev` (VITE_CATALOG_LAB_DIRECT); mismo contrato que Direct B: ticket → envío → recibo;
//  - la siembra usa ese mismo flujo (operación → ticket → envío al fake → recibo → verify → commit) en UNA sola ejecución del Cloud.
// Solo laboratorio: se niega fuera de NODE_ENV=development + BEATGALER_DEPLOYMENT_ENV=test y de la base del LAB.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const L = require('./lab-env.cjs');
const R = path.join(L.ROOT, 'cloud-server') + '/';
const cfg = JSON.parse(fs.readFileSync(L.CFG_FILE, 'utf8'));
if (process.env.NODE_ENV !== 'development' || process.env.BEATGALER_DEPLOYMENT_ENV !== 'test') throw new Error('LAB preload: entorno no permitido');
if (process.env.DATABASE_URL !== cfg.databaseUrl || !new RegExp(`@127\\.0\\.0\\.1:${cfg.db.port}/lab_br_`).test(process.env.DATABASE_URL || '')) throw new Error('LAB preload: DATABASE_URL no es la base efímera del LAB');

const { Api } = require(R + 'node_modules/telegram');
const bigInt = require(R + 'node_modules/big-integer');
const g = require(R + 'catalog/transport-gateway.js');
const telegramOp = require(R + 'operator/telegram-file-io.js');
const { createFakeTelegramServer } = require(R + 'tests/helpers/catalog-fake-mtproto.cjs');
const catalogMedia = require(R + 'catalog/media');
const catalogPurge = require(R + 'catalog/purge');
const catalogDirect = require(R + 'catalog/direct');
const catalogPrefixPacks = require(R + 'catalog/prefix-packs');
const catalogOperations = require(R + 'catalog/operations');
const catalogQueries = require(R + 'catalog/queries');
const catalogCommands = require(R + 'catalog/commands');
const { createCatalogWorker } = require(R + 'catalog/worker');

const server = createFakeTelegramServer();
const client = server.session({ selfId: '20' });
const peerOf = (chatId) => new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt('7') });
const tgOptions = (c) => ({ client: c, sdk: { Api, bigInt }, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) });
const gateway = g.createTelegramGateway(tgOptions(client)); // Cloud: solo metadatos
const browser = telegramOp.createOperatorTelegram(tgOptions(server.session({ selfId: '20' }))); // el «navegador»: lee y envía bytes al fake
global.__lab = { server, gateway, browser, seeded: false };

const wrap = (mod, name, patch) => { const orig = mod[name]; mod[name] = (options) => orig(options && patch(options)); };
// LAB: sin cuota de plan (Access sandbox no configurado); el límite real de beats es asunto de billing, no de V09/V10.
wrap(catalogOperations, 'configureCatalogOperations', (o) => ({ ...o, resolveAccess: async () => ({ maxBeats: null }) }));
wrap(catalogPurge, 'configureCatalogPurge', (o) => ({ ...o, gateway }));
wrap(catalogPrefixPacks, 'configurePrefixPacks', (o) => ({ ...o, gateway }));
const origDirect = catalogDirect.configureCatalogDirect;
catalogDirect.configureCatalogDirect = (options) => {
  // LAB: tope de PROJECT holgado (Access sandbox no configurado). La sesión MTProto real no se usa: el navegador del LAB va por el doble HTTP.
  const direct = origDirect(options && { ...options, resolveProjectAccess: async () => ({ maxBytes: 200 * 1024 * 1024 }) });
  if (direct) setTimeout(() => { startWorkerAndSeed(options.pool, direct).catch((e) => console.error('[lab] seed failed', e.stack || e.message, JSON.stringify(e.detail || null), e.cause && (e.cause.message || e.cause))); }, 50);
  return direct;
};

// Doble HTTP del «Telegram» para el navegador del LAB (CORS abierto, solo loopback). No es el Cloud y no existe fuera del laboratorio.
const labPort = Number(process.env.PORT) + 5;
http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  const json = (status, body) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const u = new URL(req.url, 'http://127.0.0.1'); const q = Object.fromEntries(u.searchParams);
    if (req.method === 'GET' && u.pathname === '/lab-telegram/read') {
      const chunks = []; for await (const c of await browser.downloadPart({ chatId: q.chatId, messageId: Number(q.messageId), offset: Number(q.offset || 0), limit: q.length ? Number(q.length) : null })) chunks.push(Buffer.from(c));
      const body = Buffer.concat(chunks); res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) }); return res.end(body);
    }
    if (req.method === 'POST' && u.pathname === '/lab-telegram/send') {
      const chunks = []; for await (const c of req) chunks.push(c); const buffer = Buffer.concat(chunks);
      try { return json(200, await browser.sendDocument({ caption: q.caption, randomId: q.randomId, chatId: q.chatId, file: { name: q.filename || 'file.bin', size: buffer.length, buffer }, mimeType: q.mime, fileName: q.filename || 'file.bin' })); }
      catch (e) { const c = (e && e.classification) || {}; return json(409, { failure: { kind: c.kind === 'REJECTED' || c.kind === 'PERMANENT' || c.kind === 'REVOKED' ? c.kind : e && e.code === 'UPLOAD_FAILED' ? 'UPLOAD_FAILED' : 'UNCERTAIN', code: String((e && e.code) || 'LAB').slice(0, 60), retryAfterMs: Number(e && e.retryAfterMs) || 0 } }); }
    }
    json(404, { error: 'not found' });
  } catch (e) { json(502, { error: String((e && e.code) || (e && e.message) || e).slice(0, 200) }); }
}).listen(labPort, '127.0.0.1', () => console.log(`[lab] «Telegram» FAKE para el navegador en http://127.0.0.1:${labPort}/lab-telegram`));

const RUN = crypto.randomBytes(3).toString('hex');
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Audio de siembra: MP3 reales de tmp/gallery-test si existen; si no, MP3 sintético (frames MPEG1 L3 128 kbps/44.1 kHz silenciosos).
function silentMp3(seconds) {
  const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: Math.max(1, Math.round(seconds / 0.026122)) }, () => frame));
}
function loadAudio() {
  const dir = path.join(L.ROOT, 'tmp', 'gallery-test');
  const bigP = process.env.LAB_BIG_MP3 || path.join(dir, 'Galer E2E Beat.mp3'); const smallP = process.env.LAB_SMALL_MP3 || path.join(dir, 'beat-de-prueba.mp3');
  if (!process.env.LAB_SYNTH_AUDIO && fs.existsSync(bigP) && fs.existsSync(smallP)) return { big: fs.readFileSync(bigP), small: fs.readFileSync(smallP), source: 'fixtures' };
  return { big: silentMp3(40), small: silentMp3(3), source: 'synthetic-silent-mp3' };
}

async function startWorkerAndSeed(pool, direct) {
  const ops = catalogOperations.currentCatalogOperations(); const cmd = catalogCommands.currentCatalogCommands(); const q = catalogQueries.currentCatalogQueries(); const purge = catalogPurge.currentCatalogPurge();
  const worker = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: gateway, purge, owner: 'lab-inproc', log: (...a) => console.warn('[lab-worker]', ...a), options: { pollMs: 500, globalConcurrency: 2 } });
  worker.start?.(); global.__lab.worker = worker;
  const { userId } = cfg.account;
  const lib = (await pool.query('SELECT authority_era::text AS era, authority_epoch::text AS epoch, active_count::int AS n FROM catalog_libraries WHERE user_id = $1', [userId])).rows[0];
  if (!lib) { console.error('[lab] library missing'); return; }
  const have = lib.n; const N = cfg.seedN;
  if (have >= N) { console.log(`[lab] library already seeded (${have})`); global.__lab.seeded = true; return; }
  if (have > 0) console.warn(`[lab] AVISO: biblioteca con ${have} beats de una ejecución anterior; el estado del gateway fake es en memoria (medios de esas filas no existen). Usa lab down/up.`);
  const audio = loadAudio(); console.log(`[lab] seeding ${have} -> ${N} (audio=${audio.source})`);
  const tagsPool = ['trap', 'drill', 'lofi', 'boombap', 'house', 'ambient', 'rnb', 'afro'];
  const keys = ['Cm', 'Am', 'F#m', 'G', 'Dm', 'Bb', 'E', 'Abm'];
  const hdr = { userId, era: lib.era, epoch: lib.epoch };
  const t0 = Date.now();
  for (let i = have; i < N; i++) {
    const bytes = i < 6 ? audio.big : audio.small; // 6 beats con audio largo para reproducción; el resto cortos (virtualización)
    const parts = [{ partKey: 'MASTER:0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: bytes.length, sha256: sha(bytes), filename: `beat-${i}.mp3`, mime: 'audio/mpeg' }];
    if (i % 3 === 0) parts.push({ partKey: 'ARTWORK:0', slotKey: 'ARTWORK', role: 'ARTWORK', partIndex: 0, size: PNG_1x1.length, sha256: sha(PNG_1x1), filename: 'cover.png', mime: 'image/png' });
    const metadata = { name: `V09 Beat ${String(i).padStart(3, '0')}`, bpm: String(80 + (i * 7) % 90), key: keys[i % keys.length], tags: [tagsPool[i % tagsPool.length], ...(i % 5 === 0 ? [tagsPool[(i + 3) % tagsPool.length]] : [])], rating: i % 6, color: '#3a3a3a', color2: '#777777' };
    const op = await ops.createOperation({ ...hdr, idempotencyKey: `lab-seed-${RUN}-${i}`, intent: { kind: 'IMPORT', parts, metadata } });
    for (const p of parts) {
      const payload = p.role === 'ARTWORK' ? PNG_1x1 : bytes;
      const t = await direct.issueSendTicket({ ...hdr, operationId: op.operationId, partKey: p.partKey });
      const sent = await browser.sendPart({ operationId: op.operationId, partKey: p.partKey, randomId: t.randomId, chatId: t.chatId, file: { name: t.filename, size: payload.length, buffer: payload }, mimeType: t.mime, fileName: t.filename });
      const up = await direct.submitReceipt({ ...hdr, operationId: op.operationId, partKey: p.partKey, attempt: t.attempt, receipt: { messageId: sent.messageId, size: sent.size, senderId: sent.senderId, chatId: sent.chatId } });
      if (i === 0) console.log('[lab] upload', p.partKey, JSON.stringify({ upload: up && up.upload }));
    }
    for (let r = 0; r < 40; r++) { // verificación PROVIDER por el worker en proceso (TRANSFER_VERIFY) y commit
      await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1 AND state = 'QUEUED'", [userId]);
      await worker.runOnce({ kinds: ['TRANSFER_VERIFY', 'TRANSFER_RECONCILE'] });
      const st = (await pool.query('SELECT status FROM catalog_transfer_operations WHERE user_id = $1 AND operation_id = $2', [userId, op.operationId])).rows[0].status;
      if (st === 'READY') break;
      await new Promise((r2) => setTimeout(r2, 20));
    }
    const c = await ops.commitOperation({ ...hdr, operationId: op.operationId });
    if (c.operation.status !== 'COMMITTED') { console.error('[lab] commit not committed', i, c.operation.status); return; }
    if (i % 50 === 0) console.log(`[lab] seeded ${i + 1}/${N}`);
  }
  global.__lab.seeded = true;
  console.log(`[lab] seed done N=${N} in ${Date.now() - t0}ms; fake messages=${server.messages().length}`);
}
console.log('[lab] preload active: Telegram FAKE (Bot20 fake), gateway de solo metadatos para el Cloud, worker en proceso, siembra por Direct B');
console.log('[lab] el Cloud no transporta bytes: importar/reproducir/descargar van navegador ↔ Telegram FAKE por el doble HTTP del LAB.');
