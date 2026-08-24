import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// M0-A only: protocol-vector proof for Telegram auth.bindTempAuthKey.
// No network, no bot token, no API hash and no real Telegram auth key are used.
// Sources:
// - https://core.telegram.org/method/auth.bindTempAuthKey
// - https://core.telegram.org/mtproto/description_v1
// - OpenSSL IGE test vector: https://www.links.org/files/openssl-ige.pdf

const BIND_AUTH_KEY_INNER = 0x75a3f765;
const BIND_AUTH_KEY_INNER_BYTES = 40;
const BLOCK_BYTES = 16;

function sha1(...parts) {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function xor(left, right) {
  assert.equal(left.length, right.length);
  const out = Buffer.allocUnsafe(left.length);
  for (let i = 0; i < left.length; i += 1) out[i] = left[i] ^ right[i];
  return out;
}

function aesEcb(block, key, decrypt = false) {
  const bits = key.length * 8;
  assert.ok([128, 192, 256].includes(bits));
  assert.equal(block.length, BLOCK_BYTES);
  const cipher = decrypt
    ? createDecipheriv(`aes-${bits}-ecb`, key, null)
    : createCipheriv(`aes-${bits}-ecb`, key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

export function aesIgeEncrypt(plaintext, key, iv) {
  assert.equal(plaintext.length % BLOCK_BYTES, 0, 'IGE plaintext must be block aligned');
  assert.equal(iv.length, BLOCK_BYTES * 2, 'IGE IV must contain x0 || y0');
  let previousCipher = Buffer.from(iv.subarray(0, BLOCK_BYTES));
  let previousPlain = Buffer.from(iv.subarray(BLOCK_BYTES));
  const output = [];
  for (let offset = 0; offset < plaintext.length; offset += BLOCK_BYTES) {
    const plain = plaintext.subarray(offset, offset + BLOCK_BYTES);
    const encrypted = aesEcb(xor(plain, previousCipher), key);
    const cipher = xor(encrypted, previousPlain);
    output.push(cipher);
    previousCipher = cipher;
    previousPlain = Buffer.from(plain);
  }
  return Buffer.concat(output);
}

export function aesIgeDecrypt(ciphertext, key, iv) {
  assert.equal(ciphertext.length % BLOCK_BYTES, 0, 'IGE ciphertext must be block aligned');
  assert.equal(iv.length, BLOCK_BYTES * 2, 'IGE IV must contain x0 || y0');
  let previousCipher = Buffer.from(iv.subarray(0, BLOCK_BYTES));
  let previousPlain = Buffer.from(iv.subarray(BLOCK_BYTES));
  const output = [];
  for (let offset = 0; offset < ciphertext.length; offset += BLOCK_BYTES) {
    const cipher = ciphertext.subarray(offset, offset + BLOCK_BYTES);
    const decrypted = aesEcb(xor(cipher, previousPlain), key, true);
    const plain = xor(decrypted, previousCipher);
    output.push(plain);
    previousCipher = Buffer.from(cipher);
    previousPlain = plain;
  }
  return Buffer.concat(output);
}

function writeLongLE(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function writeIntLE(value) {
  const out = Buffer.alloc(4);
  out.writeInt32LE(Number(value));
  return out;
}

function writeConstructor(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

export function authKeyIdBytes(permanentAuthKey) {
  assert.equal(permanentAuthKey.length, 256, 'Telegram auth_key must be 2048 bits');
  return sha1(permanentAuthKey).subarray(12, 20);
}

export function serializeBindAuthKeyInner({
  nonce,
  tempAuthKeyId,
  permAuthKeyId,
  tempSessionId,
  expiresAt,
}) {
  const serialized = Buffer.concat([
    writeConstructor(BIND_AUTH_KEY_INNER),
    writeLongLE(nonce),
    writeLongLE(tempAuthKeyId),
    writeLongLE(permAuthKeyId),
    writeLongLE(tempSessionId),
    writeIntLE(expiresAt),
  ]);
  assert.equal(serialized.length, BIND_AUTH_KEY_INNER_BYTES);
  return serialized;
}

export function deriveMtprotoV1Aes(permanentAuthKey, msgKey) {
  assert.equal(permanentAuthKey.length, 256);
  assert.equal(msgKey.length, 16);
  // auth.bindTempAuthKey's encrypted_message explicitly uses MTProto v1,
  // client -> server direction, therefore x = 0.
  const sha1A = sha1(msgKey, permanentAuthKey.subarray(0, 32));
  const sha1B = sha1(permanentAuthKey.subarray(32, 48), msgKey, permanentAuthKey.subarray(48, 64));
  const sha1C = sha1(permanentAuthKey.subarray(64, 96), msgKey);
  const sha1D = sha1(msgKey, permanentAuthKey.subarray(96, 128));
  return {
    aesKey: Buffer.concat([sha1A.subarray(0, 8), sha1B.subarray(8, 20), sha1C.subarray(4, 16)]),
    aesIv: Buffer.concat([sha1A.subarray(8, 20), sha1B.subarray(0, 8), sha1C.subarray(16, 20), sha1D.subarray(0, 8)]),
  };
}

export function buildTempAuthBindingEnvelope({
  permanentAuthKey,
  nonce,
  tempAuthKeyId,
  tempSessionId,
  expiresAt,
  msgId,
  random128 = randomBytes(16),
  padding,
}) {
  // Deliberately does NOT accept temporary-auth-key bytes. The controlled
  // binder needs only identifiers/metadata from the client plus permanent auth.
  const permAuthKeyIdBytes = authKeyIdBytes(permanentAuthKey);
  const permAuthKeyId = permAuthKeyIdBytes.readBigInt64LE(0);
  const inner = serializeBindAuthKeyInner({
    nonce,
    tempAuthKeyId,
    permAuthKeyId,
    tempSessionId,
    expiresAt,
  });
  const plaintext = Buffer.concat([
    Buffer.from(random128),
    writeLongLE(msgId),
    writeIntLE(0),
    writeIntLE(inner.length),
    inner,
  ]);
  assert.equal(plaintext.length, 72);

  // MTProto v1 msg_key excludes padding and is bytes 4..19 of SHA1(plaintext).
  const msgKey = sha1(plaintext).subarray(4, 20);
  const { aesKey, aesIv } = deriveMtprotoV1Aes(permanentAuthKey, msgKey);
  const padLength = (BLOCK_BYTES - (plaintext.length % BLOCK_BYTES)) % BLOCK_BYTES;
  const actualPadding = padding ?? randomBytes(padLength);
  assert.equal(actualPadding.length, padLength);
  const encrypted = aesIgeEncrypt(Buffer.concat([plaintext, actualPadding]), aesKey, aesIv);
  const encryptedMessage = Buffer.concat([permAuthKeyIdBytes, msgKey, encrypted]);

  return {
    encryptedMessage,
    permAuthKeyId,
    msgKey,
    plaintextLength: plaintext.length,
    paddingLength: padLength,
  };
}

function testOpenSslIgeVector() {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const iv = Buffer.from(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    'hex',
  );
  const plaintext = Buffer.alloc(32);
  const expected = Buffer.from(
    '1a8519a6557be652e9da8e43da4ef4453cf456b4ca488aa383c79c98b34797cb',
    'hex',
  );
  assert.deepEqual(aesIgeEncrypt(plaintext, key, iv), expected);
  assert.deepEqual(aesIgeDecrypt(expected, key, iv), plaintext);
}

function testSyntheticBindingVector() {
  const permanentAuthKey = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const nonce = 0x0102030405060708n;
  const tempAuthKeyId = 0x1112131415161718n;
  const tempSessionId = 0x2122232425262728n;
  const expiresAt = 1_800_000_000;
  const msgId = 0x1234567890abcdf0n; // divisible by 4, as required for a client msg_id
  const random128 = Buffer.from('303132333435363738393a3b3c3d3e3f', 'hex');
  const padding = Buffer.from('4041424344454647', 'hex');

  const result = buildTempAuthBindingEnvelope({
    permanentAuthKey,
    nonce,
    tempAuthKeyId,
    tempSessionId,
    expiresAt,
    msgId,
    random128,
    padding,
  });
  assert.equal(result.encryptedMessage.length, 104);
  assert.equal(result.plaintextLength, 72);
  assert.equal(result.paddingLength, 8);
  assert.deepEqual(result.encryptedMessage.subarray(0, 8), authKeyIdBytes(permanentAuthKey));

  const encrypted = result.encryptedMessage.subarray(24);
  const { aesKey, aesIv } = deriveMtprotoV1Aes(permanentAuthKey, result.msgKey);
  const decrypted = aesIgeDecrypt(encrypted, aesKey, aesIv);
  const plaintext = decrypted.subarray(0, 72);
  assert.deepEqual(sha1(plaintext).subarray(4, 20), result.msgKey);
  assert.equal(plaintext.readBigInt64LE(16), msgId);
  assert.equal(plaintext.readInt32LE(24), 0);
  assert.equal(plaintext.readInt32LE(28), 40);
  assert.equal(plaintext.readUInt32LE(32), BIND_AUTH_KEY_INNER);
  assert.equal(plaintext.readBigInt64LE(36), nonce);
  assert.equal(plaintext.readBigInt64LE(44), tempAuthKeyId);
  assert.equal(plaintext.readBigInt64LE(52), result.permAuthKeyId);
  assert.equal(plaintext.readBigInt64LE(60), tempSessionId);
  assert.equal(plaintext.readInt32LE(68), expiresAt);

  permanentAuthKey.fill(0);
  aesKey.fill(0);
  aesIv.fill(0);

  return {
    mode: 'M0-A synthetic binding-vector only',
    permanent_auth_reaches_client: false,
    temp_auth_key_bytes_reach_binder: false,
    galer_file_bytes: false,
    network_bind_proven: false,
    direct_mtproto_operation_proven: false,
    next_gate: 'Generate a real temporary auth key client-side and submit auth.bindTempAuthKey directly to Telegram.',
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('telegram-temp-auth-binding-vector.mjs')) {
  testOpenSslIgeVector();
  const summary = testSyntheticBindingVector();
  console.log('PASS M0-A temp-auth binding vector: permanent-side envelope can be built without temp-key bytes or file relay');
  console.log(JSON.stringify(summary));
}
