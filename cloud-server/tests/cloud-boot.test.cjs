'use strict';

// Traspaso del contexto de arranque (cloud-boot) y su fallo cerrado en producción (M7.5b-FC, decisión del propietario
// 2026-11-27): con NODE_ENV=production, tomar el contexto sin prepararlo o sin las entradas de guardas obligatorias lanza
// antes de escuchar; fuera de producción se conserva el contexto vacío + aviso.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MISSING_BOOT = '[boot] server-core sin contexto de arranque';
const STOP_NO_BOOT = 'STOP: server-core loaded without a prepared cloud boot; refusing to start in production (server.js must prepare the boot).';

if (process.argv[2] === '--child') {
  // Proceso hijo: carga server-core directamente (sin server.js) y, si la carga no lanza, intenta escuchar.
  const express = require('express');
  const originalListen = express.application.listen;
  express.application.listen = function listen(_port, _host, callback) {
    const server = originalListen.call(this, 0, '127.0.0.1', callback);
    server.once('listening', () => { console.log('CHILD_LISTENING'); server.close(); });
    return server;
  };
  require('../server-core').listenCloudServer();
} else {
  const test = require('node:test');
  const { createGuardContext } = require('../account-route-guards');
  const { prepareCloudBoot, prepareCloudCatalog, takeCloudBoot, REQUIRED_PRODUCTION_ENTRIES } = require('../cloud-boot');
  const { findLocalSecretFiles } = require('./helpers/local-secret-files.cjs');

  const captureWarnings = (fn) => {
    const original = console.warn;
    const lines = [];
    console.warn = (...args) => lines.push(args.join(' '));
    try { return { result: fn(), lines }; } finally { console.warn = original; }
  };
  const withNodeEnv = (value, fn) => () => {
    const original = process.env.NODE_ENV;
    if (value === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = value;
    try { return fn(); } finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
  };
  const fullGuards = () => {
    const guards = createGuardContext();
    for (const name of REQUIRED_PRODUCTION_ENTRIES) guards.entries[name] = { installed: true };
    return guards;
  };

  test('takeCloudBoot entrega el contexto preparado una sola vez y sin avisos', withNodeEnv(undefined, () => {
    const guards = createGuardContext();
    prepareCloudBoot({ guards });
    const first = captureWarnings(takeCloudBoot);
    assert.equal(first.result.guards, guards);
    assert.deepEqual(first.lines, []);
    const second = captureWarnings(takeCloudBoot);
    assert.notEqual(second.result.guards, guards, 'el traspaso se consume en la primera toma');
    assert.deepEqual(second.lines, [MISSING_BOOT]);
  }));

  test('(c) sin NODE_ENV y sin contexto preparado: contexto vacío (guardas en paso libre) y un único aviso', withNodeEnv(undefined, () => {
    const { result, lines } = captureWarnings(takeCloudBoot);
    assert.deepEqual(result.guards.entries, {});
    assert.deepEqual(lines, [MISSING_BOOT]);
  }));

  test('NODE_ENV=production sin contexto preparado: lanza y no avisa', withNodeEnv('production', () => {
    const { lines } = captureWarnings(() => assert.throws(takeCloudBoot, { message: STOP_NO_BOOT }));
    assert.deepEqual(lines, []);
  }));

  test('NODE_ENV=production con contexto sin las entradas obligatorias: lanza y nombra las que faltan', withNodeEnv('production', () => {
    const guards = fullGuards();
    delete guards.entries.sessionSecurity;
    delete guards.entries.authAbuse;
    prepareCloudBoot({ guards });
    assert.throws(takeCloudBoot, { message: /^STOP: cloud boot without required guard entries \(sessionSecurity, authAbuse\)/ });
    prepareCloudBoot();
    assert.throws(takeCloudBoot, { message: /required guard entries \(runtime, securityHeaders, / });
  }));

  // Las 11 entradas que server.js instala siempre antes de cargar server-core (lista fija aquí, no derivada de cloud-boot).
  const SERVER_JS_ENTRIES = ['runtime', 'securityHeaders', 'legacyMediaUploadDisable', 'authPublicRegistrationHardening',
    'pendingSignupBoundary', 'accountLifecycle', 'sessionSecurity', 'httpContainment', 'directCapability', 'authAbuse', 'tempAuthBoundary'];
  for (const name of SERVER_JS_ENTRIES) {
    test(`NODE_ENV=production con contexto completo salvo ${name}: lanza STOP que la nombra`, withNodeEnv('production', () => {
      const guards = createGuardContext();
      for (const entry of SERVER_JS_ENTRIES) if (entry !== name) guards.entries[entry] = { installed: true };
      prepareCloudBoot({ guards });
      assert.throws(takeCloudBoot, { message: `STOP: cloud boot without required guard entries (${name}); refusing to start in production (server.js must prepare the boot).` });
    }));
  }

  test('NODE_ENV=production con todas las entradas obligatorias: entrega el contexto sin avisos', withNodeEnv('production', () => {
    const guards = fullGuards();
    prepareCloudBoot({ guards });
    const { result, lines } = captureWarnings(takeCloudBoot);
    assert.equal(result.guards, guards);
    assert.deepEqual(lines, []);
  }));

  test('prepareCloudCatalog sin prepareCloudBoot: en producción lanza', withNodeEnv('production', () => {
    assert.throws(() => prepareCloudCatalog({}, () => {}),
      { message: 'STOP: catalog prepared without a prepared cloud boot; refusing to start in production (server.js must prepare the boot).' });
  }));

  test('prepareCloudCatalog sin prepareCloudBoot fuera de producción: avisa y crea guardas por defecto', withNodeEnv(undefined, () => {
    const services = {};
    const { lines } = captureWarnings(() => prepareCloudCatalog(services, () => {}));
    assert.deepEqual(lines, ['[boot] catálogo preparado sin contexto de arranque']);
    const boot = captureWarnings(takeCloudBoot);
    assert.equal(boot.result.catalog.services, services);
    assert.deepEqual(boot.result.guards.entries, {});
    assert.deepEqual(boot.lines, []);
  }));

  const loadServerCoreDirectly = (env) => {
    assert.equal(findLocalSecretFiles(path.resolve(__dirname, '../..')).length, 0, 'requires a clean Cloud checkout');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-cloud-boot-'));
    try {
      const preloads = ['catalog-net-guard.cjs', 'no-dotenv.cjs', 'pg-port-guard.cjs'];
      const args = preloads.flatMap(file => ['--require', path.join(__dirname, 'helpers', file)]);
      const child = spawnSync(process.execPath, [...args, __filename, '--child'], {
        cwd: scratch,
        env: {
          SystemRoot: process.env.SystemRoot, TEMP: scratch, TMP: scratch, PORT: '0',
          BEATGALER_STATE_DIR: scratch, DIRECT_DIAGNOSTICS_DIR: scratch, CATALOG_NET_POLICY: 'loopback', AWS_EC2_METADATA_DISABLED: 'true',
          ...env,
        },
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.ifError(child.error);
      return child;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };

  test('(a) NODE_ENV=production: server-core cargado sin server.js no escucha y sale con el error', () => {
    const child = loadServerCoreDirectly({ NODE_ENV: 'production' });
    const output = `${child.stdout}${child.stderr}`;
    assert.notEqual(child.status, 0, output);
    assert.ok(child.stderr.includes(STOP_NO_BOOT), output);
    assert.ok(!output.includes('CHILD_LISTENING'), output);
    assert.ok(!output.includes(MISSING_BOOT), output);
  });

  test('(c) sin NODE_ENV: server-core cargado sin server.js avisa una vez y sigue arrancando (comportamiento actual)', () => {
    const child = loadServerCoreDirectly({});
    const output = `${child.stdout}${child.stderr}`;
    assert.equal(child.status, 0, output);
    assert.equal(output.split(MISSING_BOOT).length - 1, 1, output);
    assert.ok(child.stdout.includes('CHILD_LISTENING'), output);
  });
}
