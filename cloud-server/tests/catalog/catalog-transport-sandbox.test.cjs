'use strict';
// T11 fase B — runner del sandbox real probado OFFLINE con el fake MTProto (sin red, sin credenciales).
// Verifica: cercos de descriptor/aprobación/--execute, preflight de identidad y aislamiento ANTES de escribir, orquestación E2–E8,
// limpieza limitada al ledger y que el informe nunca contenga secretos. No es evidencia de proveedor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Api } = require('telegram');
const bigInt = require('big-integer');
const runner = require('../../../scripts/catalog-transport-sandbox.cjs');
const { createFakeTelegramServer, rpcError } = require('../helpers/catalog-fake-mtproto.cjs');

const BOT = '8800000001'; const MASTER = '6300000001'; const CHAT = '-1001234567890';
const T1 = `${BOT}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1`; const T2 = `${BOT}:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2`;
const descriptor = (over = {}) => ({ scope: 'T11-SANDBOX', approvalId: 'APR-T11B-TEST', approvedBy: 'Purp', production: false, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  bot: { id: 'Bot20', telegramUserId: BOT, username: 'TestBot20bot' }, master: { telegramUserId: MASTER, username: 'tester' }, chats: [CHAT], ...over });
const peer = (chatId) => new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt(7) });

function fakeDeps({ dedupWindowMs = null, members = null, webhook = '', botIdOverride = null } = {}) {
  const server = createFakeTelegramServer({ dedupWindowMs });
  const state = { token: T1, persisted: 0, logins: 0 };
  const bound = (tok) => { // sesión de bot ligada al token con que se emitió su auth key
    const inner = server.session({ selfId: BOT });
    const guard = () => { if (tok !== state.token) throw rpcError('AUTH_KEY_UNREGISTERED', 401); };
    return { tok, async invoke(r) { guard(); if (r.className === 'users.GetUsers') return [{ id: BOT }]; return inner.invoke(r); }, async uploadFile(a) { guard(); return inner.uploadFile(a); }, async disconnect() {} };
  };
  const masterClient = server.session({ selfId: MASTER });
  const seeded = { id: null };
  const botApiWith = async (tok, method) => {
    if (tok !== state.token) throw Object.assign(new Error('BOTAPI_401'), { errorMessage: 'BOTAPI_401' });
    if (method === 'getMe') return { id: botIdOverride || BOT, username: 'TestBot20bot', is_bot: true };
    if (method === 'getWebhookInfo') return { url: webhook };
    throw new Error('unexpected');
  };
  const deps = {
    runId: 'testrun', sdk: { Api, bigInt }, sdkVersion: 'fake', sleep: async () => {},
    botApi: (m) => botApiWith(state.token, m), botApiWith,
    async openBot() { state.logins++; const c = bound(state.token); return { client: c, saveSession: () => `S:${c.tok}` }; },
    async restoreBot(saved) { return bound(saved.slice(2)); },
    getMe: (c) => c.invoke({ className: 'users.GetUsers' }),
    resolvePeer: async (_c, chatId) => ({ peer: peer(chatId), channel: true }),
    dropResponses: (client) => ({ uploadFile: (a) => client.uploadFile(a), async invoke(r) { const x = await client.invoke(r); if (r.className === 'messages.SendMedia') throw Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }); return x; } }),
    async probeRecent(client, chatId, q) { const ids = server.messages().map((m) => m.id); const r = await client.invoke(new Api.channels.GetMessages({ channel: peer(chatId), id: ids.map((id) => new Api.InputMessageID({ id })) })); return require('../../catalog/transport-gateway.js').matchCandidates(r.messages, q); },
    editCaption: async (c) => c.invoke({ className: 'messages.EditMessage' }),
    pin: async (c) => c.invoke({ className: 'messages.UpdatePinnedMessage' }),
    botRights: async () => ({ status: 'administrator', can_delete_messages: false, can_pin_messages: false }),
    makeFile: (name, size, seed) => ({ name, size, buffer: Buffer.alloc(size, seed.length % 251) }),
    async rotateToken() { const old = state.token; state.token = T2; state.persisted++; return { method: 'fake', verified: true, oldToken: old }; },
    master: {
      client: masterClient,
      getMe: async () => ({ id: MASTER, username: 'tester', bot: false }),
      chatMembers: async () => members || [{ id: MASTER, role: 'Creator' }, { id: BOT, role: 'Admin' }],
      history: async () => server.messages().slice().reverse().map((m) => ({ messageId: m.id, caption: m.caption, senderId: m.sender })),
      getMessages: async (_c, ids) => ids.map((id) => { const m = server.messages().find((x) => x.id === id); return m ? { messageId: id, caption: m.caption, present: true } : { messageId: id, caption: '', present: false }; }),
      deleteMessages: async (chatId, ids) => masterClient.invoke(new Api.channels.DeleteMessages({ channel: peer(chatId), id: ids })),
      senderPeer: async (s) => new Api.InputPeerUser({ userId: bigInt(String(s)), accessHash: bigInt(1) }),
      reconnect: async () => server.session({ selfId: MASTER }),
    },
    secrets: () => [T1, T2],
  };
  return { deps, server, state, seed: async () => { // mensaje previo ajeno al run: la limpieza no debe tocarlo
    const up = await masterClient.uploadFile({ file: { name: 'old.wav', buffer: Buffer.from('previo') } });
    const r = await masterClient.invoke(new Api.messages.SendMedia({ peer: peer(CHAT), media: new Api.InputMediaUploadedDocument({ file: up, mimeType: 'audio/wav', attributes: [] }), message: 'catalog:v1 op=other part=m0', randomId: bigInt(42) }));
    seeded.id = r.updates[0].id; return seeded.id;
  } };
}

