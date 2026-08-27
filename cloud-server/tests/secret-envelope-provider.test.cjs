'use strict';

const assert = require('assert');
const {
  AWS_SECRET_SCHEMA,
  secretEnvelopeProviderConfig,
  parseAwsEnvelopeKeyringSecret,
  awsSecretsManagerEnvelopeKeyring,
  resolveSecretEnvelopeKeyring,
} = require('../secret-envelope-provider');
const { encryptionCallbacks } = require('../postgres-control-plane-runtime');

const key7 = Buffer.alloc(32, 7);
const key8 = Buffer.alloc(32, 8);
const key7B64 = key7.toString('base64');
const key8B64 = key8.toString('base64');

assert.deepEqual(secretEnvelopeProviderConfig({ NODE_ENV: 'test' }), {
  provider: 'development',
  production: false,
});
assert.throws(() => secretEnvelopeProviderConfig({ NODE_ENV: 'production' }), /requires BEATGALER_SECRET_ENVELOPE_PROVIDER=aws-secrets-manager/);
assert.throws(() => secretEnvelopeProviderConfig({
  NODE_ENV: 'production',
  BEATGALER_SECRET_ENVELOPE_PROVIDER: 'development',
}), /local envelope keys are forbidden/);
assert.throws(() => secretEnvelopeProviderConfig({
  NODE_ENV: 'production',
  BEATGALER_SECRET_ENVELOPE_PROVIDER: 'aws-secrets-manager',
  BEATGALER_SECRET_ENVELOPE_KEY_B64: key8B64,
}), /cannot be set with aws-secrets-manager/);

const parsed = parseAwsEnvelopeKeyringSecret(JSON.stringify({
  schema: AWS_SECRET_SCHEMA,
  activeKeyVersion: 8,
  keys: { 7: key7B64, 8: key8B64 },
}));
assert.equal(parsed.activeKeyVersion, 8);
assert.deepEqual(parsed.keys.get(7), key7);
assert.deepEqual(parsed.keys.get(8), key8);
assert.throws(() => parseAwsEnvelopeKeyringSecret('{}'), /schema/);
assert.throws(() => parseAwsEnvelopeKeyringSecret(JSON.stringify({
  schema: AWS_SECRET_SCHEMA,
  activeKeyVersion: 8,
  keys: { 8: Buffer.alloc(31, 8).toString('base64') },
})), /exactly 32 bytes/);
assert.throws(() => parseAwsEnvelopeKeyringSecret(JSON.stringify({
  schema: AWS_SECRET_SCHEMA,
  activeKeyVersion: 8,
  keys: { 8: `${key8B64.slice(0, 10)}*${key8B64.slice(11)}` },
})), /canonical base64/);
assert.throws(() => parseAwsEnvelopeKeyringSecret(JSON.stringify({
  schema: AWS_SECRET_SCHEMA,
  activeKeyVersion: 8,
  keys: { 8: `${key8B64}=` },
})), /canonical base64/);
assert.throws(() => parseAwsEnvelopeKeyringSecret(JSON.stringify({
  schema: AWS_SECRET_SCHEMA,
  activeKeyVersion: 8,
  keys: { 8: `${key8B64}trailing-data` },
})), /canonical base64/);

(async () => {
  let observedRequest = null;
  const env = {
    NODE_ENV: 'production',
    BEATGALER_SECRET_ENVELOPE_PROVIDER: 'aws-secrets-manager',
    BEATGALER_AWS_SECRET_ENVELOPE_ID: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:beatgaler/prod/control-plane-envelope',
    AWS_REGION: 'us-east-1',
  };
  const fetchSecret = async request => {
    observedRequest = request;
    return JSON.stringify({
      schema: AWS_SECRET_SCHEMA,
      activeKeyVersion: 8,
      keys: { 7: key7B64, 8: key8B64 },
    });
  };

  const awsConfig = await awsSecretsManagerEnvelopeKeyring(env, { fetchSecret });
  assert.equal(observedRequest.secretId, env.BEATGALER_AWS_SECRET_ENVELOPE_ID);
  assert.equal(observedRequest.region, 'us-east-1');
  assert.equal(awsConfig.activeKeyVersion, 8);

  const keyring = await resolveSecretEnvelopeKeyring(env, { fetchSecret });
  assert.equal(keyring.activeKeyVersion, 8);
  assert.deepEqual(keyring.availableVersions, [7, 8]);
  assert.deepEqual(keyring.resolveKey(7), key7);
  assert.deepEqual(keyring.encryptKey, key8);

  const callbacks = encryptionCallbacks(keyring);
  const oldCiphertext = require('../secret-envelope').encryptSecretForStorage('old-secret', {
    key: key7,
    keyVersion: 7,
    aad: 'provider:google:u1:access',
  });
  assert.equal(callbacks.decrypt(oldCiphertext, { aad: 'provider:google:u1:access' }), 'old-secret');
  const fresh = callbacks.encrypt('new-secret', { aad: 'provider:google:u1:access' });
  assert.equal(fresh.keyVersion, 8);
  assert.equal(callbacks.decrypt(fresh, { aad: 'provider:google:u1:access' }), 'new-secret');

  await assert.rejects(() => awsSecretsManagerEnvelopeKeyring({
    NODE_ENV: 'production',
    BEATGALER_SECRET_ENVELOPE_PROVIDER: 'aws-secrets-manager',
  }, { fetchSecret }), /BEATGALER_AWS_SECRET_ENVELOPE_ID/);

  await assert.rejects(() => resolveSecretEnvelopeKeyring(env, {
    fetchSecret: async () => JSON.stringify({
      schema: AWS_SECRET_SCHEMA,
      activeKeyVersion: 9,
      keys: { 8: key8B64 },
    }),
  }), /Active secret key version 9 is unavailable/);

  console.log('PASS secret envelope provider: production fail-closed, strict AWS keyring contract, rotation-safe runtime');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
