'use strict';

const assert = require('assert');
const { encryptSecret, decryptSecret } = require('../secret-envelope.js');

const key1 = Buffer.alloc(32, 1);
const key2 = Buffer.alloc(32, 2);
const aad = 'provider:google:user-1:refresh';
const envelope = encryptSecret('refresh-secret', { key: key1, keyVersion: 1, aad });

assert.equal(decryptSecret(envelope, { resolveKey: version => version === 1 ? key1 : key2, aad }), 'refresh-secret');
assert.equal(envelope.key_version, 1);
assert.notEqual(envelope.ciphertext_b64, Buffer.from('refresh-secret').toString('base64'));

assert.throws(() => decryptSecret({ ...envelope, ciphertext_b64: Buffer.from('tampered').toString('base64') }, {
  resolveKey: () => key1,
  aad,
}));
assert.throws(() => decryptSecret(envelope, { resolveKey: () => key1, aad: 'wrong-aad' }));
assert.throws(() => decryptSecret(envelope, { resolveKey: () => key2, aad }));

const rotated = encryptSecret(decryptSecret(envelope, { resolveKey: () => key1, aad }), {
  key: key2,
  keyVersion: 2,
  aad,
});
assert.equal(rotated.key_version, 2);
assert.equal(decryptSecret(rotated, { resolveKey: version => version === 2 ? key2 : key1, aad }), 'refresh-secret');

console.log('PASS secret envelope: authenticated encryption, tamper rejection, key rotation');
