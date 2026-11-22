'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const assemblyPath = require.resolve('../catalog-assembly');
const gateway = require('../catalog-gateway-runtime');

function fixture(t, { cutoverAuthority = 'postgres', nativeEnabled = true, activationRows = [] } = {}) {
  const calls = [];
  const record = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return result;
  };
  const cutover = { authority: cutoverAuthority };
  const pool = { query: record('query', { rows: activationRows }), end: record('end') };
  const authority = { config: { nativeEnabled }, availability: record('availability') };
  const queries = { keySource: 'fake' };
  const commands = {};
  const operations = {};
  const purge = {};
  const worker = {};
  const prepareControlPlaneCutover = record('cutover', cutover);
  const stubs = {
    './control-plane-cutover-runtime': { prepareControlPlaneCutover },
    './access-runtime': { configure: record('access'), resolveUserAccess: record('resolveAccess', { quotas: { max_beats: 7 } }) },
    './catalog/authority': { configureCatalogAuthority: (config) => record('authority', config ? authority : null)(config) },
    './catalog/queries': { configureCatalogQueries: record('queries', queries) },
    './catalog/commands': { configureCatalogCommands: record('commands', commands) },
    './catalog/operations': {
      configureCatalogOperations: record('operations', operations),
      currentCatalogOperations: record('currentOperations', operations),
    },
    './catalog-gateway-runtime': {
      gatewayFromEnv: (config) => {
        record('gateway')(config);
        return gateway.gatewayFromEnv(config);
      },
    },
    './catalog/playback': { configureCatalogPlayback: record('playback') },
    './catalog/media': { configureCatalogMedia: record('media') },
    './catalog-deletion-journal': { createFileDeletionJournal: record('journal', {}) },
    './catalog/purge': { configureCatalogPurge: record('purge', purge) },
    './catalog/prefix-packs': { configurePrefixPacks: record('prefixPacks') },
    './catalog/direct': {
      createProjectAccessResolver: record('projectAccess', () => {}),
      configureCatalogDirect: record('direct'),
      currentCatalogDirect: record('currentDirect', null),
    },
    './catalog/native-transport-provisioning': { configureNativeTransportProvisioner: record('transport') },
    './catalog/worker': { createCatalogWorker: record('worker', worker) },
  };
  const load = Module.prototype.require;
  t.mock.method(Module.prototype, 'require', function (request) {
    if (this.filename === assemblyPath && Object.hasOwn(stubs, request)) return stubs[request];
    return load.call(this, request);
  });
  t.mock.method(console, 'log', record('log'));
  delete require.cache[assemblyPath];
  t.after(() => { delete require.cache[assemblyPath]; });
  const assembly = require(assemblyPath);
  const runServer = (env = {}, overrides = {}) => assembly.assembleServerCatalog({
    pool, env, cutover, onGatewayConfigured: record('publishGateway'), ...overrides,
  });
  return {
    assembly, calls, pool, authority, queries, commands, operations, purge, worker, cutover,
    prepareControlPlaneCutover, runServer,
    order: () => calls.map(([name]) => name),
    input: (label) => calls.find(([name]) => name === label)?.[1],
  };
}

test('Ensamblado HTTP: conserva orden, catálogo sin gateway ni journal y estado (G-d/G-e)', async (t) => {
  const f = fixture(t);
  await f.runServer();
  assert.deepEqual(f.order(), [
    'authority', 'queries', 'commands', 'operations', 'gateway', 'publishGateway',
    'currentOperations', 'playback', 'media', 'purge', 'prefixPacks', 'direct', 'transport', 'currentDirect', 'log',
  ]);
  assert.deepEqual(f.input('purge'), { pool: f.pool, authority: f.authority, gateway: null, journal: null });
  assert.equal(f.input('publishGateway'), null);
  assert.equal(f.input('direct'), null);
  assert.equal(f.input('log'), '[catalog] native=enabled cursor-keys=fake gateway=none journal=none');
});

test('G-a: rechaza riesgo aceptado sin autoridad habilitada o sin activación SQL REUSED_UNROTATED', async (t) => {
  const f = fixture(t, { activationRows: [{ direct_token_exposure: 'ROTATED' }] });
  const env = { BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED: ' true ' };
  await assert.rejects(f.runServer(env, { pool: null }), {
    message: 'STOP-GATE: reused bot risk acceptance requires an enabled native PostgreSQL authority',
  });
  assert.deepEqual(f.order(), ['authority', 'queries', 'commands', 'operations']);
  f.calls.length = 0;
  await assert.rejects(f.runServer(env), {
    message: 'STOP-GATE: reused bot risk acceptance requires REUSED_UNROTATED SQL activation',
  });
  assert.deepEqual(f.order(), ['authority', 'queries', 'commands', 'operations', 'query']);
  assert.equal(f.input('query'), 'SELECT transport_bot_ids, direct_token_exposure FROM catalog_native_activation');
});

test('G-b: Direct en producción sin G2 aborta después de purge', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.runServer({ NODE_ENV: 'prod', BEATGALER_CATALOG_DIRECT_ENABLED: 'true' }), {
    message: 'STOP-GATE: BEATGALER_CATALOG_DIRECT_ENABLED=true in production requires proven G2 or owner-accepted unrotated-bot risk; refusing to start.',
  });
  assert.deepEqual(f.order().slice(-5), ['publishGateway', 'currentOperations', 'playback', 'media', 'purge']);
});

test('G-c: pasa el entorno al gateway y su rechazo precede a G-b', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.runServer({
    BEATGALER_DEPLOYMENT_ENV: 'production',
    BEATGALER_CATALOG_DIRECT_ENABLED: 'true',
    BEATGALER_CATALOG_GATEWAY_ENABLED: 'true',
  }), {
    message: 'STOP-GATE: BEATGALER_CATALOG_GATEWAY_ENABLED=true in production requires proven G2 or explicitly accepted reused-bot risk; refusing to start.',
  });
  assert.deepEqual(f.order(), ['authority', 'queries', 'commands', 'operations', 'gateway']);
});

test('Ensamblado del worker: conserva cutover, disponibilidad, Access y dependencias del runner', async (t) => {
  const f = fixture(t);
  const env = { BEATGALER_CATALOG_JOURNAL_DIR: ' fake-journal ' };
  const catalog = await f.assembly.assembleWorkerCatalog({ pool: f.pool, env });
  assert.equal(f.assembly.prepareControlPlaneCutover, f.prepareControlPlaneCutover);
  assert.deepEqual(f.order(), ['cutover', 'authority', 'availability', 'access', 'queries', 'commands', 'operations', 'gateway', 'journal', 'purge', 'worker']);
  assert.deepEqual(f.input('cutover'), { pool: f.pool, env });
  assert.deepEqual(f.input('journal'), { dir: 'fake-journal' });
  const runner = f.input('worker');
  assert.deepEqual({ ...runner, log: undefined }, {
    pool: f.pool, operations: f.operations, queries: f.queries, commands: f.commands,
    transport: null, purge: f.purge, options: { pollMs: 1000 }, log: undefined,
  });
  assert.deepEqual(catalog, { worker: f.worker, gatewayRuntime: null, mediaGateway: null });
  assert.deepEqual(await f.input('operations').resolveAccess('user-1'), { maxBeats: 7 });
  assert.deepEqual(f.input('resolveAccess'), { id: 'user-1' });
});
