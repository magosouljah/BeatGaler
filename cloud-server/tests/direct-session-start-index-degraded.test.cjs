'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server-core.js'), 'utf8');
const routeStart = source.indexOf('app.post("/transport/session/start",');
const routeEnd = source.indexOf('app.post("/transport/session/activate",', routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart);
const routeSource = source.slice(routeStart, routeEnd);

function sessionStartWithMigrationFailure(failure, { sessionFailure } = {}) {
  const calls = { migrate: [], start: [], warnings: [], errors: [], outcomes: [] };
  let handler;
  const context = {
    app: { post(_route, callback) { handler = callback; } },
    criticalPathTrace: {
      write() {},
      step(_req, _stage, operation) { return operation(); },
    },
    authenticatedTransportAccount() {
      return { beatgalerUserId: 'installation-1', user: { id: 'user-1' },
        account: { beatgalerAccountId: 'account-1' } };
    },
    storageChatId() { return '-100123'; },
    createDirectStartupTrace() {
      return { mark() {}, publish(_res, outcome) { calls.outcomes.push(outcome); } };
    },
    libraryIndexPublication: {
      async migrateLegacyProjects(input) { calls.migrate.push(input); if (failure) throw failure; },
    },
    directTransport: {
      async startSession(input) {
        calls.start.push(input);
        if (sessionFailure) throw sessionFailure;
        return { session_id: 'session-1' };
      },
    },
    vaultIndexPointers: { async getForChat() { return null; } },
    wrapWebTransportSession(session) { return session; },
    console: {
      warn(...args) { calls.warnings.push(args); },
      error(...args) { calls.errors.push(args); },
    },
  };
  vm.runInNewContext(routeSource, context, { filename: 'server-core.js' });
  assert.equal(typeof handler, 'function');
  const response = {
    statusCode: 200,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  return handler({ body: {} }, response).then(() => ({ calls, response }));
}

test('a missing-message error from startSession is still fatal', async () => {
  const failure = Object.assign(new Error('session failed'), { code: 'TELEGRAM_MESSAGE_MISSING', messageId: 250 });
  const { calls, response } = await sessionStartWithMigrationFailure(null, { sessionFailure: failure });
  assert.equal(response.statusCode, 503);
  assert.equal(calls.migrate.length, 1);
  assert.equal(calls.start.length, 1);
  assert.equal(calls.warnings.length, 0);
  assert.deepEqual(calls.outcomes, ['error']);
});

for (const code of ['TELEGRAM_MESSAGE_MISSING', 'TELEGRAM_MESSAGE_NO_MEDIA']) {
  test(`${code} from legacy migration allows Direct session start`, async () => {
    const failure = Object.assign(new Error('INDEX 250 unavailable'), { code, messageId: 250 });
    const { calls, response } = await sessionStartWithMigrationFailure(failure);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.session_id, 'session-1');
    assert.equal(calls.migrate.length, 1);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0].chatId, '-100123');
    assert.deepEqual(calls.outcomes, ['done']);
    assert.equal(calls.warnings.length, 1);
    const warning = calls.warnings[0][1];
    assert.equal(warning.event, 'vault_recovery_degraded');
    assert.equal(warning.phase, 'session_start_legacy_projects');
    assert.equal(warning.chat_id, '-100123');
    assert.equal(warning.code, code);
    assert.equal(warning.message_id, 250);
  });
}

for (const [name, failure] of [
  ['unknown', new Error('unexpected migration failure')],
  ['PostgreSQL', Object.assign(new Error('database unavailable'), { code: '08006' })],
]) {
  test(`${name} migration error remains fatal to session start`, async () => {
    const { calls, response } = await sessionStartWithMigrationFailure(failure);
    assert.equal(response.statusCode, 503);
    assert.match(response.payload.error, /Cloud session unavailable/);
    assert.equal(calls.start.length, 0);
    assert.deepEqual(calls.outcomes, ['error']);
    assert.equal(calls.warnings.length, 0);
    assert.equal(calls.errors.length, 1);
  });
}
