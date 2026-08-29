'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');
const {
  EMAIL_TEMPLATES,
  renderAccountEmail,
  signedSesRequest,
  createSesEmailNotifier,
} = require('../account-email-ses');
const {
  d8LifecycleEnv,
  installImmediateAccountDeletion,
  createProviderReauthCoordinator,
} = require('../d8-ro-resolutions');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function response() {
  return {
    statusCode: 200,
    body: null,
    sent: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.sent = value; return this; },
  };
}

function request({ token = '', body = {}, query = {}, params = {} } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: 'POST', path: '/', url: '/', headers, body, query, params };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function runSesContract() {
  assert.equal(EMAIL_TEMPLATES.email_verification.name, 'VERIFY_EMAIL');
  assert.equal(EMAIL_TEMPLATES.password_reset.name, 'RESET_PASSWORD');
  const verify = renderAccountEmail('email_verification', 'verify_secret_code', '2030-01-01T00:00:00.000Z');
  assert.equal(verify.template_name, 'VERIFY_EMAIL');
  const signed = signedSesRequest({
    region: 'us-east-1',
    fromEmail: 'security@example.com',
    to: 'user@example.com',
    content: verify,
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret-example-value',
      sessionToken: 'session-example',
    },
    now: new Date('2030-01-02T03:04:05.000Z'),
  });
  assert.match(signed.headers.Authorization, /\/20300102\/us-east-1\/ses\/aws4_request/);
  assert.equal(signed.body.includes('secret-example-value'), false);
  const payload = JSON.parse(signed.body);
  assert.equal(payload.EmailTags[0].Value, 'VERIFY_EMAIL');

  assert.throws(() => createSesEmailNotifier({
    env: { NODE_ENV: 'production' },
    credentialsProvider: async () => ({}),
  }), error => error?.code === 'SES_CONFIG_REQUIRED');

  const requests = [];
  const requestImpl = (options, callback) => {
    const req = new EventEmitter();
    req.write = body => { requests.push({ options, body }); };
    req.end = () => {
      const sesResponse = new EventEmitter();
      sesResponse.statusCode = 200;
      callback(sesResponse);
      process.nextTick(() => sesResponse.emit('end'));
    };
    req.destroy = error => req.emit('error', error);
    return req;
  };
  const notifier = createSesEmailNotifier({
    env: {
      NODE_ENV: 'production',
      BEATGALER_SES_REGION: 'us-west-2',
      BEATGALER_SES_FROM_EMAIL: 'security@beatgaler.example',
    },
    credentialsProvider: async () => ({ accessKeyId: 'AKID', secretAccessKey: 'SECRET' }),
    requestImpl,
    now: () => new Date('2031-05-06T07:08:09.000Z'),
  });
  const delivered = await notifier({
    kind: 'password_reset',
    to: 'person@example.com',
    token: 'reset_one_time_value',
    expires_at: '2031-05-06T07:23:09.000Z',
  });
  assert.equal(delivered.provider, 'amazon_ses');
  assert.equal(delivered.template, 'RESET_PASSWORD');
  assert.equal(JSON.parse(requests[0].body).EmailTags[0].Value, 'RESET_PASSWORD');
}

