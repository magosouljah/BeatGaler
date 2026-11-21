'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { attempts } = require('./catalog-net-guard.cjs');
require('./no-dotenv.cjs');
const { findLocalSecretFiles } = require('./local-secret-files.cjs');

const cloudDir = path.resolve(__dirname, '../..');
const account = {
  id: 'usr_composition',
  username: 'composition',
  email: 'smoke@example.test',
  password: 'composition-fake-password',
  beatgalerUserId: 'composition-installation',
};

async function withCloud(exercise) {
  assert.equal(findLocalSecretFiles(path.dirname(cloudDir)).length, 0, 'El Cloud de prueba requiere un worktree limpio.');
  const timeoutMs = Number(process.env.BEATGALER_COMPOSITION_STARTUP_TIMEOUT_MS ?? 60_000);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1,
    'BEATGALER_COMPOSITION_STARTUP_TIMEOUT_MS debe ser un plazo válido en ms.');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-composition-'));
  const originalEnv = process.env;
  const originalHttpsRequest = https.request;
  let restoreListen;
  let server;
  try {
    process.env = {
      NODE_ENV: 'development',
      BEATGALER_CONTROL_PLANE_AUTHORITY: 'json',
      BEATGALER_POSTGRES_ENABLED: 'false',
      BEATGALER_STATE_DIR: stateDir,
      BEATGALER_PUBLIC_REGISTRATION: '1',
      BEATGALER_DIRECT_TRANSPORT: 'false',
      TRANSPORT_BOTS_FILE: path.join(stateDir, 'no-pool.json'),
      TRANSPORT_POOL_STATE: path.join(stateDir, 'pool-state.json'),
      MASTERS_FILE: path.join(stateDir, 'no-masters.json'),
      VAULT_REGISTRY_FILE: path.join(stateDir, 'vaults.json'),
      DIRECT_DIAGNOSTICS_DIR: path.join(stateDir, 'diag'),
      AWS_CONFIG_FILE: path.join(stateDir, 'no-aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: path.join(stateDir, 'no-aws-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
    };

    // El registro compuesto exige pending signup con PostgreSQL. Solo se
    // siembra el usuario con un vault ficticio ya asignado. El login emite la sesión.
    const { hashPassword } = require('../../password-kdf');
    const passwordSalt = '0123456789abcdef0123456789abcdef';
    fs.writeFileSync(path.join(stateDir, 'accounts-data.json'), JSON.stringify({
      users: [{
        id: account.id,
        username: account.username,
        email: account.email,
        passwordSalt,
        passwordHash: await hashPassword(account.password, passwordSalt),
        createdAt: 1,
        storageChatId: '-1001234567890',
        storageChatTitle: 'Vault de prueba',
        storageCreatedAt: 1,
        providers: {},
      }],
      sessions: {},
    }));
    require('../../master-storage').masterStorageReady = () => false;
    https.request = function request(options, ...args) {
      if (options?.hostname !== 'api.telegram.org' || options.method !== 'HEAD') {
        return originalHttpsRequest.call(this, options, ...args);
      }
      const probe = new EventEmitter();
      probe.end = () => queueMicrotask(() => probe.emit('error', new Error('Telegram fake offline')));
      return probe;
    };

    const express = require('express');
    const originalListen = express.application.listen;
    let resolveListen;
    let rejectListen;
    const appListening = new Promise((resolve, reject) => {
      resolveListen = resolve;
      rejectListen = reject;
    });
    const startedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - startedAt);
    let startupTimeout;
    function expireStartup() {
      startupTimeout = new Error(`El arranque compuesto no llegó a listen en ${elapsedMs()} ms (límite: ${timeoutMs} ms).`);
      rejectListen(startupTimeout);
    }
    // Se mantiene la cadena de listen de producción. Solo se sustituye el bind.
    express.application.listen = function listen(_port, _host, callback) {
      if (startupTimeout) throw startupTimeout;
      server = originalListen.call(this, 0, '127.0.0.1', callback);
      server.once('error', rejectListen);
      server.once('listening', () => {
        if (elapsedMs() >= timeoutMs) expireStartup();
        else resolveListen(this);
      });
      return server;
    };
    restoreListen = () => {
      // Si el arranque se suspendió antes del bind, bloquear un listen tardío
      // en este proceso aislado aunque el temporal ya se haya borrado.
      if (!startupTimeout || server) express.application.listen = originalListen;
    };
    const timer = setTimeout(expireStartup, timeoutMs);
    let app;
    try {
      require('../../server');
      app = await appListening;
    } finally {
      clearTimeout(timer);
    }
    console.log(`Arranque compuesto hasta listen: ${elapsedMs()} ms.`);
    assert.equal(process.exitCode || 0, 0, 'Falló el arranque compuesto.');
    const port = server.address().port;
    await exercise(app, (method, url, options) => send(port, method, url, options));
    assert.ok(attempts.length > 0, 'El guard debe observar las peticiones del humo.');
    const unexpected = attempts.filter(({ api, host, port: targetPort, allowed }) => {
      if (!allowed || host !== '127.0.0.1') return true;
      // Node pasa la IP literal del bind por dns.lookup, sin consulta DNS externa.
      return api !== 'dns.lookup' && targetPort !== port;
    });
    assert.deepEqual(unexpected, [], 'El Cloud solo debe usar el listener efímero de esta prueba.');
  } finally {
    try {
      if (server) {
        await new Promise((resolve, reject) => {
          // close también cancela un bind pendiente. Cerrar las conexiones
          // activas evita que una petición fallida mantenga vivo el proceso.
          server.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      }
    } finally {
      restoreListen?.();
      https.request = originalHttpsRequest;
      process.env = originalEnv;
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

function send(port, method, url, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: url,
      agent: false,
      headers: {
        ...(encoded === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encoded),
        }),
        ...headers,
      },
    }, res => {
      res.setEncoding('utf8');
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error(`Tiempo agotado: ${method} ${url}`)));
    req.end(encoded);
  });
}

module.exports = { account, withCloud };
