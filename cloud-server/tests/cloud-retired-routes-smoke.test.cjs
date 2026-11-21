'use strict';

// Caracterización de las rutas RETIRADAS (M1.C1a). El humo de composición solo
// pide las rutas montadas; este fija lo que responde el Cloud ante los literales
// que http-containment.js, legacy-media-upload-disable.js y la mitad "install"
// de productive-temp-auth-boundary.js aún mencionan, pero que ya nadie registra.
// Autoridad JSON (fakes). Mismo formato de fila que cloud-composition-smoke.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { account, withCloud } = require('./helpers/composition-cloud.cjs');

const browser = { 'x-beatgaler-client': 'web', origin: 'http://127.0.0.1' };
const loginBody = {
  email: account.email,
  password: account.password,
  beatgalerUserId: account.beatgalerUserId,
};

// Literales de http-containment.js (UPLOAD_ROUTES, BODY_OWNER_ROUTES,
// INSTALLATION_POST_ROUTES, INSTALLATION_GET_ROUTES y las ramas de
// patchedPost/patchedGet), legacy-media-upload-disable.js
// (LEGACY_MEDIA_UPLOAD_ROUTES) y productive-temp-auth-boundary.js (TARGET_ROUTES).
const POST_LITERALS = [
  '/library/upsert', '/auth/register', '/auth/login', '/auth/session', '/auth/oauth/start',
  '/auth/oauth/poll', '/auth/logout', '/transport/project/upload',
  '/metadata/artwork', '/beats/upload', '/projects/upload', '/cloud-files/upload',
  '/metadata/upsert', '/library/artwork', '/beats/delete-topic',
  '/events/ticket', '/telegram/connect/start', '/telegram/disconnect',
  '/transport/session/start', '/transport/session/activate', '/transport/session/heartbeat',
  '/transport/session/stop', '/transport/operation/begin', '/transport/capability/authorize',
  '/transport/operation/end', '/transport/operation/renew', '/transport/index/commit',
  '/transport/index/publish', '/transport/index/bootstrap-state', '/transport/trash/purge',
  '/transport/quota/reserve', '/transport/quota/renew', '/transport/quota/cancel',
  '/transport/project/authorize', '/transport/routing/reconcile', '/transport/topic/ensure',
  '/transport/upload/confirm', '/beats/delete-topics-batch',
];
const GET_LITERALS = ['/auth/oauth/:provider/callback', '/telegram/connect/status'];
// Montadas hoy (las cubre cloud-composition-smoke): aquí solo se exige que lo sigan estando.
const MOUNTED_LITERALS = new Set([
  'POST /auth/register', 'POST /auth/login', 'POST /auth/session', 'POST /auth/oauth/start',
  'POST /auth/oauth/poll', 'POST /auth/logout', 'POST /events/ticket',
  'POST /telegram/connect/start', 'POST /telegram/disconnect',
  'GET /auth/oauth/:provider/callback', 'GET /telegram/connect/status',
]);
// POST /auth/sessions demuestra que la sesión se usa (401 sin sesión, 200 con sesión).
const CONTROLS = ['GET /auth/health', 'GET /transport/status', 'GET /catalog/v1/context', 'POST /auth/sessions'];
const LITERAL_CONTROLS_UNMOUNTED = new Set(['GET /catalog/v1/context']);
// Termina la sesión: se observa la última con sesión.
const sessionEnding = 'POST /auth/logout';
const METHODS = ['GET', 'POST'];

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
        assert.equal(typeof route, 'string', 'Ruta Express no literal (regex o patrón): hay que caracterizarla.');
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) routes.push(`${method.toUpperCase()} ${route}`);
        }
      }
    } else if (Array.isArray(layer.handle.stack)) {
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

// sha256 del texto sin valores volátiles (marcas de tiempo ISO y cadenas hex largas).
function hashText(text) {
  const normalized = text
    .replace(/d{4}-d{2}-d{2}T[d:.]+Z/g, '<ts>')
    .replace(/[0-9a-f]{16,}/gi, '<hex>');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function summarize({ status, headers, data }) {
  const selected = Object.fromEntries(relevantHeaders
    .filter(key => headers[key] !== undefined)
    .map(key => [key, headers[key]]));
  // Nombre de cookie y atributos presentes, nunca sus valores.
  selected['set-cookie'] = headers['set-cookie']?.length
    ? headers['set-cookie'].map(cookie => cookie.split(';').map((part, index) => (index ? part.trim().split('=', 1)[0].toLowerCase() : part.split('=', 1)[0])).join(';'))
    : false;
  let body = data ? 'text' : 'empty';
  if (data && headers['content-type']?.startsWith('application/json')) body = shape(JSON.parse(data));
  else if (data) body = `${headers['content-type']?.startsWith('text/html') ? 'html' : 'text'}:${hashText(data)}`;
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

function retiredTargets() {
  const keys = [];
  for (const route of POST_LITERALS) for (const method of METHODS) keys.push(`${method} ${route}`);
  for (const route of GET_LITERALS) for (const method of METHODS) keys.push(`${method} ${route}`);
  return [...new Set(keys)];
}

async function snapshot() {
  let captured;
  await withCloud(async (app, send) => {
    const mounted = new Set(mountedRoutes((app._router || app.router).stack));
    const all = retiredTargets();
    const retired = all.filter(key => !MOUNTED_LITERALS.has(key));
    const live = all.filter(key => MOUNTED_LITERALS.has(key));
    for (const key of retired) assert.ok(!mounted.has(key), `${key} ya no es una ruta retirada: está montada.`);
    for (const key of live) assert.ok(mounted.has(key), `${key} debía seguir montada.`);
    assert.equal(live.length, MOUNTED_LITERALS.size, 'MOUNTED_LITERALS contiene un par que no es literal+método conocido.');
    // /catalog/v1/context lo atiende un router de catálogo con comodines, no una ruta literal.
    for (const key of CONTROLS.filter(key => !LITERAL_CONTROLS_UNMOUNTED.has(key))) {
      assert.ok(mounted.has(key), `${key} debía seguir montada.`);
    }
    const keys = [...retired, ...live, ...CONTROLS].filter(key => key !== sessionEnding);
    assert.ok(live.includes(sessionEnding));

    async function observe(key, session) {
      const [method, route] = key.split(' ');
      const url = route.replace(':provider', 'google');
      const headers = { ...browser, 'x-beatgaler-installation-id': account.beatgalerUserId, ...session };
      // Igual que el humo de composición: el marcador local también como Bearer.
      if (session) headers.authorization = 'Bearer browser-cookie-session';
      const body = method === 'POST' ? (key === 'POST /auth/login' ? loginBody : {}) : undefined;
      return summarize(await send(method, url, { headers, body }));
    }

    const anonymous = new Map();
    for (const key of keys) anonymous.set(key, await observe(key));
    const session = await signIn(send);
    const authenticated = new Map();
    for (const key of keys) authenticated.set(key, await observe(key, session));
    anonymous.set(sessionEnding, await observe(sessionEnding));
    authenticated.set(sessionEnding, await observe(sessionEnding, session));
    const pair = key => [anonymous.get(key), authenticated.get(key)];
    captured = {
      retired: Object.fromEntries(retired.map(key => [key, pair(key)])),
      live: Object.fromEntries(live.map(key => [key, pair(key)])),
      controls: Object.fromEntries(CONTROLS.map(key => [key, pair(key)])),
    };
  });
  return captured;
}

async function main() {
  const expected = require('./fixtures/retired-routes.json');
  const actual = await snapshot();
  const failures = [];
  for (const group of ['retired', 'live', 'controls']) {
    const wanted = expected[group];
    const observed = actual[group];
    for (const key of new Set([...Object.keys(wanted), ...Object.keys(observed)])) {
      for (const [index, scenario] of ['sin sesión', 'con sesión'].entries()) {
        const row = wanted[key]?.[index];
        if (wanted[key] && (wanted[key].length !== 2 || !Array.isArray(row) || row.length !== 3)) failures.push(`${key} [${scenario}]
Fila esperada mal formada.`);
        if (!observed[key]) failures.push(`${key} [${scenario}]
Fila esperada sin ruta observada.`);
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
  console.log(`Humo de rutas retiradas: ${Object.keys(actual.retired).length} rutas retiradas, ${Object.keys(actual.live).length} literales aún montados y ${Object.keys(actual.controls).length} de control, 2 escenarios por ruta.`);
}

module.exports = { snapshot };

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
