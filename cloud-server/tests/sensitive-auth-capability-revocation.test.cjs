'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { installSensitiveAuthCapabilityRevocation } = require('../sensitive-auth-capability-revocation');

function createFakeExpress() {
  const routes = new Map();
  const application = {
    post(routePath, ...handlers) {
      routes.set(routePath, handlers);
      return application;
    },
  };
  return { application, routes };
}

async function runRoute(handlers, req) {
  let resolveSent;
  const sent = new Promise(resolve => { resolveSent = resolve; });
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = Number(code);
      return this;
    },
    json(payload) {
      resolveSent({ statusCode: this.statusCode, payload });
      return this;
    },
  };
  let index = 0;
  const next = async () => {
    const handler = handlers[index++];
    if (!handler) return;
    return handler(req, res, next);
  };
  await next();
  return sent;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('sensitive auth capability revoke commits before password mutation and ignores body installation hints', async () => {
  const events = [];
  let revokeInput = null;
  const store = {
    async revokeAuthSession(input) {
      events.push('revoke');
      revokeInput = input;
      return 1;
    },
  };
  const fakeExpress = createFakeExpress();
  installSensitiveAuthCapabilityRevocation(fakeExpress, { store });
  fakeExpress.application.post('/auth/password/change', (_req, res) => {
    events.push('mutation');
    return res.json({ ok: true });
  });

  const result = await runRoute(fakeExpress.routes.get('/auth/password/change'), {
    headers: { authorization: 'Bearer session-secret' },
    body: { beatgalerUserId: 'spoofed-installation', currentPassword: 'x', newPassword: 'y' },
  });

  assert.deepEqual(events, ['revoke', 'mutation']);
  assert.deepEqual(revokeInput, {
    authSessionHash: hash('session-secret'),
    reason: 'password_change',
  });
  assert.equal(Object.hasOwn(revokeInput, 'installationId'), false);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.payload, { ok: true });
});

test('revoke failure prevents sensitive auth mutation from executing', async () => {
  let mutationRan = false;
  const store = {
    async revokeAuthSession() {
      throw new Error('injected durable revoke failure');
    },
  };
  const fakeExpress = createFakeExpress();
  installSensitiveAuthCapabilityRevocation(fakeExpress, { store });
  fakeExpress.application.post('/auth/account/delete', (_req, res) => {
    mutationRan = true;
    return res.json({ ok: true });
  });

  const result = await runRoute(fakeExpress.routes.get('/auth/account/delete'), {
    headers: { authorization: 'Bearer session-secret' },
    body: {},
  });

  assert.equal(mutationRan, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.code, 'DIRECT_CAPABILITY_REVOKE_FAILED');
});

test('logout uses the same pre-mutation revoke ordering', async () => {
  const events = [];
  const store = {
    async revokeAuthSession(input) {
      events.push(`revoke:${input.reason}`);
      return 0;
    },
  };
  const fakeExpress = createFakeExpress();
  installSensitiveAuthCapabilityRevocation(fakeExpress, { store });
  fakeExpress.application.post('/auth/logout', (_req, res) => {
    events.push('logout');
    return res.json({ ok: true });
  });

  const result = await runRoute(fakeExpress.routes.get('/auth/logout'), {
    headers: { authorization: 'Bearer session-secret' },
    body: {},
  });

  assert.deepEqual(events, ['revoke:logout', 'logout']);
  assert.equal(result.statusCode, 200);
});
