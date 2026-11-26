'use strict';

// B9: los build* del catálogo son fábricas puras: devuelven la instancia (nueva en cada llamada),
// o null si falta la configuración mínima; no guardan estado de módulo.
const assert = require('node:assert/strict');
const test = require('node:test');

const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
const authority = { config: { nativeEnabled: true }, availability: async () => {}, requireLibraryForMutation: async () => ({}), resolveContext: async () => ({}) };
const base = { pool, authority };

const cases = [
  ['queries', () => require('../catalog/queries').buildCatalogQueries, { ...base, env: {} }],
  ['commands', () => require('../catalog/commands').buildCatalogCommands, base],
  ['operations', () => require('../catalog/operations').buildCatalogOperations, { ...base, resolveAccess: async () => ({ maxBeats: null }) }],
  ['playback', () => require('../catalog/playback').buildCatalogPlayback, base],
  ['media', () => require('../catalog/media').buildCatalogMedia, base],
  ['purge', () => require('../catalog/purge').buildCatalogPurge, base],
  ['prefixPacks', () => require('../catalog/prefix-packs').buildPrefixPacks, base],
  ['direct', () => require('../catalog/direct').buildCatalogDirect, { ...base, operations: { markDispatched() {}, putReceipt() {} }, resolveProjectAccess: async () => ({}), sessionSource: async () => ({}), bindBuilder: () => ({}) }],
  ['transport', () => require('../catalog/native-transport-provisioning').buildNativeTransportProvisioner, { pool, assignmentStore: { withMembershipLock: async () => {} }, transport: { ensureCatalogBotMembership() {} } }],
];

for (const [name, load, options] of cases) {
  test(`build ${name}: devuelve una instancia nueva y null sin configuración`, () => {
    const build = load();
    assert.equal(typeof build, 'function');
    const a = build(options);
    const b = build(options);
    assert.ok(a && typeof a === 'object', 'devuelve la instancia');
    assert.notEqual(a, b, 'sin estado de módulo: cada llamada es una instancia propia');
    assert.equal(build(null), null);
    assert.equal(build(), null);
  });
}

test('los singletons configureX/currentX ya no se exportan', () => {
  for (const mod of ['queries', 'commands', 'operations', 'playback', 'media', 'purge', 'prefix-packs', 'direct', 'native-transport-provisioning']) {
    const exported = Object.keys(require(`../catalog/${mod}`));
    assert.deepEqual(exported.filter((k) => /^(configure|current)[A-Z]/.test(k)), [], mod);
  }
});
