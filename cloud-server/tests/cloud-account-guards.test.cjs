'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');
const pendingSignup = require('../pending-signup-boundary');
const sessionSecurity = require('../session-security');

const sessionName = '__Host-beatgaler_session';
const csrfName = '__Host-beatgaler_csrf';
const csrfHeader = 'x-beatgaler-csrf';
const origin = 'http://127.0.0.1';
const browser = { 'x-beatgaler-client': 'web', origin, host: '127.0.0.1' };
const installation = { beatgalerUserId: account.beatgalerUserId };
const loginBody = { email: account.email, password: account.password, ...installation };
const signup = {
  created: true,
  signup_id: 'signup-fixture',
  continuation_secret: 'continuation-fixture',
  status: 'CHECK_EMAIL',
  expires_at: '2099-01-01T00:00:00.000Z',
  challenge_expires_at: '2098-12-31T23:45:00.000Z',
};

function json(response, status) {
  assert.equal(response.status, status, response.data);
  assert.match(response.headers['content-type'], /^application\/json\b/);
  return JSON.parse(response.data);
}

function errorCode(response, status, code) {
  assert.equal(json(response, status).code, code);
}

function cookie(name, value, { httpOnly = false, sameSite = 'Strict', age = 2592000 } = {}) {
  return `${name}=${value}; Path=/; Max-Age=${age}${httpOnly ? '; HttpOnly' : ''}; Secure; SameSite=${sameSite}`;
}

function webSession(response, sameSite = 'Strict') {
  const body = json(response, 200);
  assert.equal(body.session_transport, 'cookie');
  assert.equal(Object.hasOwn(body, 'token'), false);
  const cookies = response.headers['set-cookie'];
  assert.equal(cookies?.length, 2);
  const token = cookies[0].match(/^__Host-beatgaler_session=([^;]+)/)?.[1];
  assert.ok(token, 'La cookie de sesión debe tener un valor');
  assert.match(body.csrf_token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(cookies, [
    cookie(sessionName, token, { httpOnly: true, sameSite }),
    cookie(csrfName, body.csrf_token, { sameSite }),
  ]);
  return {
    cookie: cookies.map(value => value.split(';', 1)[0]).join('; '),
    [csrfHeader]: body.csrf_token,
  };
}

function clearsCookies(response) {
  assert.deepEqual(response.headers['set-cookie'], [
    cookie(sessionName, '', { httpOnly: true, age: 0 }),
    cookie(csrfName, '', { age: 0 }),
  ]);
}

function securityHeaders({ headers }) {
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers.pragma, 'no-cache');
}