test('descriptor: STOP-APPROVAL sin --execute (exit 0, sin red), TTL > 24 h, production:true, credencial embebida o aprobación distinta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t11b-'));
  const w = (o) => { const p = path.join(dir, `${Math.random()}.json`); fs.writeFileSync(p, JSON.stringify(o)); return p; };
  const env = { BEATGALER_T11_SANDBOX_APPROVAL: 'APR-T11B-TEST' };
  assert.throws(() => runner.loadDescriptor(w(descriptor()), { env }), (e) => e.code === 'STOP-APPROVAL' && e.exitCode === 0 && /--execute/.test(e.message));
  assert.equal(runner.loadDescriptor(w(descriptor()), { env, execute: true }).approvalId, 'APR-T11B-TEST');
  assert.throws(() => runner.loadDescriptor(w(descriptor({ expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() })), { env, execute: true }), (e) => e.code === 'STOP-APPROVAL');
  assert.throws(() => runner.loadDescriptor(w(descriptor({ production: true })), { env, execute: true }), (e) => e.code === 'STOP-APPROVAL');
  assert.throws(() => runner.loadDescriptor(w(descriptor({ note: T1 })), { env, execute: true }), (e) => /credenciales/.test(e.message));
  assert.throws(() => runner.loadDescriptor(w(descriptor()), { env: { BEATGALER_T11_SANDBOX_APPROVAL: 'otro' }, execute: true }), (e) => e.code === 'STOP-APPROVAL');
  assert.throws(() => runner.loadDescriptor(null, { env, execute: true }), (e) => e.code === 'STOP-APPROVAL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preflight: aislamiento roto o identidad ajena → STOP-ISOLATION antes de cualquier envío', async () => {
  for (const opts of [{ members: [{ id: MASTER, role: 'Creator' }, { id: BOT, role: 'Admin' }, { id: '999', role: 'Member' }] }, { members: [{ id: MASTER, role: 'Admin' }, { id: BOT, role: 'Creator' }] }, { webhook: 'https://x.example/hook' }, { botIdOverride: '1234567' }]) {
    const { deps, server } = fakeDeps(opts);
    await assert.rejects(runner.runSandbox(descriptor(), deps, { dedupDelaysMs: [0] }), (e) => e.code === 'STOP-ISOLATION');
    assert.equal(server.counters().sends, 0, 'ningún envío antes de demostrar aislamiento');
  }
});

