'use strict';
// Complemento por comportamiento de catalog-contract.test.cjs (que conserva las guardas de texto, incluidos los require perezosos).
// Mide lo que los módulos piden al CARGARSE (Module._load); alcance: importaciones de nivel superior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const server = path.join(__dirname, '..', '..');
function requestsOf(file) {
  const seen = [];
  const original = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && parent.filename === file) seen.push(request);
    return original.call(this, request, parent, ...rest);
  };
  delete require.cache[file];
  try { require(file); } finally { Module._load = original; }
  return seen;
}

test('runtime-env no tiene dependencias y catalog/ no carga transporte ni red', () => {
  assert.deepEqual(requestsOf(path.join(server, 'runtime-env.js')), []);
  const forbidden = /^(https?|net|tls|dgram|child_process|telegram|big-integer)(\/|$)|operator/;
  for (const f of fs.readdirSync(path.join(server, 'catalog')).filter((x) => x.endsWith('.js'))) {
    for (const r of requestsOf(path.join(server, 'catalog', f))) assert.doesNotMatch(r, forbidden, `${f} carga ${r}`);
  }
});

test('el runtime del servidor no carga el módulo de operador', () => {
  const runtime = ['catalog-worker.js', 'catalog-gateway-runtime.js', ...fs.readdirSync(path.join(server, 'catalog')).filter((x) => x.endsWith('.js')).map((x) => path.join('catalog', x))];
  for (const x of runtime) { delete require.cache[path.join(server, x)]; require(path.join(server, x)); }
  assert.deepEqual(Object.keys(require.cache).filter((k) => k.split(path.sep).includes('operator')), []);
});
