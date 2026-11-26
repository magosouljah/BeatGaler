'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createGuardContext } = require('../account-route-guards');
const { prepareCloudBoot, takeCloudBoot } = require('../cloud-boot');

function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try { return { result: fn(), lines }; } finally { console.warn = original; }
}

test('takeCloudBoot entrega el contexto preparado una sola vez y sin avisos', () => {
  const guards = createGuardContext();
  prepareCloudBoot({ guards });
  const first = captureWarnings(takeCloudBoot);
  assert.equal(first.result.guards, guards);
  assert.deepEqual(first.lines, []);
  const second = captureWarnings(takeCloudBoot);
  assert.notEqual(second.result.guards, guards, 'el traspaso se consume en la primera toma');
  assert.deepEqual(second.lines, ['[boot] server-core sin contexto de arranque']);
});

test('sin contexto preparado hay un contexto vacío (guardas en paso libre) y un único aviso', () => {
  const { result, lines } = captureWarnings(takeCloudBoot);
  assert.deepEqual(result.guards.entries, {});
  assert.deepEqual(lines, ['[boot] server-core sin contexto de arranque']);
});
