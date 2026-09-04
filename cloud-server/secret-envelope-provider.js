'use strict';

const { normalizeSecretKeyring } = require('./secret-keyring');

const PROVIDERS = new Set(['development', 'aws-secrets-manager']);
const AWS_SECRET_SCHEMA = 'beatgaler-envelope-keyring-v1';

function secretEnvelopeProviderConfig(env = process.env) {
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const provider = String(env.BEATGALER_SECRET_ENVELOPE_PROVIDER || (production ? '' : 'development')).trim().toLowerCase();
  if (!provider) {
    throw new Error('Production PostgreSQL authority requires BEATGALER_SECRET_ENVELOPE_PROVIDER=aws-secrets-manager.');
  }
  if (!PROVIDERS.has(provider)) {
    throw new Error('BEATGALER_SECRET_ENVELOPE_PROVIDER must be development or aws-secrets-manager.');
  }
  if (production && provider !== 'aws-secrets-manager') {
    throw new Error('Production PostgreSQL authority requires aws-secrets-manager; local envelope keys are forbidden.');
  }
  if (provider === 'aws-secrets-manager' && String(env.BEATGALER_SECRET_ENVELOPE_KEY_B64 || '').trim()) {
    throw new Error('BEATGALER_SECRET_ENVELOPE_KEY_B64 cannot be set with aws-secrets-manager.');
  }
  return Object.freeze({ provider, production });
}

function developmentEnvelopeKeyConfig(env = process.env) {
  const raw = String(env.BEATGALER_SECRET_ENVELOPE_KEY_B64 || '').trim();
  const keyVersion = Number(env.BEATGALER_SECRET_ENVELOPE_KEY_VERSION || 1);
  if (!raw) throw new Error('Development/CI envelope provider requires BEATGALER_SECRET_ENVELOPE_KEY_B64.');
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new Error('Development/CI envelope keys are forbidden in production.');
  }
  if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
    throw new Error('BEATGALER_SECRET_ENVELOPE_KEY_VERSION must be a positive integer.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BEATGALER_SECRET_ENVELOPE_KEY_B64 must decode to exactly 32 bytes.');
  return Object.freeze({ key, keyVersion });
}

function decodeCanonicalBase64Key(encodedRaw, version) {
  if (typeof encodedRaw !== 'string' || !encodedRaw) {
    throw new Error(`AWS envelope key v${version} must be base64 text.`);
  }
  const key = Buffer.from(encodedRaw, 'base64');
  if (key.toString('base64') !== encodedRaw) {
    throw new Error(`AWS envelope key v${version} must be canonical base64 text.`);
  }
  if (key.length !== 32) throw new Error(`AWS envelope key v${version} must decode to exactly 32 bytes.`);
  return key;
}

function parseAwsEnvelopeKeyringSecret(secretString) {
  if (typeof secretString !== 'string' || !secretString.trim()) {
    throw new Error('AWS Secrets Manager returned an empty envelope keyring secret.');
  }
  let parsed;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error('AWS envelope keyring secret must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AWS envelope keyring secret must be a JSON object.');
  }
  if (parsed.schema !== AWS_SECRET_SCHEMA) {
    throw new Error(`AWS envelope keyring secret schema must be ${AWS_SECRET_SCHEMA}.`);
  }
  const activeKeyVersion = Number(parsed.activeKeyVersion);
  if (!Number.isInteger(activeKeyVersion) || activeKeyVersion <= 0) {
    throw new Error('AWS envelope keyring activeKeyVersion must be a positive integer.');
  }
  if (!parsed.keys || typeof parsed.keys !== 'object' || Array.isArray(parsed.keys)) {
    throw new Error('AWS envelope keyring secret requires a keys object.');
  }
  const keys = new Map();
  for (const [versionRaw, encodedRaw] of Object.entries(parsed.keys)) {
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version <= 0 || String(version) !== String(versionRaw)) {
      throw new Error(`Invalid AWS envelope key version: ${versionRaw}.`);
    }
    const key = decodeCanonicalBase64Key(encodedRaw, version);
    keys.set(version, key);
  }
  return Object.freeze({ activeKeyVersion, keys });
}

async function defaultAwsSecretFetcher({ secretId, region }) {
  let sdk;
  try {
    sdk = require('@aws-sdk/client-secrets-manager');
  } catch (error) {
    const wrapped = new Error('aws-secrets-manager provider requires @aws-sdk/client-secrets-manager in the locked cloud-server runtime.');
    wrapped.cause = error;
    throw wrapped;
  }
  const client = new sdk.SecretsManagerClient(region ? { region } : {});
  const response = await client.send(new sdk.GetSecretValueCommand({ SecretId: secretId, VersionStage: 'AWSCURRENT' }));
  if (typeof response.SecretString === 'string') return response.SecretString;
  if (response.SecretBinary) return Buffer.from(response.SecretBinary).toString('utf8');
  throw new Error('AWS Secrets Manager response contains neither SecretString nor SecretBinary.');
}

async function awsSecretsManagerEnvelopeKeyring(env = process.env, { fetchSecret = defaultAwsSecretFetcher } = {}) {
  const secretId = String(env.BEATGALER_AWS_SECRET_ENVELOPE_ID || '').trim();
  const region = String(env.AWS_REGION || env.AWS_DEFAULT_REGION || '').trim();
  if (!secretId) throw new Error('aws-secrets-manager provider requires BEATGALER_AWS_SECRET_ENVELOPE_ID.');
  const secretString = await fetchSecret({ secretId, region: region || undefined });
  return parseAwsEnvelopeKeyringSecret(secretString);
}

async function resolveSecretEnvelopeKeyring(env = process.env, options = {}) {
  const config = secretEnvelopeProviderConfig(env);
  if (config.provider === 'development') {
    return normalizeSecretKeyring(developmentEnvelopeKeyConfig(env));
  }
  const awsKeyring = await awsSecretsManagerEnvelopeKeyring(env, options);
  return normalizeSecretKeyring(awsKeyring);
}

module.exports = {
  AWS_SECRET_SCHEMA,
  PROVIDERS,
  secretEnvelopeProviderConfig,
  developmentEnvelopeKeyConfig,
  parseAwsEnvelopeKeyringSecret,
  defaultAwsSecretFetcher,
  awsSecretsManagerEnvelopeKeyring,
  resolveSecretEnvelopeKeyring,
};
