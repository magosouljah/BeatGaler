'use strict';

const assert = require('assert');
const { normalizeSecretKeyring } = require('../secret-keyring.js');

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

const legacy = normalizeSecretKeyring({ key: k1, keyVersion: 1 });
assert.equal(legacy.activeKeyVersion, 1);
assert.deepEqual(legacy.availableVersions, [1]);
assert.strictEqual(legacy.resolveKey(1), k1);
assert.throws(() => legacy.resolveKey(2), /unavailable/);

const ring = normalizeSecretKeyring({ activeKeyVersion: 2, keys: { 1: k1, 2: k2 } });
assert.equal(ring.activeKeyVersion, 2);
assert.deepEqual(ring.availableVersions, [1, 2]);
assert.strictEqual(ring.encryptKey, k2);
assert.strictEqual(ring.resolveKey(1), k1);
assert.strictEqual(ring.resolveKey(2), k2);
assert.throws(() => ring.resolveKey(3), /unavailable/);
assert.throws(() => normalizeSecretKeyring({ activeKeyVersion: 3, keys: { 1: k1, 2: k2 } }), /Active secret key version 3 is unavailable/);
assert.throws(() => normalizeSecretKeyring({ key: Buffer.alloc(31), keyVersion: 1 }), /exactly 32 bytes/);

console.log('PASS versioned secret keyring contract');
