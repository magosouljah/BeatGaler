'use strict';
// LAB navegador: base PostgreSQL EFÍMERA en el clúster propio del LAB (127.0.0.1:LAB_PG_PORT), migraciones reales, cutover vacío verificado
// (control-plane postgres), bot fake 'Bot20', activación nativa 'v09-lab', usuario A (con biblioteca provisionada) y usuario B (vault
// elegible sin provisionar, para C12-V-AUTH). Escribe lab.env.json (credenciales ALEATORIAS del LAB, en tmp/, nunca versionado).
// No toca el clúster 18/main, Telegram, AWS ni datos reales.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./lab-env.cjs');
const R = path.join(L.ROOT, 'cloud-server') + '/';
const { Pool, Client } = require(R + 'node_modules/pg');
const { applyMigrations } = require(R + 'postgres-migrations');
const { stagePostgresCutover, commitStagedPostgresCutover } = require(R + 'postgres-cutover-preparation');
const { normalizeSecretKeyring } = require(R + 'secret-keyring');
const { developmentEnvelopeKeyConfig } = require(R + 'secret-envelope-provider');
const { hashPassword } = require(R + 'password-kdf');
const { deterministicId } = require(R + 'legacy-import-executor');
const authority = require(R + 'catalog/authority');

const ADMIN = { host: '127.0.0.1', port: L.PORTS.pg, user: 'catalog_lab_admin', database: 'catalog_lab_sentinel' };
async function withAdmin(fn) { const c = new Client(ADMIN); await c.connect(); try { return await fn(c); } finally { await c.end().catch(() => {}); } }

async function createDb() {
  const hex = crypto.randomBytes(6).toString('hex');
  const name = `lab_br_${hex}`; const role = `lab_role_${hex}`; const password = crypto.randomBytes(12).toString('hex');
  await withAdmin(async (c) => {
    // identidad del clúster: solo el sentinel del LAB
    const id = await c.query('SELECT instance_id FROM catalog_lab.lab_identity');
    if (id.rowCount !== 1) throw new Error('LAB: sentinel ausente; no es el clúster del LAB');
    await c.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await c.query(`CREATE DATABASE "${name}" OWNER "${role}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`);
  });
  return { host: ADMIN.host, port: ADMIN.port, user: role, password, database: name };
}

async function dropDb(config) {
  await withAdmin(async (c) => { await c.query(`DROP DATABASE IF EXISTS "${config.database}" WITH (FORCE)`); await c.query(`DROP ROLE IF EXISTS "${config.user}"`); });
}

