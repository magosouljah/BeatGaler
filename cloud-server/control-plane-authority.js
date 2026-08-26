'use strict';

const { developmentEnvelopeKeyConfig } = require('./secret-envelope-provider');

const SNAPSHOT_SHA_RE = /^[0-9a-f]{64}$/;

function controlPlaneAuthorityConfig(env = process.env) {
  const authority = String(env.BEATGALER_CONTROL_PLANE_AUTHORITY || 'json').trim().toLowerCase();
  if (!['json', 'postgres'].includes(authority)) {
    throw new Error('BEATGALER_CONTROL_PLANE_AUTHORITY must be json or postgres.');
  }

  const postgresEnabled = String(env.BEATGALER_POSTGRES_ENABLED || '').toLowerCase() === 'true';
  const expectedSnapshotSha256 = String(env.BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256 || '').trim().toLowerCase();
  const expectedRollbackSha256 = String(env.BEATGALER_JSON_ROLLBACK_EXPORT_SHA256 || '').trim().toLowerCase();

  if (authority === 'postgres') {
    if (!postgresEnabled) {
      throw new Error('PostgreSQL control-plane authority requires BEATGALER_POSTGRES_ENABLED=true.');
    }
    if (!SNAPSHOT_SHA_RE.test(expectedSnapshotSha256)) {
      throw new Error('PostgreSQL control-plane authority requires BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256 (64 lowercase hex chars).');
    }
    if (expectedRollbackSha256) {
      throw new Error('BEATGALER_JSON_ROLLBACK_EXPORT_SHA256 cannot be set while PostgreSQL is authority.');
    }
  }

  if (expectedRollbackSha256 && !SNAPSHOT_SHA_RE.test(expectedRollbackSha256)) {
    throw new Error('BEATGALER_JSON_ROLLBACK_EXPORT_SHA256 must be 64 lowercase hex chars.');
  }
  if (expectedRollbackSha256 && !postgresEnabled) {
    throw new Error('Validated JSON rollback requires BEATGALER_POSTGRES_ENABLED=true for rollback marker verification.');
  }

  return Object.freeze({
    authority,
    postgresEnabled,
    expectedSnapshotSha256: authority === 'postgres' ? expectedSnapshotSha256 : '',
    expectedRollbackSha256: authority === 'json' ? expectedRollbackSha256 : '',
  });
}

module.exports = {
  SNAPSHOT_SHA_RE,
  controlPlaneAuthorityConfig,
  developmentEnvelopeKeyConfig,
};
