'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

async function checkStartup() {
  // Node asks dns.lookup to resolve the numeric bind address. Supply the
  // literal locally and keep the preload's guard for all other lookups.
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (host === '0.0.0.0' && options.all) {
      return process.nextTick(callback, null, [{ address: host, family: 4 }]);
    }
    return lookup(host, options, callback);
  };

  require('../server-core-auth-bridge-loader');
  const { listenCloudServer } = require('../server-core');
  await nextTurn();
  assert.ok(!process.getActiveResourcesInfo().includes('TCPServerWrap'), 'importing server-core opened a TCP listener');

  const server = listenCloudServer();
  await once(server, 'listening');
  try {
    const { address, port } = server.address();
    assert.equal(address, '0.0.0.0');
    const response = await fetch(`http://127.0.0.1:${port}/auth/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.account_auth, true);
  } finally {
    server.close();
  }
}

if (process.argv[2] === '--child') {
  checkStartup().catch(error => {
    console.error(error);
    process.exit(1);
  });
} else {
  test('server-core only opens its HTTP listener when explicitly started', () => {
    assert.equal(findLocalSecretFiles(path.resolve(__dirname, '../..')).length, 0, 'requires a clean Cloud checkout');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-core-startup-'));
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
      fs.rmdirSync(scratch);
    }
  });
}
