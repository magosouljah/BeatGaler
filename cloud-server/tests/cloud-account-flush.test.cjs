'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

const loginBody = { email: account.email, password: account.password, beatgalerUserId: account.beatgalerUserId };
const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1', host: '127.0.0.1' };
const persistenceError = { error: 'Control-plane persistence unavailable. Request was not acknowledged.' };

function fakePersistence(initial) {
  let nextFlush;
  let staged = structuredClone(initial);
  let durable = structuredClone(initial);
  return {
    saveAuthSnapshot(auth) { staged.auth = auth; },
    savePersistentSnapshot(persistent) { staged.persistent = persistent; },
    async flush() {
      const gate = nextFlush;
      nextFlush = undefined;
      if (gate) {
        gate.enter();
        await gate.released;
      }
      durable = structuredClone(staged);
    },
    holdNextFlush() {
      const entered = Promise.withResolvers();
      const released = Promise.withResolvers();
      nextFlush = { enter: entered.resolve, released: released.promise };
      return { entered: entered.promise, commit: released.resolve, fail: released.reject };
    },
    staged: () => staged,
    durable: () => durable,
  };
}

function sessionFromCookies(response) {
  const cookies = response.headers['set-cookie'].map(value => value.split(';', 1)[0]);
  const token = cookies.find(value => value.startsWith('__Host-beatgaler_session=')).split('=')[1];
  return {
    hash: createHash('sha256').update(token).digest('hex'),
    headers: { ...browser, cookie: cookies.join('; '), 'x-beatgaler-csrf': cookies[1].split('=')[1] },
  };
}

function installFakeCutover(stateDir, { sends, errors, onInstall }) {
  const cutover = require('../control-plane-cutover-runtime');
  const prepareCutover = cutover.prepareControlPlaneCutover;
  const { installLegacyJsonCompatibility, installExpressDurabilityBarrier } = require('../control-plane-json-compat');
  let restorePersistence;
  cutover.prepareControlPlaneCutover = async options => {
    const config = await prepareCutover(options);
    const express = require('express');
    const authPath = path.join(stateDir, 'accounts-data.json');
    const initialAuth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const initialPersistent = {};
    const runtime = fakePersistence({ auth: initialAuth, persistent: initialPersistent });
    const uninstallJson = installLegacyJsonCompatibility({
      fsModule: fs, runtime, authPath, persistentPath: path.join(stateDir, 'cloud-data.json'),
      initialAuth, initialPersistent,
    });
    const originalSend = express.response.send;
    express.response.send = function observedSend(body) {
      sends.push(this.req.path);
      return originalSend.call(this, body);
    };
    const uninstallBarrier = installExpressDurabilityBarrier(express, runtime, {
      logger: { error: (...args) => errors.push(args.at(-1)) },
    });
    restorePersistence = () => {
      uninstallBarrier();
      express.response.send = originalSend;
      uninstallJson();
      delete fs[Symbol.for('beatgaler.accountLifecyclePersistenceFilter')];
    };
    onInstall(runtime);
    return config;
  };
  return () => {
    restorePersistence?.();
    cutover.prepareControlPlaneCutover = prepareCutover;
  };
}

