'use strict';

const assert = require('assert');
const { controlPlaneAuthorityConfig, developmentEnvelopeKeyConfig } = require('../control-plane-authority.js');

assert.deepEqual(controlPlaneAuthorityConfig({}), {
  authority: 'json',
  postgresEnabled: false,
  expectedSnapshotSha256: '',
});

// M7.6b-b2 (D17): con PostgreSQL configurado no hay autoridad por defecto ni json.
assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_POSTGRES_ENABLED: 'true' }), /requires BEATGALER_CONTROL_PLANE_AUTHORITY=postgres/);
assert.throws(() => controlPlaneAuthorityConfig({
  BEATGALER_CONTROL_PLANE_AUTHORITY: 'json',
  BEATGALER_POSTGRES_ENABLED: 'true',
}), /JSON control-plane authority is not allowed/);
assert.throws(() => controlPlaneAuthorityConfig({ NODE_ENV: 'production' }), /forbidden with NODE_ENV=production/);
assert.throws(() => controlPlaneAuthorityConfig({ NODE_ENV: 'production', BEATGALER_CONTROL_PLANE_AUTHORITY: 'json' }), /forbidden with NODE_ENV=production/);

assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres' }), /requires BEATGALER_POSTGRES_ENABLED=true/);
assert.throws(() => controlPlaneAuthorityConfig({
  BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
  BEATGALER_POSTGRES_ENABLED: 'true',
}), /CUTOVER_SNAPSHOT_SHA256/);
assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'dual' }), /json or postgres/);

const sha = 'a'.repeat(64);
assert.deepEqual(controlPlaneAuthorityConfig({
  BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
  BEATGALER_POSTGRES_ENABLED: 'true',
  BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: sha,
}), {
  authority: 'postgres',
  postgresEnabled: true,
  expectedSnapshotSha256: sha,
});
assert.equal(controlPlaneAuthorityConfig({
  NODE_ENV: 'production',
  BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
  BEATGALER_POSTGRES_ENABLED: 'true',
  BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: sha,
}).authority, 'postgres');

const keyB64 = Buffer.alloc(32, 9).toString('base64');
const devKey = developmentEnvelopeKeyConfig({
  NODE_ENV: 'test',
  BEATGALER_SECRET_ENVELOPE_KEY_B64: keyB64,
  BEATGALER_SECRET_ENVELOPE_KEY_VERSION: '7',
});
assert.equal(devKey.keyVersion, 7);
assert.deepEqual(devKey.key, Buffer.alloc(32, 9));
assert.throws(() => developmentEnvelopeKeyConfig({
  NODE_ENV: 'production',
  BEATGALER_SECRET_ENVELOPE_KEY_B64: keyB64,
}), /forbidden in production/);

console.log('PASS control-plane authority: explicit with PostgreSQL, json only without PostgreSQL and outside production, fail-closed');
