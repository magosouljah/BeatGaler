'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { SESSION_COOKIE } = require('../session-security');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

test('las guardas globales respetan el orden efectivo de la tabla en Cloud', async () => {
  const browser = { 'x-beatgaler-client': 'web' };
  let lifecycle;
  let restore = () => {};

  try {
    await withCloud(async (_app, send) => {
      const health = await send('GET', '/healthz');
      assert.equal(health.status, 200);
      assert.equal(health.headers['x-content-type-options'], undefined, 'operabilidad responde antes de las cabeceras');

      const login = await send('POST', '/auth/login', {
        headers: browser,
        body: { email: account.email, password: account.password, beatgalerUserId: account.beatgalerUserId },
      });
      assert.equal(login.status, 200);
      const cookie = login.headers['set-cookie'].find(value => value.startsWith(`${SESSION_COOKIE}=`)).split(';', 1)[0];
      const token = cookie.slice(SESSION_COOKIE.length + 1);
      lifecycle._test.revokedSessionHashes.add(createHash('sha256').update(token).digest('hex'));
      const headers = { ...browser, cookie };

      const deniedBySession = await send('POST', '/auth/lifecycle/status', { headers });
      assert.equal(deniedBySession.status, 403, deniedBySession.data);
      assert.equal(JSON.parse(deniedBySession.data).code, 'CSRF_REQUIRED');
      assert.equal(deniedBySession.headers['cache-control'], 'no-store', 'las cabeceras preceden a sesión');

      const deniedByLifecycle = await send('GET', '/plans/me', { headers });
      assert.equal(deniedByLifecycle.status, 401, 'sesión normaliza la cookie antes de que ciclo de vida la rechace');
      assert.equal(JSON.parse(deniedByLifecycle.data).code, 'SESSION_REQUIRED');
    }, {
      prepare() {
        const accountLifecycle = require('../account-lifecycle');
        const { installAccountLifecycle } = accountLifecycle;
        accountLifecycle.installAccountLifecycle = (...args) => {
          lifecycle = installAccountLifecycle(...args);
          return lifecycle;
        };
        restore = () => { accountLifecycle.installAccountLifecycle = installAccountLifecycle; };
      },
    });
  } finally {
    restore();
  }
});
