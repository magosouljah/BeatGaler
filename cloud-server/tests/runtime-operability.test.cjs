'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const runtime = require('../runtime-operability');

test.afterEach(() => runtime._resetForTests());

test('production requires explicit staging/production deployment contract', () => {
  assert.throws(() => runtime.runtimeConfig({ NODE_ENV: 'production' }), /BEATGALER_DEPLOYMENT_ENV/);
  assert.equal(runtime.runtimeConfig({ NODE_ENV: 'production', BEATGALER_DEPLOYMENT_ENV: 'staging' }).deploymentEnv, 'staging');
});

test('proxy trust is explicit and bounded', () => {
  assert.equal(runtime.runtimeConfig({ BEATGALER_TRUST_PROXY_HOPS: '0' }).trustProxy, false);
  assert.equal(runtime.runtimeConfig({ BEATGALER_TRUST_PROXY_HOPS: '2' }).trustProxy, 2);
  assert.throws(() => runtime.runtimeConfig({ BEATGALER_TRUST_PROXY_HOPS: '99' }), /TRUST_PROXY_HOPS/);
});

test('readiness fails closed when required postgres is absent', async () => {
  runtime.configureRuntimeDependencies({ postgresRequired: true });
  const result = await runtime.readinessSnapshot({ config: runtime.runtimeConfig({ NODE_ENV: 'test', BEATGALER_DEPLOYMENT_ENV: 'test' }) });
  assert.equal(result.ok, false);
  assert.equal(result.dependencies.postgres, 'missing');
});

test('readiness verifies postgres with SELECT 1', async () => {
  const seen = [];
  runtime.configureRuntimeDependencies({ pool: { query: async sql => { seen.push(sql); return {}; } }, postgresRequired: true });
  const result = await runtime.readinessSnapshot({ config: runtime.runtimeConfig({ NODE_ENV: 'test', BEATGALER_DEPLOYMENT_ENV: 'test' }) });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['SELECT 1']);
});

test('HTTP server receives bounded timeout contract', () => {
  const server = { setTimeout(ms) { this.socketTimeout = ms; } };
  runtime.configureHttpServer(server, runtime.runtimeConfig({ NODE_ENV: 'test', BEATGALER_DEPLOYMENT_ENV: 'test' }));
  assert.equal(server.requestTimeout, 30000);
  assert.equal(server.headersTimeout, 10000);
  assert.equal(server.keepAliveTimeout, 5000);
  assert.equal(server.socketTimeout, 30000);
});

test('graceful shutdown marks readiness draining and closes HTTP server', async () => {
  const processLike = new EventEmitter(); processLike.exitCode = 0;
  let closed = 0;
  const server = { close(cb) { closed += 1; cb(); }, closeIdleConnections() {}, closeAllConnections() {} };
  runtime.installGracefulShutdown(server, { processLike, config: runtime.runtimeConfig({ NODE_ENV: 'test', BEATGALER_DEPLOYMENT_ENV: 'test', BEATGALER_SHUTDOWN_GRACE_MS: '1000' }), logger: { log() {}, error() {} } });
  processLike.emit('SIGTERM');
  assert.equal(closed, 1);
  assert.equal((await runtime.readinessSnapshot({ config: runtime.runtimeConfig({ NODE_ENV: 'test', BEATGALER_DEPLOYMENT_ENV: 'test' }) })).status, 'draining');
});

test('express patch installs routes/proxy and wraps listen without server-core edits', () => {
  const routes = [];
  const processLike = new EventEmitter();
  const server = { close() {}, closeIdleConnections() {}, closeAllConnections() {}, setTimeout(ms) { this.socketTimeout = ms; } };
  const application = {
    use(...handlers) { this.used = handlers.length; return this; },
    get(path, handler) { routes.push([path, handler]); return this; },
    set(key, value) { this[key] = value; return this; },
    listen() { return server; },
  };
  runtime.installRuntimeOperability({ application }, { env: { NODE_ENV: 'test', BEATGALER_DEPLOYMENT_ENV: 'test', BEATGALER_TRUST_PROXY_HOPS: '1' }, processLike, logger: { log() {}, error() {} } });
  application.use(() => {});
  const result = application.listen(4000);
  assert.equal(application['trust proxy'], 1);
  assert.deepEqual(routes.map(([path]) => path), ['/healthz', '/readyz']);
  assert.equal(result.requestTimeout, 30000);
});