async function main() {
  fs.mkdirSync(L.STATE_DIR, { recursive: true });
  if (fs.existsSync(L.CFG_FILE)) throw new Error('lab.env.json ya existe: ejecuta `node scripts/catalog-lab/lab.cjs down` antes de volver a arrancar.');
  const dbConfig = await createDb();
  const envelopeKey = crypto.randomBytes(32).toString('base64');
  const env = { NODE_ENV: 'development', BEATGALER_DEPLOYMENT_ENV: 'test', BEATGALER_SECRET_ENVELOPE_KEY_B64: envelopeKey, BEATGALER_SECRET_ENVELOPE_KEY_VERSION: '1' };
  const pool = new Pool({ ...dbConfig, max: 4 });
  try {
    await applyMigrations(pool);
    const cryptoConfig = normalizeSecretKeyring(developmentEnvelopeKeyConfig(env));
    const authRaw = '{"users":[],"sessions":{}}\n';
    const persistentRaw = '{"linkedAccounts":{},"uploadedFiles":{},"beatTopics":{},"pendingTopicDeletes":{},"messageRedirects":{}}\n';
    const staged = await stagePostgresCutover(pool, { authRaw, persistentRaw, cryptoConfig, externalBundleSha256: null });
    await commitStagedPostgresCutover(pool, { expectedSnapshotSha256: staged.snapshot.manifest_sha256, currentAuthRaw: authRaw, currentPersistentRaw: persistentRaw });
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    const manifestSha = crypto.createHash('sha256').update('v09-lab-activation').digest('hex');
    await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory)
      VALUES ('v09-lab', 'v09-run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[{"id":"none","stopped":true}]')`, [manifestSha]);
    const mkUser = async (prefix) => {
      const userId = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
      const password = `V09-${crypto.randomBytes(9).toString('base64url')}`;
      const salt = crypto.randomBytes(16).toString('hex');
      await pool.query(`INSERT INTO users(id, username, username_source, email, password_hash, password_hash_algorithm, password_salt, created_at, updated_at)
        VALUES ($1, $2, 'user', $3, $4, 'scrypt-v1', $5, now(), now())`, [userId, userId.replace(/[^a-z0-9]/gi, '').slice(0, 20), `${userId}@example.test`, await hashPassword(password, salt), salt]);
      return { userId, email: `${userId}@example.test`, password };
    };
    // Vaults insertados tras la activación → elegibles por trigger.
    const A = await mkUser('v09u'); const chatId = '-1009000000001';
    const vaultId = deterministicId('vlt', A.userId, chatId);
    await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id, index_bootstrap_pending) VALUES ($1, $2, $3, 'Bot20', true)", [vaultId, A.userId, chatId]);
    const a = authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
    const ctx = (await a.provisionLibrary({ userId: A.userId })).context;
    const B = await mkUser('v09b'); const chatB = '-1009000000002';
    await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id, index_bootstrap_pending) VALUES ($1, $2, $3, 'Bot20', true)", [deterministicId('vlt', B.userId, chatB), B.userId, chatB]);
    // Un vault sin catálogo provisionado hace que el Cloud intente el control-plane legacy y aborte sin credenciales de Telegram
    // ("Missing TELEGRAM_API_ID"): TODOS los vaults del LAB deben provisionarse (B queda con biblioteca vacía → "Empty Gallery").
    B.context = (await a.provisionLibrary({ userId: B.userId })).context;
    const diag = path.join(L.STATE_DIR, 'diagnostics'); const tmpUp = path.join(L.STATE_DIR, 'uploads-tmp');
    fs.mkdirSync(diag, { recursive: true }); fs.mkdirSync(tmpUp, { recursive: true });
    const out = {
      ports: L.PORTS, seedN: L.SEED_N, db: dbConfig,
      databaseUrl: `postgresql://${encodeURIComponent(dbConfig.user)}:${encodeURIComponent(dbConfig.password)}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`,
      env: { ...env, BEATGALER_POSTGRES_ENABLED: 'true', BEATGALER_POSTGRES_SSL_MODE: 'disable', BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres', BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: staged.snapshot.manifest_sha256,
        BILLING_PROVIDER_ENVIRONMENT: 'sandbox', PORT: String(L.PORTS.cloud), BEATGALER_DIRECT_TRANSPORT: 'false', BEATGALER_DIRECT_REQUIRED: 'false', BEATGALER_PUBLIC_REGISTRATION: '0', BEATGALER_PENDING_SIGNUP_ENABLED: '0',
        BEATGALER_CATALOG_NATIVE_ENABLED: 'true', DIRECT_DIAGNOSTICS_DIR: diag.replace(/\\/g, '/'), BEATGALER_PROJECT_UPLOAD_TEMP_DIR: tmpUp.replace(/\\/g, '/') + '/' },
      account: { ...A, vaultId, chatId, context: ctx }, accountB: B,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(L.CFG_FILE, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ db: dbConfig.database, userId: A.userId, userB: B.userId, era: ctx.authority_era, epoch: ctx.authority_epoch, cutover: staged.snapshot.manifest_sha256.slice(0, 12) }));
  } catch (e) {
    await pool.end().catch(() => {});
    await dropDb(dbConfig).catch(() => {});
    throw e;
  }
  await pool.end();
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { dropDb };
