'use strict';
// Valores efectivos de rotación de token y heartbeat de direct-transport-control:
// se carga el módulo en un proceso hijo (las constantes se fijan al cargar) y se observa
// el valor que expone, no el texto fuente.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-direct-defaults-'));
const poolFile = path.join(tmp, 'transport-bots.json');
fs.writeFileSync(poolFile, JSON.stringify({ bots: [{ id: 'BotTest', managed: true, telegram_user_id: '12345', telegram_username: 'DefaultsTestBot' }] }));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const modulePath = path.resolve(__dirname, '..', 'direct-transport-control.js');
const CHILD = `
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') return { TelegramClient: class {}, Api: {} };
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, parent, isMain);
};
const direct = require(${JSON.stringify(modulePath)});
const status = direct.poolStatus();
process.stdout.write('@@' + JSON.stringify({
  rotation: direct.__testing.TOKEN_ROTATION_ENABLED,
  heartbeatInterval: status.heartbeat_interval_ms,
  heartbeatTimeout: status.heartbeat_timeout_ms,
}));
`;

function effective(vars = {}) {
  const env = {};
  for (const k of ['Path', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'NODE_OPTIONS', 'CATALOG_NET_POLICY']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  Object.assign(env, {
    TRANSPORT_BOTS_FILE: poolFile,
    TRANSPORT_POOL_STATE: path.join(tmp, 'state.json'),
    DIRECT_DIAGNOSTICS_DIR: path.join(tmp, 'diag'),
    BEATGALER_DIRECT_TRANSPORT: 'false',
  }, vars);
  const r = spawnSync(process.execPath, [...process.execArgv, '-e', CHILD], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.split('@@')[1]);
}

test('sin variables: rotación desactivada, heartbeat 60 s y timeout 5 min', () => {
  assert.deepEqual(effective(), { rotation: false, heartbeatInterval: 60_000, heartbeatTimeout: 300_000 });
});

test('con variables fijadas se respetan', () => {
  const v = effective({
    DIRECT_TOKEN_ROTATION_ENABLED: ' YES ',
    DIRECT_HEARTBEAT_INTERVAL_MS: '45000',
    DIRECT_HEARTBEAT_TIMEOUT_MS: '120000',
  });
  assert.deepEqual(v, { rotation: true, heartbeatInterval: 45_000, heartbeatTimeout: 120_000 });
  assert.equal(effective({ DIRECT_TOKEN_ROTATION_ENABLED: 'false' }).rotation, false);
});

test('los mínimos acotan heartbeat e intervalo', () => {
  const v = effective({ DIRECT_HEARTBEAT_INTERVAL_MS: '1000', DIRECT_HEARTBEAT_TIMEOUT_MS: '1000' });
  assert.equal(v.heartbeatInterval, 30_000);
  assert.equal(v.heartbeatTimeout, 60_000);
});
