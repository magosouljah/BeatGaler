'use strict';

const assert = require('node:assert/strict');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' };
const loginBody = {
  email: account.email,
  password: account.password,
  beatgalerUserId: account.beatgalerUserId,
};
const requests = {
  'GET /auth/oauth/:provider/callback': { url: '/auth/oauth/google/callback' },
  'GET /billing/checkout/:requestId': { url: '/billing/checkout/composition-request' },
  'GET /events': { url: `/events?beatgalerUserId=${account.beatgalerUserId}&ticket=missing-ticket` },
  'POST /auth/login': { body: loginBody },
  'POST /auth/register': {
    body: {
      username: 'composition_new',
      email: 'new@example.test',
      password: account.password,
      beatgalerUserId: 'composition-new-installation',
    },
  },
  'POST /auth/session': { body: { beatgalerUserId: account.beatgalerUserId } },
};
const ignoresBearer = new Set([
  '/auth/login', '/auth/register', '/auth/signup/verify', '/auth/signup/resend',
  '/auth/signup/status', '/webhooks/polar',
]);
const sessionEnding = ['POST /auth/sessions/revoke-all', 'POST /auth/logout'];
const fallback = 'GET /catalog/v1/context';
const relevantHeaders = [
  'content-type', 'x-content-type-options', 'x-frame-options', 'referrer-policy',
  'permissions-policy', 'content-security-policy', 'strict-transport-security',
  'cache-control', 'pragma', 'access-control-allow-origin',
  'access-control-allow-credentials', 'access-control-allow-headers',
  'access-control-allow-methods', 'vary', 'location',
];

function mountedRoutes(stack) {
  const routes = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const route of [].concat(layer.route.path)) {
        assert.equal(typeof route, 'string', 'Falta una URL de ejemplo para esta ruta Express.');
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) routes.push(`${method.toUpperCase()} ${route}`);
        }
      }
    } else if (Array.isArray(layer.handle.stack)) {
      // Los routers anidados actuales se montan en la raíz. Fallar si cambia
      // el prefijo en vez de enviar peticiones a rutas incompletas.
      assert.ok(layer.match('/composition-mount-probe') && layer.path === '', 'Falta resolver el prefijo de un router Express.');
      routes.push(...mountedRoutes(layer.handle.stack));
    }
  }
  return routes;
}

function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const items = [...new Set(value.map(item => JSON.stringify(shape(item))))];
    return items.sort().map(item => JSON.parse(item));
  }
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])]));
}

function summarize({ status, headers, data }) {
  const selected = Object.fromEntries(relevantHeaders
    .filter(key => headers[key] !== undefined)
    .map(key => [key, headers[key]]));
  selected['set-cookie'] = Boolean(headers['set-cookie']?.length);
  let body = data ? 'text' : 'empty';
  if (data && headers['content-type']?.startsWith('application/json')) body = shape(JSON.parse(data));
  else if (data && headers['content-type']?.startsWith('text/html')) body = 'html';
  return { status, headers: selected, body };
}

async function signIn(send) {
  const response = await send('POST', '/auth/login', { headers: browser, body: loginBody });
  assert.equal(response.status, 200, 'El login local debe crear una sesión web.');
  const { csrf_token: csrf, session_transport: transport } = JSON.parse(response.data);
  const cookies = response.headers['set-cookie'] || [];
  assert.equal(transport, 'cookie');
  assert.ok(csrf && cookies.length, 'El login debe emitir las credenciales de navegador y CSRF.');
  return {
    cookie: cookies.map(cookie => cookie.split(';', 1)[0]).join('; '),
    'x-beatgaler-csrf': csrf,
  };
}

async function snapshot() {
  let captured;
  await withCloud(async (app, send) => {
    const routes = mountedRoutes((app._router || app.router).stack);
    assert.equal(new Set(routes).size, routes.length, 'El montaje contiene rutas duplicadas.');
    const keys = [...routes, fallback];
    async function observe(key, session) {
      const [method, route] = key.split(' ');
      const { url = route, body = method === 'POST' ? {} : undefined } = requests[key] || {};
      assert.ok(!url.includes('/:'), `Falta una URL de ejemplo para ${key}.`);
      const headers = { ...browser, 'x-beatgaler-installation-id': account.beatgalerUserId, ...session };
      // Se presenta también el marcador local como Bearer para probar la
      // precedencia de la cookie antes del guard de ciclo de vida.
      if (session && !ignoresBearer.has(route)) headers.authorization = 'Bearer browser-cookie-session';
      return summarize(await send(method, url, { headers, body }));
    }

    const anonymous = new Map();
    for (const key of keys) anonymous.set(key, await observe(key));
    let session = await signIn(send);
    const authenticated = new Map();
    for (const key of keys.filter(key => !sessionEnding.includes(key))) {
      authenticated.set(key, await observe(key, session));
    }
    for (const key of sessionEnding.filter(key => routes.includes(key))) {
      authenticated.set(key, await observe(key, session));
      if (key !== sessionEnding.at(-1)) session = await signIn(send);
    }
    captured = {
      routes: Object.fromEntries(routes.map(key => [key, [anonymous.get(key), authenticated.get(key)]])),
      fallback: { [fallback]: [anonymous.get(fallback), authenticated.get(fallback)] },
    };
  });
  return captured;
}

async function main() {
  const expected = require('./fixtures/composition-routes.json');
  const actual = await snapshot();
  const failures = [];
  for (const group of ['routes', 'fallback']) {
    const wanted = expected[group];
    const observed = actual[group];
    for (const key of new Set([...Object.keys(wanted), ...Object.keys(observed)])) {
      for (const [index, scenario] of ['sin sesión', 'con sesión'].entries()) {
        const row = wanted[key]?.[index];
        // Cada fila fija estado, perfil de cabeceras y forma del cuerpo.
        const [status, headerProfile, body] = row || [];
        const expectedResponse = row && { status, headers: expected.headers[headerProfile], body };
        try {
          assert.deepEqual(observed[key]?.[index], expectedResponse);
        } catch (error) {
          failures.push(`${key} [${scenario}]\n${error.message}`);
        }
      }
    }
  }
  if (failures.length) {
    const labels = failures.map(failure => failure.split('\n', 1)[0]);
    throw new Error(`${failures.join('\n\n')}\n\n${failures.length} respuestas distintas:\n${labels.join(' | ')}`);
  }
  console.log(`Humo Cloud: ${Object.keys(actual.routes).length} rutas Express, 2 escenarios por ruta y 1 fallback.`);
}

module.exports = { snapshot };

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
