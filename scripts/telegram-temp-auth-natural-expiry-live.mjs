import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Task 5.1 natural-expiry proof only.
// Reuses the already-proven M0-C split permanent-side/temp-side harness without
// changing product runtime. Temp A is requested with a 60-second TTL, used once,
// left intact locally, then used again only after wall-clock expires_at. PASS
// requires Telegram itself to reject A after expiry twice consecutively. A fresh
// Temp B must then bind and restore the same bot identity. No vault, file, revoke
// or rotation.

const TTL_SECONDS = 60;
const EXPIRY_GRACE_MS = 15_000;
const RPC_TIMEOUT_MS = 20_000;
const SECRET_NAMES = [
  'BEATGALER_M0_C_API_ID',
  'BEATGALER_M0_C_API_HASH',
  'BEATGALER_M0_C_BOT_TOKEN',
  'BEATGALER_M0_B2_API_ID',
  'BEATGALER_M0_B2_API_HASH',
  'BEATGALER_M0_B2_BOT_TOKEN',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_BOT_TOKEN',
];
const PROD_DC_SUBDOMAINS = { 1: 'pluto', 2: 'venus', 3: 'aurora', 4: 'vesta', 5: 'flora' };

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required natural-expiry probe secret: ${name}`);
  return value;
}

function parseDc(value) {
  const dc = Number(value);
  assert.ok(Number.isInteger(dc) && PROD_DC_SUBDOMAINS[dc], `Invalid production DC: ${value}`);
  return dc;
}

function clientEnv(dcId) {
  const env = { ...process.env, BEATGALER_NATURAL_EXPIRY_CLIENT: '1', BEATGALER_NATURAL_EXPIRY_DC_ID: String(dcId) };
  for (const name of SECRET_NAMES) delete env[name];
  return env;
}

function timeout(promise, label, ms = RPC_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function makeHelperModule() {
  const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'telegram-temp-auth-renewal-live.mjs');
  let source = await readFile(sourcePath, 'utf8');
  assert.ok(source.includes('const TEMP_EXPIRY_SECONDS = 10 * 60;'), 'M0-C TTL anchor changed; review probe before running.');
  source = source.replace('const TEMP_EXPIRY_SECONDS = 10 * 60;', `const TEMP_EXPIRY_SECONDS = ${TTL_SECONDS};`);
  const marker = "\nif (process.argv.includes('--client') || process.env.BEATGALER_M0_C_CLIENT === '1') {";
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex > 0, 'M0-C entrypoint anchor changed; review probe before running.');
  source = source.slice(0, markerIndex) + `\nexport { loadMtcuteInternals, makeCrypto, makeManualConnection, generateAndBindTempKey, activateBoundTempKey, querySelf, buildBindingEnvelope };\n`;
  const helperPath = path.join(path.dirname(sourcePath), `.natural-expiry-helper-${process.pid}.mjs`);
  await writeFile(helperPath, source, 'utf8');
  return helperPath;
}

async function waitForMessage(proc, accepted, label) {
  const allowed = new Set(Array.isArray(accepted) ? accepted : [accepted]);
  return timeout(new Promise((resolve, reject) => {
    const onMessage = msg => {
      if (!allowed.has(msg?.type)) return;
      cleanup();
      resolve(msg);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`${label} exited before ${[...allowed].join('/')} (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      proc.off('message', onMessage);
      proc.off('exit', onExit);
    };
    proc.on('message', onMessage);
    proc.on('exit', onExit);
  }), `${label} IPC`, 180_000);
}

async function oneExpiredRpc(connection, attempt) {
  const result = await timeout(connection.sendRpc({
    _: 'users.getUsers',
    id: [{ _: 'inputUserSelf' }],
  }, 15_000), `post-expiry RPC ${attempt}`);
  assert.equal(result?._, 'mt_rpc_error', `Expired Temp A unexpectedly remained authorized on attempt ${attempt}: ${JSON.stringify(result)}`);
  return { errorCode: result.errorCode, errorMessage: String(result.errorMessage || '') };
}

async function expiredRpcMustFailTwice(connection) {
  const first = await oneExpiredRpc(connection, 1);
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const second = await oneExpiredRpc(connection, 2);
  return [first, second];
}

async function clientMain() {
  for (const name of SECRET_NAMES) assert.equal(process.env[name], undefined, `${name} must not reach expiry client.`);
  const helperPath = await makeHelperModule();
  let connectionA;
  let connectionB;
  const keyBuffers = [];
  try {
    const h = await import(`${pathToFileURL(helperPath).href}?v=${Date.now()}`);
    const dcId = parseDc(process.env.BEATGALER_NATURAL_EXPIRY_DC_ID);
    const m = await h.loadMtcuteInternals();
    const crypto = await h.makeCrypto(m);

    connectionA = await h.makeManualConnection(m, crypto, 'natural-expiry-A', 0, dcId);
    const tempA = await h.generateAndBindTempKey(m, crypto, connectionA, 'A');
    keyBuffers.push(tempA.keyBytes);
    h.activateBoundTempKey(connectionA, tempA);
    const userA = await h.querySelf(connectionA, 'A-before-expiry');

    const waitMs = Math.max(0, tempA.expiresAt * 1000 - Date.now() + EXPIRY_GRACE_MS);
    console.log(`Natural expiry probe: Temp A works; waiting ${waitMs}ms past expires_at=${tempA.expiresAt}.`);
    await new Promise(resolve => setTimeout(resolve, waitMs));

    assert.equal(connectionA._session._authKeyTemp.ready, true, 'Temp A must remain locally present before server-expiry assertion.');
    const rejections = await expiredRpcMustFailTwice(connectionA);

    await connectionA.destroy().catch(() => {});
    connectionA = undefined;

    connectionB = await h.makeManualConnection(m, crypto, 'natural-expiry-B', 0, dcId);
    const tempB = await h.generateAndBindTempKey(m, crypto, connectionB, 'B');
    keyBuffers.push(tempB.keyBytes);
    h.activateBoundTempKey(connectionB, tempB);
    const userB = await h.querySelf(connectionB, 'B-after-expiry');
    assert.equal(userB, userA, 'Fresh Temp B must restore the same bot identity after natural expiry of A.');

    process.send?.({
      type: 'client-proof',
      userId: userB,
      ttlSeconds: TTL_SECONDS,
      tempAExpiresAt: tempA.expiresAt,
      serverRejections: rejections,
      wallClockExpiryWaited: true,
      serverSideNaturalExpiryProven: true,
      freshTempRecoveryProven: true,
    });
  } finally {
    for (const bytes of keyBuffers) bytes?.fill(0);
    if (connectionA) await connectionA.destroy().catch(() => {});
    if (connectionB) await connectionB.destroy().catch(() => {});
    await unlink(helperPath).catch(() => {});
  }
}

