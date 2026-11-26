'use strict';

// Caracterización del arranque del Cloud (M7.5b-B0): lo que debe seguir igual cuando el estado oculto
// `express.application.__beatgaler*` se sustituya por un contexto explícito. Cada escenario corre en un proceso hijo
// (módulos y señales limpios, entorno por allowlist, loopback y puerto efímero) y se observa por HTTP o por el servidor
// real, no por el texto fuente:
//   1. sin install*, las guardas dejan pasar los handlers originales (paso libre), y cada guarda es independiente;
//   2. un install posterior al montaje se aplica (lectura perezosa en cada registro, no en el montaje);
//   3. /healthz y /readyz responden antes del primer middleware; tras listenCloudServer rigen los timeouts de
//      runtimeConfig y hay un oyente más de SIGTERM/SIGINT que drena el servidor;
//   4. mountCatalog sin configurar responde 503 CATALOG_UNAVAILABLE, configurado 200, y el traspaso se consume una vez.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

const TIMEOUT_ENV = Object.freeze({
  BEATGALER_HTTP_REQUEST_TIMEOUT_MS: '45000',
  BEATGALER_HTTP_HEADERS_TIMEOUT_MS: '7000',
  BEATGALER_HTTP_KEEPALIVE_TIMEOUT_MS: '6000',
  BEATGALER_HTTP_SOCKET_TIMEOUT_MS: '40000',
  BEATGALER_SHUTDOWN_GRACE_MS: '2000',
});

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function client(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route, method = 'GET') => {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(5000) });
    return {
      status: response.status,
      text: await response.text(),
      mw: response.headers.get('x-mw'),
      nosniff: response.headers.get('x-content-type-options'),
    };
  };
}

// App Express real con las guardas montadas y, después del montaje, los install* indicados aplicados a la propia instancia.
async function guardedApp(installs) {
  const express = require('express');
  const { mountAccountRouteGuards, createGuardContext } = require('../account-route-guards');
  const app = express();
  const ctx = createGuardContext();
  mountAccountRouteGuards(app, undefined, ctx);
  if (installs.includes('runtime')) require('../runtime-operability').installRuntimeOperability(ctx, { env: { NODE_ENV: 'test' } });
  if (installs.includes('headers')) require('../security-headers').installSecurityHeaders(ctx);
  if (installs.includes('legacy')) require('../legacy-media-upload-disable').installLegacyMediaUploadDisable(ctx);
  app.use((_req, res, next) => { res.setHeader('x-mw', '1'); next(); });
  app.post('/beats/upload', (_req, res) => res.send('orig'));
  app.use((_req, res) => res.send('fallback'));
  const server = await listen(app);
  const get = client(server);
  const result = {
    upload: await get('/beats/upload', 'POST'),
    other: await get('/other'),
    healthz: await get('/healthz'),
  };
  server.closeAllConnections();
  server.close();
  return result;
}

async function serverCoreScenario() {
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (host === '0.0.0.0' && options.all) return process.nextTick(callback, null, [{ address: host, family: 4 }]);
    return lookup(host, options, callback);
  };
  // Misma secuencia que server.js antes de cargar server-core.
  const guards = require('../account-route-guards').createGuardContext();
  require('../runtime-operability').installRuntimeOperability(guards, { env: process.env });
  require('../security-headers').installSecurityHeaders(guards);
  require('../legacy-media-upload-disable').installLegacyMediaUploadDisable(guards);
  require('../cloud-boot').prepareCloudBoot({ guards });
  const { listenCloudServer } = require('../server-core');
  const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
  const server = listenCloudServer();
  await once(server, 'listening');
  const after = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
  const get = client(server);
  const healthz = await get('/healthz');
  const readyz = await get('/readyz');
  const limits = {
    requestTimeout: server.requestTimeout,
    headersTimeout: server.headersTimeout,
    keepAliveTimeout: server.keepAliveTimeout,
    socketTimeout: server.timeout,
  };
  // El oyente instalado por listen drena el servidor de forma ordenada.
  const closed = once(server, 'close');
  process.emit('SIGTERM');
  const drainTimer = setTimeout(() => server.closeAllConnections(), 3000);
  await closed;
  clearTimeout(drainTimer);
  return {
    before, after, healthz, readyz, limits,
    listeningAfterSigterm: server.listening,
    termAfterSigterm: process.listenerCount('SIGTERM'),
    intAfterSigterm: process.listenerCount('SIGINT'),
  };
}