test('Cuentas y sesión en el ensamblado HTTP de Cloud', async t => {
  // Sustituye la dependencia de PG/SES del alta. El instalador y el handler
  // que decide cuándo y cómo responder siguen siendo los de producción.
  const installPendingSignupBoundary = pendingSignup.installPendingSignupBoundary;
  const signupInputs = [];
  pendingSignup.installPendingSignupBoundary = (express, options) =>
    installPendingSignupBoundary(express, {
      ...options,
      service: {
        async begin(input) {
          signupInputs.push(input);
          return signup;
        },
      },
    });

  // Captura el runtime de sesión que instala server.js (antes se leía de express.application).
  const installSessionSecurity = sessionSecurity.installSessionSecurity;
  let sessionRuntime = null;
  sessionSecurity.installSessionSecurity = (ctx, options) => {
    sessionRuntime = installSessionSecurity(ctx, options);
    return sessionRuntime;
  };

  try {
    await withCloud(async (app, send) => {
      const post = (route, headers = {}, body = {}) =>
        send('POST', `/auth/${route}`, { headers, body });
      const login = (headers = browser) => post('login', headers, loginBody);

      await t.test('Login y reemisión de sesión: cookies, CORS y cabeceras de seguridad', async () => {
        const response = await login();
        const session = webSession(response);
        securityHeaders(response);

        const preflight = await send('OPTIONS', '/auth/logout', {
          headers: {
            ...browser,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'x-beatgaler-client, x-beatgaler-csrf',
          },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers['access-control-allow-origin'], origin);
        assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
        assert.equal(preflight.headers.vary, 'Origin');
        assert.equal(preflight.headers['access-control-allow-methods'], 'GET, POST, PATCH, PUT, OPTIONS');
        const allowed = preflight.headers['access-control-allow-headers'].toLowerCase().split(/,\s*/);
        assert.equal(allowed.filter(name => name === csrfHeader).length, 1);
        assert.ok(allowed.includes('x-beatgaler-client'));

        const rebound = await post('session', {
          ...browser,
          origin: 'http://localhost',
          cookie: session.cookie,
          authorization: 'Bearer browser-cookie-session',
        }, installation);
        const reissued = webSession(rebound, 'None');
        assert.equal(reissued.cookie.split(';', 1)[0], session.cookie.split(';', 1)[0]);
        assert.notEqual(reissued[csrfHeader], session[csrfHeader]);
        errorCode(await post('session', browser, installation), 401, 'AUTH_SERVICE_UNAVAILABLE');

        const desktop = await login({});
        assert.equal(desktop.headers['set-cookie'], undefined);
        const desktopBody = json(desktop, 200);
        assert.equal(Object.hasOwn(desktopBody, 'csrf_token'), false);
        assert.equal(typeof desktopBody.token, 'string');
        assert.ok(desktopBody.token.length > 0);
      });

      await t.test('La credencial inválida precede a CSRF y CSRF a los handlers protegidos', async () => {
        const { cookie: sessionCookie, ...csrf } = webSession(await login());
        const expired = await post('email/change', { ...browser, cookie: `${sessionName}=expired-fixture` });
        errorCode(expired, 401, 'SESSION_EXPIRED');
        clearsCookies(expired);
        errorCode(await post('account', { ...browser, authorization: 'Bearer browser-cookie-session' }),
          401, 'SESSION_INVALID');

        for (const route of [
          'account', 'account/export', 'account/delete', 'email/change', 'mfa/setup',
          'mfa/enable', 'mfa/disable', 'email/verification/request', 'email/verification/confirm',
          'password/reset/request', 'password/reset/complete', 'reauth', 'mfa/recovery/regenerate',
          'security/notifications', 'lifecycle/status', 'sessions', 'sessions/revoke',
          'sessions/revoke-all', 'oauth/start', 'oauth/poll', 'oauth/disconnect', 'logout',
        ]) {
          const response = await post(route, { ...browser, cookie: sessionCookie });
          assert.equal(json(response, 403).code, 'CSRF_REQUIRED', route);
          assert.equal(response.headers['set-cookie'], undefined, route);
          securityHeaders(response);
        }

        const credentials = { ...browser, cookie: sessionCookie, ...csrf };
        errorCode(await post('sessions', { ...credentials, [csrfHeader]: 'wrong-csrf' }), 403, 'CSRF_REQUIRED');
        errorCode(await post('sessions', { ...credentials, cookie: sessionCookie.split(';', 1)[0] }),
          403, 'CSRF_REQUIRED');
        errorCode(await post('sessions', browser), 401, 'AUTH_SERVICE_UNAVAILABLE');
        const list = json(await post('sessions', credentials), 200);
        assert.equal(list.sessions.filter(session => session.current).length, 1);

        errorCode(await post('email/change', browser), 409, 'EMAIL_CHANGE_STAGED_REQUIRED');
        errorCode(await post('email/change', credentials), 409, 'EMAIL_CHANGE_STAGED_REQUIRED');
        errorCode(await post('lifecycle/status', browser), 401, 'AUTH_SERVICE_UNAVAILABLE');
        // X66: antes respondía 500 (lifecycleStatus no estaba expuesto al registrar la ruta).
        const lifecycle = json(await post('lifecycle/status', credentials), 200);
        assert.equal(lifecycle.ok, true);
        assert.equal(lifecycle.email_verified, false);
      });

      await t.test('Logout y revocación de la sesión actual borran ambas cookies', async () => {
        const logoutSession = { ...browser, ...webSession(await login()) };
        const logout = await post('logout', logoutSession);
        assert.deepEqual(json(logout, 200), { ok: true });
        clearsCookies(logout);
        errorCode(await post('sessions', logoutSession), 401, 'SESSION_REVOKED');

        const credentials = { ...browser, ...webSession(await login()) };
        const { sessions } = json(await post('sessions', credentials), 200);
        const { id } = sessions.find(session => session.current);
        // X67: la ruta lleva su propio parser JSON y revoca la sesión indicada.
        const revoked = await post('sessions/revoke', credentials, { session_id: id });
        assert.equal(json(revoked, 200).ok, true);
        clearsCookies(revoked);
        errorCode(await post('sessions', credentials), 401, 'SESSION_REVOKED');
        const other = { ...browser, ...webSession(await login()) };
        assert.equal((await post('sessions/revoke', other, { session_id: 'no-existe' })).status, 404);
        assert.ok(json(await post('sessions', other), 200).sessions.find(session => session.current));

        const all = await post('sessions/revoke-all', other);
        const allBody = json(all, 200);
        assert.equal(allBody.ok, true);
        assert.equal(allBody.current_revoked, true);
        assert.ok(allBody.revoked_count >= 1);
        clearsCookies(all);
        const replay = await post('sessions', other);
        errorCode(replay, 401, 'SESSION_REVOKED');
        clearsCookies(replay);
      });

      await t.test('sessions/revoke limita su cuerpo a 16 KiB, por debajo del parser global', async () => {
        const credentials = { ...browser, ...webSession(await login()) };
        const limit = 16 * 1024;
        const padding = bytes => ({ session_id: 'x'.repeat(bytes - Buffer.byteLength('{"session_id":""}')) });
        assert.equal((await post('sessions/revoke', credentials, padding(limit))).status, 404);
        assert.deepEqual(json(await post('sessions/revoke', credentials, padding(limit + 1)), 413),
          { error: 'Request body is too large.' });
        assert.ok(json(await post('sessions', credentials), 200).sessions.find(session => session.current));
      });

      await t.test('El parser global admite 256 KiB y la sesión/CSRF lo precede', async () => {
        const { cookie: sessionCookie } = webSession(await login());
        const limit = 256 * 1024;
        const padding = bytes => ({ pad: 'x'.repeat(bytes - Buffer.byteLength('{"pad":""}')) });
        errorCode(await post('email/change', browser, padding(limit)), 409, 'EMAIL_CHANGE_STAGED_REQUIRED');
        assert.deepEqual(json(await post('email/change', browser, padding(limit + 1)), 413),
          { error: 'Request body is too large.' });
        assert.deepEqual(json(await post('email/change', browser, 'JSON escalar'), 400),
          { error: 'Malformed JSON body.' });
        errorCode(await post('email/change', { ...browser, cookie: sessionCookie }, padding(limit + 1)),
          403, 'CSRF_REQUIRED');
        errorCode(await post('sessions', browser, padding(limit + 1)), 401, 'AUTH_SERVICE_UNAVAILABLE');
      });

      await t.test('Login y password/change comparten cupo, con sesión, CSRF y contención antes del limitador', async () => {
        const credentials = { ...browser, ...webSession(await login()) };
        const rateEmail = 'rate-limit@example.test';
        const attempts = await Promise.all(Array.from({ length: 12 }, () =>
          post('password/change', browser, { email: rateEmail })));
        for (const response of attempts) {
          json(response, 401);
          assert.equal(response.headers['retry-after'], undefined);
        }
        const throttled = await post('login', browser, { email: rateEmail });
        assert.deepEqual(json(throttled, 429), { error: 'Too many authentication attempts. Please retry later.' });
        assert.equal(throttled.headers['retry-after'], '60');
        errorCode(await post('password/change', { ...credentials, cookie: `${sessionName}=expired-fixture` },
          { email: rateEmail }), 401, 'SESSION_EXPIRED');
        errorCode(await post('password/change', { ...credentials, [csrfHeader]: '' }, { email: rateEmail }),
          403, 'CSRF_REQUIRED');
        errorCode(await post('password/change', credentials, { email: rateEmail }), 503, 'AUTH_SERVICE_UNAVAILABLE');
      });

      await t.test('X65: el alta pendiente pasa por contención y antiabuso antes de responder', async () => {
        const runtime = sessionRuntime;
        const decorateResponse = runtime.decorateResponse;
        const decoratedRoutes = [];
        runtime.decorateResponse = (route, ...args) => {
          decoratedRoutes.push(route);
          return decorateResponse.call(runtime, route, ...args);
        };
        const email = 'pending@example.test';
        const freeInstallation = 'pending-fixture-installation';
        const registrationIds = [account.beatgalerUserId, ...Array(13).fill(freeInstallation)];
        try {
          webSession(await login());
          // La instalación vinculada activa el conflicto de contención (403); la
          // libre agota el cupo de antiabuso (429 con Retry-After).
          const pendingBody = {
            ok: true,
            signup_pending: true,
            signup_id: signup.signup_id,
            status: signup.status,
            expires_at: signup.expires_at,
            challenge_expires_at: signup.challenge_expires_at,
          };
          const statuses = [];
          for (const beatgalerUserId of registrationIds) {
            const response = await post('register', {
              ...browser,
              cookie: `${sessionName}=expired-fixture`,
            }, { email, username: 'pending', password: account.password, beatgalerUserId });
            statuses.push(response.status);
            if (response.status === 202) {
              assert.deepEqual(json(response, 202), pendingBody);
              assert.deepEqual(response.headers['set-cookie'], [
                cookie('__Host-beatgaler_signup', 'signup-fixture.continuation-fixture',
                  { httpOnly: true, sameSite: 'Lax', age: 86400 }),
              ]);
              assert.equal(response.headers['retry-after'], undefined);
            } else if (response.status === 429) {
              assert.equal(response.headers['retry-after'], '60');
            }
          }
          // El cupo es compartido con los logins previos: solo importa el orden.
          const accepted = statuses.filter(code => code === 202).length;
          assert.ok(accepted >= 5 && accepted <= 9, String(statuses));
          assert.deepEqual(statuses, [403, ...Array(accepted).fill(202), ...Array(13 - accepted).fill(429)]);
          // La decoración de sesión ya precede al alta y no altera la respuesta pendiente.
          assert.deepEqual(decoratedRoutes.slice(0, 1), ['/auth/login']);
          assert.ok(decoratedRoutes.slice(1).every(route => route === '/auth/register'));
          assert.deepEqual(signupInputs, registrationIds.slice(1, 1 + statuses.filter(code => code === 202).length).map(installationId => ({
            email, usernameBase: 'pending', password: account.password, installationId,
          })));
        } finally {
          runtime.decorateResponse = decorateResponse;
        }
      });
    });
  } finally {
    pendingSignup.installPendingSignupBoundary = installPendingSignupBoundary;
    sessionSecurity.installSessionSecurity = installSessionSecurity;
  }
});