async function binderMain() {
  const helperPath = await makeHelperModule();
  let connection;
  let permanentKeyBytes;
  let child;
  try {
    const h = await import(`${pathToFileURL(helperPath).href}?v=${Date.now()}`);
    const apiId = Number(required('BEATGALER_M0_C_API_ID'));
    const apiHash = required('BEATGALER_M0_C_API_HASH');
    const botToken = required('BEATGALER_M0_C_BOT_TOKEN');
    assert.ok(Number.isInteger(apiId) && apiId > 0, 'API id must be positive integer.');

    const m = await h.loadMtcuteInternals();
    const crypto = await h.makeCrypto(m);
    let dcId = 2;
    let authorizedBotId;
    const visited = new Set();

    while (!authorizedBotId) {
      assert.equal(visited.has(dcId), false, `Migration loop at DC ${dcId}`);
      visited.add(dcId);
      connection = await h.makeManualConnection(m, crypto, 'natural-expiry-binder', apiId, dcId);
      const [key, salt, offset] = await timeout(m.doAuthorization(connection, crypto), `permanent auth DC ${dcId}`, 60_000);
      permanentKeyBytes = key;
      connection._session._authKey.setup(key);
      connection._salts.currentSalt = salt;
      connection._session.updateTimeOffset(offset, true);
      connection.onConnectionUsable();

      const authorization = await timeout(connection.sendRpc({
        _: 'auth.importBotAuthorization', flags: 0, apiId, apiHash, botAuthToken: botToken,
      }, 30_000), `bot authorization DC ${dcId}`, 40_000);

      if (authorization?._ === 'mt_rpc_error') {
        const migrate = /^USER_MIGRATE_(\d+)$/.exec(String(authorization.errorMessage || ''));
        if (migrate) {
          const nextDc = parseDc(migrate[1]);
          await connection.destroy().catch(() => {});
          connection = undefined;
          permanentKeyBytes.fill(0);
          permanentKeyBytes = undefined;
          dcId = nextDc;
          continue;
        }
        throw new Error(`Bot authorization rejected: ${authorization.errorCode}:${authorization.errorMessage}`);
      }
      assert.equal(authorization?._, 'auth.authorization');
      assert.equal(authorization?.user?.bot, true);
      authorizedBotId = String(authorization.user.id);
    }

    child = fork(fileURLToPath(import.meta.url), ['--client'], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: clientEnv(dcId),
    });

    for (const label of ['A', 'B']) {
      const request = await waitForMessage(child, 'build-binding', 'expiry client');
      assert.equal(request.label, label, `Expected bind ${label}, received ${request.label}`);
      const envelope = await h.buildBindingEnvelope(m, crypto, permanentKeyBytes, request.metadata);
      child.send({ type: 'binding-envelope', label, envelope });
    }

    const proof = await waitForMessage(child, 'client-proof', 'expiry client');
    assert.equal(proof.userId, authorizedBotId);
    assert.equal(proof.wallClockExpiryWaited, true);
    assert.equal(proof.serverSideNaturalExpiryProven, true);
    assert.equal(proof.freshTempRecoveryProven, true);
    assert.equal(proof.serverRejections?.length, 2, 'Two consecutive post-expiry Telegram rejections are required.');

    console.log('PASS Task 5.1 natural temp-auth expiry: A worked, Telegram rejected the same locally-retained A twice after expires_at, and fresh B restored the same bot identity');
    console.log(JSON.stringify({
      mode: 'Task 5.1 isolated production-DC natural temp-auth expiry proof',
      ttl_seconds: proof.ttlSeconds,
      wall_clock_expiry_waited: true,
      server_side_natural_expiry_proven: true,
      expired_key_rejections: proof.serverRejections,
      fresh_temp_recovery_proven: true,
      bot_identity_preserved: true,
      permanent_auth_reaches_client: false,
      bot_token_reaches_client: false,
      api_hash_reaches_client: false,
      galer_file_bytes: false,
      vault_used: false,
      production_runtime_changed: false,
      token_rotation_or_revoke: false,
    }));
  } finally {
    permanentKeyBytes?.fill(0);
    if (child?.connected) child.disconnect();
    if (child && !child.killed) child.kill('SIGTERM');
    if (connection) await Promise.race([connection.destroy().catch(() => {}), new Promise(r => setTimeout(r, 2_000))]);
    await unlink(helperPath).catch(() => {});
  }
}

if (process.argv.includes('--client') || process.env.BEATGALER_NATURAL_EXPIRY_CLIENT === '1') {
  await clientMain();
} else {
  await binderMain();
  process.exit(0);
}
