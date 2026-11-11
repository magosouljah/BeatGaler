'use strict';
// LAB navegador: preload para `cloud-server/server.js` (--require). Inyecta el gateway FAKE (servidor MTProto falso en memoria + adaptador
// real transport-gateway.js con el SDK gramjs del repo) en media/purge/transport, arranca el worker del catálogo EN PROCESO (mismo estado
// fake) y siembra beats por el flujo real T12 (operación → capacidad → upload → verify → commit) en UNA sola ejecución del Cloud.
// Solo laboratorio: se niega fuera de NODE_ENV=development + BEATGALER_DEPLOYMENT_ENV=test y de la base del LAB.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const L = require('./lab-env.cjs');
const R = path.join(L.ROOT, 'cloud-server') + '/';
const cfg = JSON.parse(fs.readFileSync(L.CFG_FILE, 'utf8'));
if (process.env.NODE_ENV !== 'development' || process.env.BEATGALER_DEPLOYMENT_ENV !== 'test') throw new Error('LAB preload: entorno no permitido');
if (process.env.DATABASE_URL !== cfg.databaseUrl || !new RegExp(`@127\\.0\\.0\\.1:${cfg.db.port}/lab_br_`).test(process.env.DATABASE_URL || '')) throw new Error('LAB preload: DATABASE_URL no es la base efímera del LAB');

const { Api } = require(R + 'node_modules/telegram');
const bigInt = require(R + 'node_modules/big-integer');
const g = require(R + 'catalog/transport-gateway.js');
const { createFakeTelegramServer } = require(R + 'tests/helpers/catalog-fake-mtproto.cjs');
const catalogMedia = require(R + 'catalog/media');
const catalogPurge = require(R + 'catalog/purge');
const catalogTransport = require(R + 'catalog/transport');
const catalogOperations = require(R + 'catalog/operations');
const catalogQueries = require(R + 'catalog/queries');
const catalogCommands = require(R + 'catalog/commands');
const { createCatalogWorker } = require(R + 'catalog/worker');

const server = createFakeTelegramServer();
const client = server.session({ selfId: '20' });
const peerOf = (chatId) => new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt('7') });
const gateway = { ...g.createTelegramGateway({ client, sdk: { Api, bigInt }, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) }), client };
global.__lab = { server, gateway, seeded: false };

const wrap = (mod, name, patch) => { const orig = mod[name]; mod[name] = (options) => orig(options && patch(options)); };
wrap(catalogMedia, 'configureCatalogMedia', (o) => ({ ...o, gateway }));
// LAB: sin cuota de plan (Access sandbox no configurado); el límite real de beats es asunto de billing, no de V09/V10.
wrap(catalogOperations, 'configureCatalogOperations', (o) => ({ ...o, resolveAccess: async () => ({ maxBeats: null }) }));
wrap(catalogPurge, 'configureCatalogPurge', (o) => ({ ...o, gateway }));
const origTransport = catalogTransport.configureCatalogTransport;
catalogTransport.configureCatalogTransport = (options) => {
  const transport = origTransport(options && { ...options, gateway });
  if (transport) setTimeout(() => { startWorkerAndSeed(options.pool, transport).catch((e) => console.error('[lab] seed failed', e.stack || e.message, JSON.stringify(e.detail || null), e.cause && (e.cause.message || e.cause))); }, 50);
  return transport;
};

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

async function startWorkerAndSeed(pool, transport) {
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
      const cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: p.partKey });
      const payload = p.role === 'ARTWORK' ? PNG_1x1 : bytes;
      const up = await transport.uploadPart({ ...hdr, token: cap.token, stream: Readable.from([payload]), contentLength: payload.length });
      if (i === 0) console.log('[lab] upload', p.partKey, JSON.stringify({ status: up.status, upload: up.body && up.body.upload }));
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
console.log('[lab] preload active: fake gateway injected (Bot20 fake), in-process worker, seeding on start');