test('run completo (fake, dedup ausente): E2/E5/E6 pasan, E4 detecta copias, E8 confirma riesgo, E7 rota y cierra sesiones viejas; limpieza solo del ledger; informe sin secretos', async () => {
  const { deps, server, state, seed } = fakeDeps({ dedupWindowMs: null });
  const prior = await seed();
  const r = await runner.runSandbox(descriptor(), deps, { dedupDelaysMs: [0] });
  assert.equal(r.experiments.E6.pass, true, JSON.stringify(r.experiments.E6));
  assert.equal(r.experiments.E2_bot.pass, true, JSON.stringify(r.experiments.E2_bot));
  assert.equal(r.experiments.E2_master.pass, true, JSON.stringify(r.experiments.E2_master));
  assert.equal(r.experiments.E2_bot.reconcileBotIdProbe.decision, 'ADOPT');
  assert.equal(r.experiments.E5.pass, true, JSON.stringify(r.experiments.E5));
  assert.equal(r.experiments.E4.dedupHolds, false);
  assert.ok(r.experiments.E4.bot.every((x) => x.outcome === 'NEW_MESSAGE' && x.copies === 2));
  assert.deepEqual(r.experiments.E4.master.map((x) => x.variant), ['same-session', 'reconnect'], 'sin logins nuevos de MASTER');
  assert.match(r.experiments.E8.g2Risk, /^CONFIRMED/);
  assert.equal(r.experiments.E8.editOwn.rpc, 'METHOD_NOT_SUPPORTED_BY_FAKE', 'errores reales se registran, no abortan');
  assert.equal(r.experiments.E7.pass, true, JSON.stringify(r.experiments.E7));
  assert.equal(state.persisted, 1);
  assert.equal(r.cleanup.requested, r.cleanup.absentVerified);
  assert.deepEqual(server.messages().map((m) => m.id), [prior], 'solo sobrevive el mensaje previo ajeno al run');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t11b-'));
  assert.ok(fs.existsSync(runner.writeReport(r, dir, deps.secrets())));
  assert.throws(() => runner.writeReport({ ...r, leak: T2 }, dir, deps.secrets()), (e) => e.code === 'STOP-SECRET');
  assert.throws(() => runner.assertNoSecrets('x', ['sesion-secreta-larga']) && runner.assertNoSecrets('... sesion-secreta-larga ...', ['sesion-secreta-larga']), (e) => e.code === 'STOP-SECRET');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dedup del proveedor presente (hipótesis optimista): E4 SAME_MESSAGE en todas las variantes; --rotation skip no toca el token', async () => {
  const { deps, state } = fakeDeps({ dedupWindowMs: 3600_000 });
  const r = await runner.runSandbox(descriptor(), deps, { dedupDelaysMs: [0], rotation: 'skip' });
  assert.equal(r.experiments.E4.dedupHolds, true);
  assert.ok([...r.experiments.E4.bot, ...r.experiments.E4.master].every((x) => x.outcome === 'SAME_MESSAGE'));
  assert.deepEqual(r.experiments.E7, { skipped: true });
  assert.equal(state.persisted, 0);
});

test('CLI: argumentos', () => {
  assert.deepEqual(runner.parseArgs(['--descriptor', 'd.json', '--execute', '--dedup-delays', '0,5', '--rotation', 'skip']), { descriptorPath: 'd.json', execute: true, out: null, rotation: 'skip', delays: [0, 5000], cleanup: true });
  assert.throws(() => runner.parseArgs(['--rotation', 'manager']), (e) => e.code === 'STOP-ENV');
  assert.throws(() => runner.parseArgs(['--boom']), (e) => e.code === 'STOP-ENV');
});

test('E3 (solo): ráfaga acotada hasta FLOOD_WAIT → rechazo sin efecto, espera, reintento con la misma identidad = 1 copia; limpieza solo del ledger', async () => {
  const { deps, server } = fakeDeps({});
  const open = deps.openBot;
  let sends = 0;
  deps.openBot = async (...a) => { const r = await open(...a); const inv = r.client.invoke.bind(r.client); r.client.invoke = async (req) => { if (req.className === 'messages.SendMedia' && ++sends === 4) throw rpcError('FLOOD_WAIT_2', 420, { seconds: 2 }); return inv(req); }; return r; };
  const before = server.messages().length;
  const r = await runner.runSandbox(descriptor(), deps, { only: 'E3', e3: { maxSends: 10 } });
  const e3 = r.experiments.E3;
  assert.equal(e3.verdict, 'PASS', JSON.stringify(e3));
  assert.deepEqual([e3.accepted, e3.rejection.kind, e3.rejection.action, e3.rejection.retryAfterMs, e3.phantomCopiesAfterReject, e3.resendSameIdentity.copies], [3, 'REJECTED', 'RETRY_SAME_IDENTITY_AFTER_WAIT', 2000, 0, 1]);
  assert.equal(Object.keys(r.experiments).join(), 'E3', 'solo E3');
  assert.equal(r.cleanup.requested, 4); assert.equal(server.messages().length, before);
  // sin FLOOD en el límite → NOT_TRIGGERED (no es PASS)
  const f2 = fakeDeps({});
  const r2 = await runner.runSandbox(descriptor(), f2.deps, { only: 'E3', e3: { maxSends: 3 } });
  assert.equal(r2.experiments.E3.verdict, 'NOT_TRIGGERED');
});
