'use strict';

// Arranque del Cloud con BEATGALER_PENDING_SIGNUP_ENABLED=1: cargador del puente de auth sobre server-core + listenCloudServer.
// Sin PostgreSQL ni servicios reales: server.js exige PG para el servicio de alta pendiente, así que aquí se prueba solo lo
// que no lo necesita (flag, cargador, listener, puente en proceso). La ruta de alta pendiente real queda sin probar aquí.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

async function checkBoot() {
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (host === '0.0.0.0' && options.all) return process.nextTick(callback, null, [{ address: host, family: 4 }]);
    return lookup(host, options, callback);
  };

  const { serverEnv } = require('../runtime-env');
  assert.equal(serverEnv.pendingSignupEnabled(), true, 'the flag must be read as enabled');

  // Misma secuencia que server.js cuando el flag está activo.
  const { installServerCoreAuthBridgeLoader, getServerCoreAuthBridge } = require('../server-core-auth-bridge-loader');
  const restore = installServerCoreAuthBridgeLoader();
  let server;
  try {
    const { listenCloudServer } = require('../server-core');
    server = listenCloudServer();
  } finally {
    restore();
  }
  await once(server, 'listening');
  try {
    const bridge = getServerCoreAuthBridge();
    assert.ok(bridge, 'server-core must expose the in-process auth bridge');
    for (const fn of ['userIdByUsername', 'adoptAuthoritativeUser', 'bindInstallation', 'createSession']) {
      assert.equal(typeof bridge[fn], 'function', `bridge.${fn}`);
    }
    assert.equal(bridge.userIdByUsername('nadie#0000'), null);

    const { port } = server.address();
    const health = await fetch(`http://127.0.0.1:${port}/auth/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.account_auth, true);

    // El puente no crea rutas HTTP.
    const probe = await fetch(`http://127.0.0.1:${port}/auth/__bridge`, { signal: AbortSignal.timeout(5000) });
    assert.equal(probe.status, 404);
  } finally {
    server.close();
  }
}

if (process.argv[2] === '--child') {
  checkBoot().catch(error => {
    console.error(error);
    process.exit(1);
  });
} else {
  test('server-core boots with the pending-signup flag, auth bridge loader and loopback listener', () => {
    assert.equal(findLocalSecretFiles(path.resolve(__dirname, '../..')).length, 0, 'requires a clean Cloud checkout');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-pending-boot-'));
    try {
      const preloads = ['catalog-net-guard.cjs', 'no-dotenv.cjs', 'pg-port-guard.cjs'];
      const args = preloads.flatMap(file => ['--require', path.join(__dirname, 'helpers', file)]);
      const child = spawnSync(process.execPath, [...args, __filename, '--child'], {
        cwd: scratch,
        env: {
          SystemRoot: process.env.SystemRoot,
          TEMP: scratch,
          TMP: scratch,
          NODE_ENV: 'test',
          PORT: '0',
          BEATGALER_PENDING_SIGNUP_ENABLED: '1',
          BEATGALER_STATE_DIR: scratch,
          DIRECT_DIAGNOSTICS_DIR: process.env.DIRECT_DIAGNOSTICS_DIR || scratch,
          CATALOG_NET_POLICY: 'loopback',
          AWS_EC2_METADATA_DISABLED: 'true',
        },
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, `Cloud child failed:\n${child.stdout}${child.stderr}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
}
