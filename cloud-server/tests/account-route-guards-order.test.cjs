'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { SESSION_COOKIE } = require('../session-security');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

function postRoutes(app) {
  return app.router.stack.map(layer => layer.route).filter(route => route?.methods.post);
}

async function checkBoundaryRegistration(app) {
  app.post('/transport/session/start', (_req, res) => {
    res.json({ ok: false, error: 'denied', bot_token: 'fixture-only' });
  });
  const tempAuth = postRoutes(app).find(route => route.path === '/transport/session/start');
  const handlers = tempAuth.stack.map(layer => layer.handle).values();
  const payload = await new Promise(resolve => {
    const req = { path: tempAuth.path, body: {} };
    const res = { json: resolve };
    const next = () => handlers.next().value(req, res, next);
    next();
  });
  assert.deepEqual(payload, { ok: false, error: 'denied' });

  app.post('/beats/upload', () => assert.fail('legacy upload must not reach Multer'), () => {});
  const legacy = postRoutes(app).find(route => route.path === '/beats/upload');
  assert.equal(legacy.stack.length, 1, 'legacy deny replaces HTTP containment and Multer');
  const res = {
    status(code) { this.statusCode = code; return this; },
    json() {},
  };
  legacy.stack[0].handle({}, res);
  assert.equal(res.statusCode, 410);
}

test('las guardas globales y por ruta respetan el orden efectivo de la tabla en Cloud', async () => {
  const browser = { 'x-beatgaler-client': 'web' };
  let lifecycle;
  let restore = () => {};

  try {
    await withCloud(async (app, send) => {
      const expected = {
        '/auth/login': ['decorateSessionResponse', 'guardLoginInstallation', 'bindSessionOnSuccess', 'enforceDurableAuthAbuse', 'middleware'],
        '/auth/register': ['decorateSessionResponse', 'registrationGate', 'guardRegisterInstallation', 'bindSessionOnSuccess', 'enforceDurableAuthAbuse', 'middleware'],
        '/auth/logout': ['decorateSessionResponse', 'logoutSession', 'revokeAuthOnSuccessResponse', 'revokeBeforeMutation'],
      };
      const routes = postRoutes(app);
      for (const [path, guards] of Object.entries(expected)) {
        const route = routes.find(route => route.path === path);
        assert.ok(route, path);
        assert.deepEqual(route.stack.slice(-guards.length - 1, -1).map(layer => layer.handle.name), guards, path);
      }
      const paths = routes.map(route => route.path);
      const firstPost = paths.indexOf('/webhooks/polar');
      assert.ok(firstPost >= 3);
      assert.deepEqual(paths.slice(firstPost - 3, firstPost), [
        '/auth/sessions', '/auth/sessions/revoke', '/auth/sessions/revoke-all',
      ]);
      await checkBoundaryRegistration(app);

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
        const durable = require('../auth-durable-abuse-controls');
        const { installDurableAuthAbuseControls } = durable;
        const pool = { async query() { return { rows: [{ request_count: 1 }] }; } };
        durable.installDurableAuthAbuseControls = (express, options) =>
          installDurableAuthAbuseControls(express, { ...options, pool });
        restore = () => {
          accountLifecycle.installAccountLifecycle = installAccountLifecycle;
          durable.installDurableAuthAbuseControls = installDurableAuthAbuseControls;
        };
      },
    });
  } finally {
    restore();
  }
});
