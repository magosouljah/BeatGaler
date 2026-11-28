'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createGuardContext, mountAccountRouteGuards, SELF_REGISTERED_ROUTES } = require('../account-route-guards');
const { installAuthPublicRegistrationHardening } = require('../auth-public-registration-hardening');
const pendingSignup = require('../pending-signup-boundary');
const { installStagedEmailChangeRoutes } = require('../staged-email-change-routes');
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

async function checkInactiveRegistration() {
  const routes = new Map();
  const app = { post(path, ...handlers) { routes.set(path, handlers); } };
  const express = { application: app, json: () => (_req, _res, next) => next() };
  const env = { BEATGALER_PUBLIC_REGISTRATION: '1', BEATGALER_PENDING_SIGNUP_ENABLED: '0' };
  const ctx = createGuardContext();
  installAuthPublicRegistrationHardening(ctx, { env });
  const signup = pendingSignup.installPendingSignupBoundary(express, { env });
  mountAccountRouteGuards(app, undefined, ctx);
  app.post('/auth/register', () => assert.fail('el handler heredado no debe ejecutarse'));
  assert.equal(signup.captured().register, true);

  const handlers = routes.get('/auth/register').values();
  const result = await new Promise(resolve => {
    const req = { path: '/auth/register', body: {} };
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, code: body.code }); },
    };
    const next = () => handlers.next().value(req, res, next);
    next();
  });
  assert.deepEqual(result, { status: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
}

test('las guardas globales y por ruta respetan el orden efectivo de la tabla en Cloud', async () => {
  const browser = { 'x-beatgaler-client': 'web' };
  let lifecycle;
  let hardeningOptions;
  const signupCalls = [];
  const emailChanges = [];
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
      assert.equal(firstPost, SELF_REGISTERED_ROUTES.length);
      assert.deepEqual(paths.slice(0, firstPost), SELF_REGISTERED_ROUTES);
      for (const path of SELF_REGISTERED_ROUTES) assert.equal(paths.filter(value => value === path).length, 1, path);
      await checkBoundaryRegistration(app);
      // El hardening se instala antes que el ciclo de vida: debe resolverlo de forma perezosa.
      assert.ok(lifecycle);
      assert.equal(hardeningOptions.getAccountLifecycle(), lifecycle, 'el hardening ve el ciclo de vida instalado después');

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

      const signupBody = { email: 'pending@example.test', username: 'pending', password: account.password };
      const deniedSignup = await send('POST', '/auth/register', {
        headers: browser, body: { ...signupBody, beatgalerUserId: account.beatgalerUserId },
      });
      assert.equal(deniedSignup.status, 403, deniedSignup.data);
      assert.deepEqual(signupCalls, []);
      const acceptedSignup = await send('POST', '/auth/register', {
        headers: browser, body: { ...signupBody, beatgalerUserId: 'unclaimed-fixture' },
      });
      assert.equal(acceptedSignup.status, 202, acceptedSignup.data);
      assert.equal(JSON.parse(acceptedSignup.data).signup_pending, true);
      assert.deepEqual(signupCalls.map(input => input.installationId), ['unclaimed-fixture']);

      const csrf = JSON.parse(login.data).csrf_token;
      const authorized = {
        ...browser,
        cookie: login.headers['set-cookie'].map(value => value.split(';', 1)[0]).join('; '),
        'x-beatgaler-csrf': csrf,
      };
      const email = 'new@example.test';
      const staged = await send('POST', '/auth/email/change/start', { headers: authorized, body: { email } });
      assert.equal(staged.status, 202, staged.data);
      assert.deepEqual(emailChanges, [email]);
      const reauth = await send('POST', '/auth/reauth', { headers: authorized, body: { password: account.password } });
      assert.equal(reauth.status, 200, reauth.data);
      assert.match(JSON.parse(reauth.data).reauth_token, /^reauth_/);

      // Un estado D8 real (iniciado por la ruta) se resuelve antes de que la contención OAuth busque un flujo heredado.
      const started = await send('POST', '/auth/oauth/start', { headers: authorized, body: { purpose: 'reauth', provider: 'google' } });
      assert.equal(started.status, 200, started.data);
      const state = new URL(JSON.parse(started.data).authorization_url).searchParams.get('state');
      assert.ok(state);
      const callbackPath = `/auth/oauth/google/callback?state=${state}&error=access_denied`;
      const oauth = await send('GET', callbackPath);
      assert.equal(oauth.status, 400);
      assert.match(oauth.data, /BeatGaler reauthentication failed/);
      const replay = await send('GET', callbackPath);
      assert.doesNotMatch(replay.data, /BeatGaler reauthentication failed/, 'el flujo D8 queda consumido');

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
        accountLifecycle.installAccountLifecycle = (ctx, options) => {
          lifecycle = installAccountLifecycle(ctx, options);
          installStagedEmailChangeRoutes(options.express, {
            async start(_req, email) { emailChanges.push(email); return { ok: true }; },
          });
          return lifecycle;
        };
        const hardening = require('../auth-public-registration-hardening');
        const installHardening = hardening.installAuthPublicRegistrationHardening;
        hardening.installAuthPublicRegistrationHardening = (ctx, options) => {
          hardeningOptions = options;
          return installHardening(ctx, options);
        };
        const { installPendingSignupBoundary } = pendingSignup;
        pendingSignup.installPendingSignupBoundary = (express, options) =>
          installPendingSignupBoundary(express, {
            ...options,
            service: { async begin(input) { signupCalls.push(input); return { created: false }; } },
          });
        Object.assign(process.env, {
          BEATGALER_OAUTH_PUBLIC_BASE: 'https://oauth.example.test',
          GOOGLE_CLIENT_ID: 'fixture-client',
          GOOGLE_CLIENT_SECRET: 'fixture-secret',
        });
        const durable = require('../auth-durable-abuse-controls');
        const { installDurableAuthAbuseControls } = durable;
        const pool = { async query() { return { rows: [{ request_count: 1 }] }; } };
        durable.installDurableAuthAbuseControls = (express, options) =>
          installDurableAuthAbuseControls(express, { ...options, pool });
        restore = () => {
          accountLifecycle.installAccountLifecycle = installAccountLifecycle;
          hardening.installAuthPublicRegistrationHardening = installHardening;
          durable.installDurableAuthAbuseControls = installDurableAuthAbuseControls;
          pendingSignup.installPendingSignupBoundary = installPendingSignupBoundary;
        };
      },
      restoreState(stateDir) {
        const file = path.join(stateDir, 'accounts-data.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        data.users[0].providers = { google: { id: 'google-fixture' } };
        fs.writeFileSync(file, JSON.stringify(data));
      },
    });
  } finally {
    restore();
  }
  await checkInactiveRegistration();
});
