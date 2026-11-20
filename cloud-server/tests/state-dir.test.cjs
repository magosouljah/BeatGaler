'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveStateDir, assertProductionStateDir, CODE_DIR } = require('../state-dir');

test('sin BEATGALER_STATE_DIR fuera de producción conserva el directorio histórico (junto al código)', () => {
  assert.equal(resolveStateDir({}), CODE_DIR);
  assert.equal(assertProductionStateDir({ NODE_ENV: 'development' }), CODE_DIR);
});

test('producción exige un directorio de estado existente y FUERA de la release', () => {
  const prod = { BEATGALER_DEPLOYMENT_ENV: 'production' };
  assert.throws(() => assertProductionStateDir(prod), /required in production/);
  assert.throws(() => assertProductionStateDir({ ...prod, BEATGALER_STATE_DIR: path.join(os.tmpdir(), 'bg-no-such-state-dir-xyz') }), /does not exist/);
  assert.throws(() => assertProductionStateDir({ ...prod, BEATGALER_STATE_DIR: CODE_DIR }), /outside the release/);
  assert.throws(() => assertProductionStateDir({ ...prod, BEATGALER_STATE_DIR: path.resolve(CODE_DIR, '..') }), /outside the release/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-state-'));
  try { assert.equal(assertProductionStateDir({ ...prod, BEATGALER_STATE_DIR: dir }), path.resolve(dir)); } finally { fs.rmSync(dir, { recursive: true }); }
});
