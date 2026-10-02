'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-managed-token-retry-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
const diagnosticsDir = path.join(tmp, 'diagnostics');
const diagnosticsFile = path.join(diagnosticsDir, 'telegram-direct-control.txt');
const managerSecret = 'manager-token-must-not-appear';
const returnedSecret = 'managed-token-must-not-appear';

fs.writeFileSync(poolFile, JSON.stringify({ bots: [{
  id: 'BotTest',
  managed: true,
  telegram_user_id: '12345',
  telegram_username: 'BeatGalerRetryTestBot',
  manager_token_env: 'MANAGER_RETRY_TEST_TOKEN',
}] }));

process.env.TRANSPORT_BOTS_FILE = poolFile;
process.env.TRANSPORT_POOL_STATE = stateFile;
process.env.DIRECT_DIAGNOSTICS_DIR = diagnosticsDir;
process.env.BEATGALER_DIRECT_TRANSPORT = 'false';
process.env.MANAGER_RETRY_TEST_TOKEN = managerSecret;

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') return { TelegramClient: class {}, Api: {} };
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, parent, isMain);
};

const direct = require('../direct-transport-control.js');
const bot = JSON.parse(fs.readFileSync(poolFile, 'utf8')).bots[0];

function transientFetchError() {
  const cause = Object.assign(new Error('socket hang up'), {
    code: 'ECONNRESET',
    errno: 'ECONNRESET',
  });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

function ok(result) {
  return {
    ok: true,
    status: 200,
    async json() { return { ok: true, result }; },
  };
}

function apiFailure(status, description) {
  return {
    ok: false,
    status,
    async json() { return { ok: false, error_code: status, description }; },
  };
}

function resetHarness() {
  direct.__test.resetManagedTokenFetchTestHooks();
  direct.__test.setManagedTokenFetchRetryPolicy({ attempts: 3, baseMs: 0, maxMs: 0 });
  fs.rmSync(diagnosticsDir, { recursive: true, force: true });
}

test.after(() => {
  direct.__test.resetManagedTokenFetchTestHooks();
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('managed token fetch retries a transient network failure and then succeeds', async () => {
  resetHarness();
  let calls = 0;
  direct.__test.setManagerBotFetch(async () => {
    calls += 1;
    if (calls === 1) throw transientFetchError();
    return ok(returnedSecret);
  });

  assert.equal(await direct.__test.resolveManagedToken(bot), returnedSecret);
  assert.equal(calls, 2);
  const log = fs.readFileSync(diagnosticsFile, 'utf8');
  assert.match(log, /MANAGED_TOKEN_FETCH_RETRY/);
  assert.match(log, /MANAGED_TOKEN_FETCH_RECOVERED/);
  assert.match(log, /"attempt":1/);
  assert.match(log, /"cause_code":"ECONNRESET"/);
});

test('managed token fetch exhausts only its bounded transient retry budget', async () => {
  resetHarness();
  let calls = 0;
  direct.__test.setManagerBotFetch(async () => {
    calls += 1;
    throw transientFetchError();
  });

  await assert.rejects(() => direct.__test.resolveManagedToken(bot), /fetch failed/);
  assert.equal(calls, 3);
  const log = fs.readFileSync(diagnosticsFile, 'utf8');
  assert.equal((log.match(/MANAGED_TOKEN_FETCH_RETRY/g) || []).length, 2);
  assert.equal((log.match(/MANAGED_TOKEN_FETCH_FAILED/g) || []).length, 1);
  assert.match(log, /"attempt":3/);
  assert.match(log, /"retryable":true/);
});

test('managed token fetch bounds a hung fetch and retries its timeout', async () => {
  resetHarness();
  direct.__test.setManagedTokenFetchRetryPolicy({ attempts: 3, baseMs: 0, maxMs: 0, timeoutMs: 5 });
  let calls = 0;
  direct.__test.setManagerBotFetch(async (_url, options) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      // AbortSignal.timeout() intentionally does not keep Node alive; a real
      // fetch owns a socket, so keep this isolated hung-fetch mock alive too.
      const keepAlive = setInterval(() => {}, 25);
      options.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        reject(options.signal.reason);
      }, { once: true });
    });
  });

  await assert.rejects(() => direct.__test.resolveManagedToken(bot));
  assert.equal(calls, 3);
  const log = fs.readFileSync(diagnosticsFile, 'utf8');
  assert.equal((log.match(/MANAGED_TOKEN_FETCH_RETRY/g) || []).length, 2);
  assert.match(log, /"error_class":"TimeoutError"/);
  assert.match(log, /"timeout_ms":5/);
});

test('managed token fetch does not retry definitive Telegram API responses', async () => {
  resetHarness();
  let calls = 0;
  direct.__test.setManagerBotFetch(async () => {
    calls += 1;
    return apiFailure(401, 'Unauthorized');
  });

  await assert.rejects(() => direct.__test.resolveManagedToken(bot), /Unauthorized/);
  assert.equal(calls, 1);
  const log = fs.readFileSync(diagnosticsFile, 'utf8');
  assert.match(log, /MANAGED_TOKEN_FETCH_FAILED/);
  assert.doesNotMatch(log, /MANAGED_TOKEN_FETCH_RETRY/);
  assert.match(log, /"retryable":false/);
});

test('managed token diagnostics never serialize manager or managed token secrets', async () => {
  resetHarness();
  direct.__test.setManagerBotFetch(async () => {
    throw transientFetchError();
  });

  await assert.rejects(() => direct.__test.resolveManagedToken(bot));
  const log = fs.readFileSync(diagnosticsFile, 'utf8');
  assert.doesNotMatch(log, new RegExp(managerSecret));
  assert.doesNotMatch(log, new RegExp(returnedSecret));
  assert.doesNotMatch(log, /https:\/\/api\.telegram\.org\/bot/);
});

test('a fetched managed token serves concurrent and later sessions until credential version changes', async () => {
  resetHarness();
  let calls = 0;
  direct.__test.setManagerBotFetch(async () => {
    calls += 1;
    return ok(calls === 1 ? returnedSecret : `${returnedSecret}-rotated`);
  });

  const first = await Promise.all([
    direct.__test.tokenForCredentialVersion(bot, 77),
    direct.__test.tokenForCredentialVersion(bot, 77),
  ]);
  assert.deepEqual(first, [returnedSecret, returnedSecret]);
  assert.equal(calls, 1);

  direct.__test.setManagerBotFetch(async () => { throw transientFetchError(); });
  assert.equal(await direct.__test.tokenForCredentialVersion(bot, 77), returnedSecret);
  assert.equal(calls, 1);

  direct.__test.setManagerBotFetch(async () => {
    calls += 1;
    return ok(`${returnedSecret}-rotated`);
  });
  assert.equal(await direct.__test.tokenForCredentialVersion(bot, 78), `${returnedSecret}-rotated`);
  assert.equal(calls, 2);
});
