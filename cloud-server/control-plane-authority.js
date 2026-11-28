'use strict';

const { requiredEnv } = require('./runtime-env');
const { developmentEnvelopeKeyConfig } = require('./secret-envelope-provider');

const SNAPSHOT_SHA_RE = /^[0-9a-f]{64}$/;

// D17: PostgreSQL es la única autoridad del plano de control. `json` solo existe sin PostgreSQL configurado y fuera de
// producción (composición de pruebas y desarrollo local); con PostgreSQL la variable de autoridad es obligatoria.
function controlPlaneAuthorityConfig(env = requiredEnv()) {
  const postgresEnabled = String(env.BEATGALER_POSTGRES_ENABLED || '').toLowerCase() === 'true';
  if (!env.BEATGALER_CONTROL_PLANE_AUTHORITY && postgresEnabled) {
    throw new Error('BEATGALER_POSTGRES_ENABLED=true requires BEATGALER_CONTROL_PLANE_AUTHORITY=postgres (no default authority with PostgreSQL).');
  }
  const authority = String(env.BEATGALER_CONTROL_PLANE_AUTHORITY || 'json').trim().toLowerCase();
  if (!['json', 'postgres'].includes(authority)) {
    throw new Error('BEATGALER_CONTROL_PLANE_AUTHORITY must be json or postgres.');
  }

  const expectedSnapshotSha256 = String(env.BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256 || '').trim().toLowerCase();

  if (authority === 'json') {
    if (postgresEnabled) {
      throw new Error('JSON control-plane authority is not allowed with BEATGALER_POSTGRES_ENABLED=true; PostgreSQL is the only authority.');
    }
    if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
      throw new Error('JSON control-plane authority is forbidden with NODE_ENV=production.');
    }
  }

  if (authority === 'postgres') {
    if (!postgresEnabled) {
      throw new Error('PostgreSQL control-plane authority requires BEATGALER_POSTGRES_ENABLED=true.');
    }
    if (!SNAPSHOT_SHA_RE.test(expectedSnapshotSha256)) {
      throw new Error('PostgreSQL control-plane authority requires BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256 (64 lowercase hex chars).');
    }
  }

  return Object.freeze({
    authority,
    postgresEnabled,
    expectedSnapshotSha256: authority === 'postgres' ? expectedSnapshotSha256 : '',
  });
}

module.exports = {
  SNAPSHOT_SHA_RE,
  controlPlaneAuthorityConfig,
  developmentEnvelopeKeyConfig,
};