async function main() {
  await runSesContract();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-d8-ro-'));
  const clock = 1_900_000_000_000;
  const userId = 'usr_provider_only';
  const sessionOne = 'session-one';
  const sessionTwo = 'session-two';
  const sessionHashOne = sha256(sessionOne);
  const sessionHashTwo = sha256(sessionTwo);

  writeJson(path.join(dir, 'accounts-data.json'), {
    users: [{
      id: userId,
      username: 'provider#0001',
      email: 'provider@example.com',
      passwordSalt: null,
      passwordHash: null,
      providers: {
        google: { id: 'google-subject-1', email: 'provider@example.com' },
        x: { id: 'x-subject-1', username: 'provider_x' },
      },
    }],
    sessions: {
      [sessionHashOne]: { userId, createdAt: clock - 10, expiresAt: clock + 1000000 },
      [sessionHashTwo]: { userId, createdAt: clock - 5, expiresAt: clock + 1000000 },
    },
  });
  writeJson(path.join(dir, 'cloud-data.json'), {
    linkedAccounts: {
      install_a: { beatgalerAccountId: userId, storageChatId: '-100123' },
    },
    uploadedFiles: {
      file_a: { beatgalerUserId: 'install_a', beatId: 'beat-a' },
    },
    beatTopics: { 'install_a:beat-a': { messageThreadId: 7 } },
  });
  writeJson(path.join(dir, 'account-lifecycle-state.json'), {
    version: 1,
    tokens: {},
    email_verified: {},
    recovery: {},
    reauth: {},
    password_overrides: {},
    revoked_session_hashes: [],
    notifications: {},
    tombstones: {
      legacy_deleted: {
        receipt_id: 'legacy',
        subject_hash: sha256('legacy'),
        deleted_at: '2029-01-01T00:00:00.000Z',
        purge_at: '2029-01-01T00:00:00.000Z',
        retention_days: 0,
      },
    },
  });

  const capabilityRevokes = [];
  const runtime = createAccountLifecycleRuntime({
    dataDir: dir,
    env: d8LifecycleEnv({}),
    now: () => clock,
    getCapabilityStore: () => ({
      async revokeAuthSession(input) { capabilityRevokes.push(input); return 1; },
    }),
  });
  installImmediateAccountDeletion(runtime, { now: () => clock, randomBytes: size => Buffer.alloc(size, 7) });
  assert.equal(runtime.retentionConfigured, true);
  assert.deepEqual(runtime._test.stateSnapshot().tombstones, {}, 'legacy recoverable tombstones must be purged');

  const env = {
    BEATGALER_OAUTH_PUBLIC_BASE: 'https://api.beatgaler.example',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    X_CLIENT_ID: 'x-client',
    X_CLIENT_SECRET: 'x-secret',
  };
  let googleIdentity = 'google-subject-1';
  let xIdentity = 'x-subject-1';
  const fetchImpl = async url => {
    const target = String(url);
    if (target.includes('oauth2.googleapis.com/token') || target.includes('api.x.com/2/oauth2/token')) {
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ access_token: 'fresh-provider-access' }); },
      };
    }
    if (target.includes('openidconnect.googleapis.com')) {
      return { ok: true, status: 200, async json() { return { sub: googleIdentity }; } };
    }
    if (target.includes('api.x.com/2/users/me')) {
      return { ok: true, status: 200, async json() { return { data: { id: xIdentity } }; } };
    }
    throw new Error(`Unexpected URL ${target}`);
  };
  let randomCounter = 1;
  const randomBytes = size => Buffer.alloc(size, (randomCounter++ % 250) + 1);
  const coordinator = createProviderReauthCoordinator(runtime, {
    env,
    fetchImpl,
    now: () => clock,
    randomBytes,
  });

  const googleStart = response();
  coordinator.start(request({
    token: sessionOne,
    body: { purpose: 'reauth', provider: 'google' },
  }), googleStart, () => { throw new Error('reauth start must be handled'); });
  assert.equal(googleStart.statusCode, 200);
  assert.equal(googleStart.body.purpose, 'reauth');
  assert.match(googleStart.body.authorization_url, /prompt=login/);
  const googleState = new URL(googleStart.body.authorization_url).searchParams.get('state');

  const googleCallback = response();
  await coordinator.callback(request({
    query: { state: googleState, code: 'google-code' },
    params: { provider: 'google' },
  }), googleCallback, () => { throw new Error('reauth callback must be handled'); });
  assert.equal(googleCallback.statusCode, 200);

  const wrongSessionPoll = response();
  coordinator.poll(request({
    token: sessionTwo,
    body: { flowId: googleStart.body.flow_id },
  }), wrongSessionPoll, () => { throw new Error('completed reauth poll must be handled'); });
  assert.equal(wrongSessionPoll.statusCode, 401);
  assert.equal(wrongSessionPoll.body.code, 'REAUTH_SCOPE_DENIED');

  const googleStart2 = response();
  coordinator.start(request({
    token: sessionOne,
    body: { purpose: 'reauth', provider: 'google' },
  }), googleStart2, () => {});
  const googleState2 = new URL(googleStart2.body.authorization_url).searchParams.get('state');
  const googleCallback2 = response();
  await coordinator.callback(request({
    query: { state: googleState2, code: 'google-code-2' },
    params: { provider: 'google' },
  }), googleCallback2, () => {});
  const googlePoll = response();
  coordinator.poll(request({
    token: sessionOne,
    body: { flowId: googleStart2.body.flow_id },
  }), googlePoll, () => {});
  assert.equal(googlePoll.statusCode, 200);
  assert.match(googlePoll.body.reauth_token, /^reauth_/);

  const consumed = runtime._test.consumeReauth(request({ token: sessionOne }), googlePoll.body.reauth_token);
  assert.equal(consumed.ok, true);
  assert.equal(consumed.method, 'oauth:google');

  const xStart = response();
  coordinator.start(request({
    token: sessionOne,
    body: { purpose: 'reauth', provider: 'x' },
  }), xStart, () => {});
  const xUrl = new URL(xStart.body.authorization_url);
  assert.equal(xUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(xUrl.searchParams.get('code_challenge'));
  const xCallback = response();
  await coordinator.callback(request({
    query: { state: xUrl.searchParams.get('state'), code: 'x-code' },
    params: { provider: 'x' },
  }), xCallback, () => {});
  const xPoll = response();
  coordinator.poll(request({ token: sessionOne, body: { flowId: xStart.body.flow_id } }), xPoll, () => {});
  assert.equal(xPoll.statusCode, 200);
  assert.equal(xPoll.body.provider, 'x');

  googleIdentity = 'different-google-subject';
  const mismatchStart = response();
  coordinator.start(request({
    token: sessionOne,
    body: { purpose: 'reauth', provider: 'google' },
  }), mismatchStart, () => {});
  const mismatchState = new URL(mismatchStart.body.authorization_url).searchParams.get('state');
  const mismatchCallback = response();
  await coordinator.callback(request({
    query: { state: mismatchState, code: 'mismatch-code' },
    params: { provider: 'google' },
  }), mismatchCallback, () => {});
  assert.equal(mismatchCallback.statusCode, 400);
  const mismatchPoll = response();
  coordinator.poll(request({ token: sessionOne, body: { flowId: mismatchStart.body.flow_id } }), mismatchPoll, () => {});
  assert.equal(mismatchPoll.statusCode, 401);
  assert.equal(mismatchPoll.body.code, 'PROVIDER_REAUTH_MISMATCH');
  googleIdentity = 'google-subject-1';
  xIdentity = 'x-subject-1';

  const deleteGrant = runtime._test.issueReauth(userId, sessionHashOne, 'oauth:google');
  const deleteRes = response();
  await runtime._test.deleteAccount(request({
    token: sessionOne,
    body: { reauthToken: deleteGrant },
  }), deleteRes);
  assert.equal(deleteRes.statusCode, 200);
  assert.equal(deleteRes.body.deleted, true);
  assert.equal(deleteRes.body.receipt.retention_days, 0);
  assert.equal(deleteRes.body.receipt.recoverable_tombstone, false);
  assert.equal(deleteRes.body.receipt.purge_at, deleteRes.body.receipt.deleted_at);
  assert.deepEqual(runtime._test.stateSnapshot().tombstones, {});
  assert.equal(runtime._test.accountsSnapshot().users.some(user => user.id === userId), false);
  assert.equal(Object.keys(runtime._test.cloudSnapshot().linkedAccounts || {}).includes('install_a'), false);
  assert.ok(capabilityRevokes.length >= 2);

  const persistedState = JSON.parse(fs.readFileSync(path.join(dir, 'account-lifecycle-state.json'), 'utf8'));
  assert.deepEqual(persistedState.tombstones, {}, 'no recoverable account tombstone may remain on disk');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('d8-ro-resolutions: PASS');
}

module.exports = { runD8RoResolutionsTests: main };

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
