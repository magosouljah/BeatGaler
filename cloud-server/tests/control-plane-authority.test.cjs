'use strict';

const assert = require('assert');
const { controlPlaneAuthorityConfig, developmentEnvelopeKeyConfig } = require('../control-plane-authority.js');

assert.deepEqual(controlPlaneAuthorityConfig({}), {
  authority: 'json',
  postgresEnabled: false,
  expectedSnapshotSha256: '',
  expectedRollbackSha256: '',
});

assert.deepEqual(controlPlaneAuthorityConfig({ BEATGALER_POSTGRES_ENABLED: 'true' }), {
  authority: 'json',
  postgresEnabled: true,
  expectedSnapshotSha256: '',
  expectedRollbackSha256: '',
});

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
  expectedRollbackSha256: '',
});

assert.throws(() => controlPlaneAuthorityConfig({
  BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
  BEATGALER_POSTGRES_ENABLED: 'true',
  BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: sha,
  BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: sha,
}), /cannot be set/);
assert.throws(() => controlPlaneAuthorityConfig({
  BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: sha,
}), /requires BEATGALER_POSTGRES_ENABLED=true/);
assert.equal(controlPlaneAuthorityConfig({
  BEATGALER_POSTGRES_ENABLED: 'true',
  BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: sha,
}).expectedRollbackSha256, sha);

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
}), /real KMS\/Secret Manager/);

console.log('PASS control-plane authority: explicit, default-off, rollback-guarded, production fail-closed');
