'use strict';

// M7.5b-FC (fallo cerrado del contexto de arranque), prueba (b): el server.js REAL con NODE_ENV=production y autoridad
// PostgreSQL EFÍMERA (solo `node scripts/run-cloud-tests.mjs --integration`) prepara el contexto, arranca hasta listen
// sin el aviso de contexto ausente y monta exactamente la misma pila Express que el mismo arranque fuera de producción.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { bootCloud } = require('./helpers/boot-gates.cjs');

const { Pool } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const { applyMigrations } = require('../postgres-migrations');

const DATABASE_URL = process.env.DATABASE_URL || '';
const PG_ALLOW = process.env.BEATGALER_TEST_PG_ALLOW || '';
assert.ok(DATABASE_URL && PG_ALLOW, 'Requiere la base efímera del runner (DATABASE_URL y BEATGALER_TEST_PG_ALLOW).');
assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(DATABASE_URL).hostname), 'Solo PostgreSQL efímero en loopback.');

const SNAPSHOT = crypto.createHash('sha256').update('cloud-boot-production-snapshot').digest('hex');
const PG_ENV = {
  BEATGALER_POSTGRES_ENABLED: 'true',
  DATABASE_URL,
  BEATGALER_POSTGRES_SSL_MODE: 'disable',
  BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
  BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: SNAPSHOT,
  BEATGALER_SECRET_ENVELOPE_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
};
// El llavero de sobres de producción viene de AWS Secrets Manager: lo sirve un doble local (fake-aws-secrets-preload).
const PRODUCTION = {
  NODE_ENV: 'production', BEATGALER_DEPLOYMENT_ENV: 'production', BEATGALER_SOURCE_SHA: 'a'.repeat(40),
  BEATGALER_SECRET_ENVELOPE_PROVIDER: 'aws-secrets-manager', BEATGALER_SECRET_ENVELOPE_KEY_B64: undefined,
  BEATGALER_AWS_SECRET_ENVELOPE_ID: 'fake-envelope', AWS_REGION: 'us-east-2',
  BEATGALER_SES_REGION: 'us-east-2', BEATGALER_SES_FROM_EMAIL: 'no-reply@example.test',
};
const MISSING_BOOT = '[boot] server-core sin contexto de arranque';
const boot = (env) => bootCloud({ ...PG_ENV, ...env }, {
  pgAllow: PG_ALLOW, timeoutMs: 90_000, preloads: ['fake-aws-secrets-preload.cjs', 'boot-stack-preload.cjs'],
});

test.before(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, ssl: false });
  try {
    await applyMigrations(pool);
    await pool.query(`INSERT INTO control_plane_cutovers(id, snapshot_sha256, state) VALUES ('legacy-json-v1', $1, 'READY')
      ON CONFLICT (id) DO UPDATE SET snapshot_sha256 = EXCLUDED.snapshot_sha256, state = 'READY'`, [SNAPSHOT]);
  } finally { await pool.end(); }
});

test('(b) NODE_ENV=production: server.js real prepara el contexto, arranca y la pila es idéntica a la de fuera de producción', async () => {
  const production = await boot(PRODUCTION);
  assert.equal(production.failureMessage, null, production.output.slice(-1500));
  assert.equal(production.listening, true, production.output.slice(-1500));
  assert.ok(!production.output.includes(MISSING_BOOT), production.output.slice(-1500));
  assert.ok(!production.output.includes('STOP: '), production.output.slice(-1500));
  const development = await boot({ NODE_ENV: 'development' });
  assert.equal(development.listening, true, development.output.slice(-1500));
  assert.ok(Array.isArray(production.stack) && production.stack.length > 20, 'firma de la pila ausente');
  assert.deepEqual(production.stack, development.stack);
});