async function catalogScenario() {
  const express = require('express');
  const { mountCatalog } = require('../catalog-boot');
  const { prepareCloudBoot, prepareCloudCatalog, takeCloudBoot } = require('../cloud-boot');
  const origWarn = console.warn; console.warn = () => {};
  const authenticate = (req, res) => {
    if (req.get('authorization') === 'Bearer fixture') return { id: 'catalog-user' };
    res.status(401).json({ code: 'UNAUTHENTICATED' });
    return null;
  };
  async function context(app) {
    const server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/catalog/v1/context`, {
      headers: { Authorization: 'Bearer fixture' }, signal: AbortSignal.timeout(5000),
    });
    const result = { status: response.status, body: await response.json() };
    server.closeAllConnections();
    server.close();
    return result;
  }
  const unconfigured = await context((() => { const app = express(); mountCatalog(app, authenticate, takeCloudBoot().catalog); return app; })());
  prepareCloudBoot();
  prepareCloudCatalog({
    authority: { resolveContext: async ({ userId }) => ({ library_id: `library-${userId}` }) },
    queries: {},
  }, async () => ({ native: true }));
  const configuredApp = express();
  const guard = mountCatalog(configuredApp, authenticate, takeCloudBoot().catalog);
  const configured = await context(configuredApp);
  const guardResult = await guard({});
  // El traspaso se consume en el montaje: una segunda instancia vuelve a estar sin configurar.
  const consumed = await context((() => { const app = express(); mountCatalog(app, authenticate, takeCloudBoot().catalog); return app; })());
  console.warn = origWarn;
  return { unconfigured, configured, guardResult, consumed };
}

const SCENARIOS = {
  free: () => guardedApp([]),
  late: () => guardedApp(['runtime', 'headers', 'legacy']),
  headersOnly: () => guardedApp(['headers']),
  serverCore: serverCoreScenario,
  catalog: catalogScenario,
};

// El execArgv del runner (p. ej. --require relativos) debe seguir siendo válido con otro cwd.
function absoluteExecArgv() {
  const argv = process.execArgv;
  return argv.map((arg, i) => (/^(--require|-r|--import)$/.test(argv[i - 1] || '') && /^\.{1,2}[\\/]/.test(arg) ? path.resolve(arg) : arg));
}

function runChild(scenario, extraEnv = {}) {
  assert.equal(findLocalSecretFiles(path.resolve(__dirname, '../..')).length, 0, 'requires a clean Cloud checkout');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-boot-char-'));
  try {
    const preloads = ['catalog-net-guard.cjs', 'no-dotenv.cjs', 'pg-port-guard.cjs'];
    const args = preloads.flatMap(file => ['--require', path.join(__dirname, 'helpers', file)]);
    const child = spawnSync(process.execPath, [...absoluteExecArgv(), ...args, __filename, '--child', scenario], {
      cwd: scratch,
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: scratch,
        TMP: scratch,
        NODE_ENV: 'test',
        PORT: '0',
        BEATGALER_STATE_DIR: scratch,
        DIRECT_DIAGNOSTICS_DIR: process.env.DIRECT_DIAGNOSTICS_DIR || scratch,
        CATALOG_NET_POLICY: 'loopback',
        AWS_EC2_METADATA_DISABLED: 'true',
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `Cloud child ${scenario} failed:\n${child.stdout}${child.stderr}`);
    return JSON.parse(child.stdout.split('@@')[1]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') {
  SCENARIOS[process.argv[3]]().then(
    result => { process.stdout.write(`@@${JSON.stringify(result)}`); process.exit(0); },
    error => { console.error(error); process.exit(1); },
  );
} else {
  test('sin install*, las guardas dejan pasar los handlers originales y no registran nada propio', () => {
    const { upload, other, healthz } = runChild('free');
    assert.equal(upload.status, 200);
    assert.equal(upload.text, 'orig', 'sin la guarda legacy el handler original responde');
    assert.equal(upload.mw, '1');
    assert.equal(other.nosniff, null, 'sin la guarda de cabeceras no hay nosniff');
    assert.equal(healthz.text, 'fallback', 'sin runtime instalado /healthz no existe');
    assert.equal(healthz.mw, '1');
  });

  test('cada guarda actúa solo si su install* se ejecutó', () => {
    const { upload, other, healthz } = runChild('headersOnly');
    assert.equal(other.nosniff, 'nosniff');
    assert.equal(upload.text, 'orig', 'las cabeceras no activan el 410 legacy');
    assert.equal(healthz.text, 'fallback', 'las cabeceras no registran /healthz');
  });

  test('un install posterior al montaje se aplica porque cada guarda lee su estado al registrar', () => {
    const { upload, other, healthz } = runChild('late');
    assert.equal(upload.status, 410);
    assert.match(upload.text, /Legacy HTTP media upload is disabled/);
    assert.equal(other.nosniff, 'nosniff');
    assert.equal(other.mw, '1');
    assert.equal(healthz.status, 200);
    assert.deepEqual(JSON.parse(healthz.text), { ok: true, status: 'live', environment: 'development', sourceSha: null });
    assert.equal(healthz.mw, null, '/healthz se registra antes del primer middleware de use');
  });

  test('listenCloudServer aplica los timeouts de runtimeConfig, sirve /healthz y /readyz y apaga ordenadamente con SIGTERM', () => {
    const r = runChild('serverCore', TIMEOUT_ENV);
    assert.equal(r.healthz.status, 200);
    assert.equal(JSON.parse(r.healthz.text).status, 'live');
    assert.equal(r.healthz.mw, null);
    assert.equal(r.readyz.status, 200);
    assert.equal(JSON.parse(r.readyz.text).status, 'ready');
    assert.deepEqual(r.limits, { requestTimeout: 45000, headersTimeout: 7000, keepAliveTimeout: 6000, socketTimeout: 40000 });
    assert.equal(r.after.term, r.before.term + 1, 'listen añade un oyente de SIGTERM');
    assert.equal(r.after.int, r.before.int + 1, 'listen añade un oyente de SIGINT');
    assert.equal(r.listeningAfterSigterm, false, 'SIGTERM cierra el servidor');
    assert.equal(r.termAfterSigterm, r.before.term, 'el oyente de SIGTERM es de un solo uso');
    assert.equal(r.intAfterSigterm, r.before.int + 1, 'el de SIGINT sigue pendiente');
  });

  test('mountCatalog sin configurar responde 503 CATALOG_UNAVAILABLE, configurado 200 y el traspaso se consume una vez', () => {
    const r = runChild('catalog');
    assert.equal(r.unconfigured.status, 503);
    assert.equal(r.unconfigured.body.code, 'CATALOG_UNAVAILABLE');
    assert.equal(r.configured.status, 200);
    assert.equal(r.configured.body.library_id, 'library-catalog-user');
    assert.deepEqual(r.guardResult, { native: true });
    assert.equal(r.consumed.status, 503);
    assert.equal(r.consumed.body.code, 'CATALOG_UNAVAILABLE');
  });
}