test('Barrera de persistencia en mutaciones HTTP de cuenta', async t => {
  const sends = [];
  const errors = [];
  let runtime;
  let restore;
  try {
    await withCloud(async (_app, send) => {
      const post = (route, headers = browser, body = {}) => send('POST', '/auth/' + route, { headers, body });
      async function whileFlushing(route, headers, body, inspect, error) {
        const gate = runtime.holdNextFlush();
        const count = sends.length;
        const response = post(route, headers, body);
        try {
          await Promise.race([gate.entered, response.then(() => assert.fail('La respuesta salió sin iniciar flush'))]);
          assert.equal(sends.length, count, 'La respuesta salió antes de completar flush');
          inspect();
        } finally {
          if (error) gate.fail(new Error(error));
          else gate.commit();
          await response;
        }
        return response;
      }

      await t.test('Login confirma después de persistir la sesión y la instalación', async () => {
        const login = await whileFlushing('login', browser, loginBody, () => {
          assert.deepEqual(runtime.durable().auth.sessions, {});
          assert.equal(runtime.durable().persistent.linkedAccounts?.[account.beatgalerUserId], undefined);
          assert.equal(Object.keys(runtime.staged().auth.sessions).length, 1);
          assert.equal(runtime.staged().persistent.linkedAccounts[account.beatgalerUserId].beatgalerAccountId, account.id);
        });
        assert.equal(login.status, 200);
        const { hash } = sessionFromCookies(login);
        assert.equal(runtime.durable().auth.sessions[hash].userId, account.id);
        assert.equal(runtime.durable().persistent.linkedAccounts[account.beatgalerUserId].beatgalerAccountId, account.id);
      });

      await t.test('Login con flush fallido responde 503 y deja la sesión solo en la vista virtual', async () => {
        const durableBefore = runtime.durable();
        const login = await whileFlushing('login', browser, loginBody, () => {
          assert.equal(Object.keys(runtime.staged().auth.sessions).length, 2);
          assert.deepEqual(runtime.durable(), durableBefore);
        }, 'fake login write failed');
        assert.equal(login.status, 503);
        assert.match(login.headers['content-type'], /^application\/json\b/);
        assert.deepEqual(JSON.parse(login.data), persistenceError);
        // La decoración de sesión ya había preparado las cookies antes del 503.
        const { hash } = sessionFromCookies(login);
        assert.equal(runtime.staged().auth.sessions[hash].userId, account.id);
        assert.equal(runtime.durable().auth.sessions[hash], undefined);
        assert.deepEqual(runtime.durable(), durableBefore);
        assert.deepEqual(errors, ['fake login write failed']);
      });

      await t.test('Un 503 de MFA setup omite el secreto y deja el alta pendiente solo en la vista virtual', async () => {
        const { headers } = sessionFromCookies(await post('login', browser, loginBody));
        const durableBefore = runtime.durable();
        const setup = await whileFlushing('mfa/setup', headers, {}, () => {
          assert.match(runtime.staged().auth.users[0].pendingMfaSecret, /^[A-Z2-7]+$/);
          assert.equal(runtime.durable().auth.users[0].pendingMfaSecret, undefined);
        }, 'fake MFA write failed');
        assert.equal(setup.status, 503);
        assert.deepEqual(JSON.parse(setup.data), persistenceError);
        assert.equal(setup.headers['set-cookie'], undefined);
        assert.match(runtime.staged().auth.users[0].pendingMfaSecret, /^[A-Z2-7]+$/);
        assert.deepEqual(runtime.durable(), durableBefore);
        assert.equal(errors.at(-1), 'fake MFA write failed');
      });

      await t.test('Logout con flush fallido responde 503 y conserva la revocación en el proceso', async () => {
        const { hash, headers } = sessionFromCookies(await post('login', browser, loginBody));
        const durableBefore = runtime.durable();
        assert.equal(durableBefore.auth.sessions[hash].userId, account.id);
        const logout = await whileFlushing('logout', headers, { beatgalerUserId: account.beatgalerUserId }, () => {
          assert.equal(runtime.staged().auth.sessions[hash], undefined);
          assert.equal(runtime.staged().persistent.linkedAccounts[account.beatgalerUserId], undefined);
          assert.deepEqual(runtime.durable(), durableBefore);
        }, 'fake logout write failed');
        assert.equal(logout.status, 503);
        assert.deepEqual(JSON.parse(logout.data), persistenceError);
        assert.deepEqual(logout.headers['set-cookie'].map(value => value.split(';', 1)[0]),
          ['__Host-beatgaler_session=', '__Host-beatgaler_csrf=']);
        assert.deepEqual(runtime.durable(), durableBefore);
        assert.equal(errors.at(-1), 'fake logout write failed');
        const replay = await post('sessions', headers);
        assert.equal(replay.status, 401);
        assert.equal(JSON.parse(replay.data).code, 'SESSION_REVOKED');
      });
    }, {
      requestTimeoutMs: 10_000,
      prepare(dir) {
        restore = installFakeCutover(dir, { sends, errors, onInstall: value => { runtime = value; } });
      },
    });
  } finally {
    restore?.();
  }
});

test('Un flush fallido destruye una respuesta cuyas cabeceras ya salieron', async () => {
  const { installExpressDurabilityBarrier } = require('../control-plane-json-compat');
  const failure = new Error('fake write failed after headers');
  const destroyed = Promise.withResolvers();
  const express = { response: { send() { assert.fail('No se puede volver a enviar una respuesta iniciada'); } } };
  const uninstall = installExpressDurabilityBarrier(express, { flush: () => Promise.reject(failure) }, {
    logger: { error() {} },
  });
  try {
    express.response.send.call({ headersSent: true, destroy: destroyed.resolve }, 'success');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await Promise.race([destroyed.promise, Promise.resolve(null)]), failure);
  } finally {
    uninstall();
  }
});
