'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('BeatGaler envelope key must be exactly 32 bytes.');
  }
  return key;
}

function requireAad(aad) {
  const value = String(aad || '');
  if (!value) throw new Error('BeatGaler secret envelope requires non-empty AAD.');
  return Buffer.from(value, 'utf8');
}

function encryptSecret(plaintext, { key, keyVersion, aad }) {
  requireKey(key);
  if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
    throw new Error('BeatGaler secret envelope keyVersion must be a positive integer.');
  }
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(requireAad(aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Object.freeze({
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    key_version: keyVersion,
    nonce_b64: nonce.toString('base64'),
    ciphertext_b64: ciphertext.toString('base64'),
    tag_b64: tag.toString('base64'),
  });
}

function decryptSecret(envelope, { resolveKey, aad }) {
  if (!envelope || envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
    throw new Error('Unsupported BeatGaler secret envelope.');
  }
  if (typeof resolveKey !== 'function') throw new Error('resolveKey is required.');
  const key = requireKey(resolveKey(envelope.key_version));
  const nonce = Buffer.from(String(envelope.nonce_b64 || ''), 'base64');
  const ciphertext = Buffer.from(String(envelope.ciphertext_b64 || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag_b64 || ''), 'base64');
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed BeatGaler secret envelope.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(requireAad(aad));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = {
  ALGORITHM,
  ENVELOPE_VERSION,
  encryptSecret,
  decryptSecret,
};
