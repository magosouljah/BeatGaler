'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
require('./helpers/catalog-net-guard.cjs');
require('./helpers/no-dotenv.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-pool-atomic-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
const bot = { id: 'Bot01', token: 'fake-token' };
fs.writeFileSync(poolFile, JSON.stringify({ bots: [bot] }));
process.env.TRANSPORT_BOTS_FILE = poolFile;
process.env.TRANSPORT_POOL_STATE = stateFile;
process.env.DIRECT_DIAGNOSTICS_DIR = path.join(tmp, 'diag');
process.env.BEATGALER_DIRECT_TRANSPORT = 'false';
process.env.DIRECT_TOKEN_ROTATION_ENABLED = 'false';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'telegram') return { TelegramClient: class {}, Api: {} };
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, parent, isMain);
};
const direct = require('../direct-transport-control.js');
Module._load = originalLoad;
const pool = [bot];
const leftovers = () => fs.readdirSync(tmp).filter(name => name.includes('.tmp-'));

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('la mutación del estado del pool se persiste completa y sin temporales', () => {
  direct.__testing.mutateState(pool, state => { state.metrics.marker = 'one'; });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).metrics.marker, 'one');
  assert.deepEqual(leftovers(), []);
});

test('el estado se vuelca a disco (fsync) antes de reemplazar el archivo por renombrado', (t) => {
  const order = [];
  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', (fd) => { order.push('fsync'); return realFsync(fd); });
  t.mock.method(fs, 'renameSync', (from, to) => {
    order.push('rename');
    assert.equal(to, stateFile);
    assert.notEqual(from, stateFile);
    assert.equal(JSON.parse(fs.readFileSync(from, 'utf8')).metrics.marker, 'two', 'el temporal ya contiene el estado completo');
    return realRename(from, to);
  });
  direct.__testing.mutateState(pool, state => { state.metrics.marker = 'two'; });
  assert.deepEqual(order, ['fsync', 'rename']);
});

test('si el reemplazo falla, el estado anterior queda intacto y no sobran temporales', (t) => {
  const before = fs.readFileSync(stateFile, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); });
  assert.throws(() => direct.__testing.mutateState(pool, state => { state.metrics.marker = 'lost'; }), { code: 'EIO' });
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.deepEqual(leftovers(), []);
});

test('el helper de flood-wait de Telegram retirado no puede volver a resolverse', () => {
  assert.throws(() => require.resolve('../telegram-retry'), { code: 'MODULE_NOT_FOUND' });
});
