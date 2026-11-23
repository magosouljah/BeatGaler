'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { applyMigrations } = require('../../postgres-migrations');
const { hashPassword } = require('../../password-kdf');

const password = 'accounts-postgres-fixture-password';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const snapshot = sha256('accounts-postgres-test-snapshot');

function runnerDatabase() {
  // El runner comprueba bg_test_lab.lab_identity antes de crear esta base.
  const { DATABASE_URL: url, BEATGALER_TEST_PG_ALLOW: allow, BEATGALER_ALLOW_DESTRUCTIVE_PG_TEST: optedIn } = process.env;
  assert.ok(url && allow && optedIn === 'true', 'Ejecutar con scripts/run-cloud-tests.mjs --integration y su centinela.');
  const target = new URL(url);
  assert.match(target.protocol, /^postgres(?:ql)?:$/);
  assert.match(target.hostname, /^(?:127\.0\.0\.1|localhost|\[::1\])$/);
  const port = Number(target.port || 5432);
  assert.equal(`${target.hostname}:${port}`, allow, 'La base debe usar el destino verificado por el runner.');
  assert.ok(port !== 5432 || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'),
    'El puerto local 5432 está excluido.');
  assert.match(target.pathname, /^\/bgct_\d+_[a-z0-9]+_\d+$/);
  return { url, allow };
}

async function seedAccount(pool, name, number) {
  const account = { id: `usr_${name}`, email: `${name}@example.test`, installation: `install_${name}` };
  const salt = randomBytes(16).toString('hex');
  await pool.query(`INSERT INTO users(id,username,username_source,email,password_hash,password_hash_algorithm,password_salt)
    VALUES($1,$2,'beatgaler',$3,$4,'scrypt',$5)`, [account.id, `${name}#0001`, account.email, await hashPassword(password, salt), salt]);
  await pool.query(`INSERT INTO vaults(id,user_id,telegram_chat_id,title) VALUES($1,$2,$3,'Vault de prueba')`,
    [`vault_${name}`, account.id, `-1000000000${number}`]);
  return account;
}

async function withAccountsPostgres(exercise) {
  const { url, allow } = runnerDatabase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-accounts-pg-'));
  const pool = new Pool({ connectionString: url, ssl: false, max: 2, connectionTimeoutMillis: 5000 });
  const workers = [];

  async function start(name) {
    const stateDir = path.join(root, name);
    fs.mkdirSync(stateDir, { recursive: true });
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'TZ']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, {
      NODE_ENV: 'development', DATABASE_URL: url, BEATGALER_TEST_PG_ALLOW: allow, CATALOG_NET_POLICY: 'loopback',
      BEATGALER_POSTGRES_ENABLED: 'true', BEATGALER_POSTGRES_SSL_MODE: 'disable', BEATGALER_POSTGRES_POOL_MAX: '4',
      BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres', BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: snapshot,
      BEATGALER_SECRET_ENVELOPE_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
      BEATGALER_STATE_DIR: stateDir, BEATGALER_DIRECT_TRANSPORT: 'false',
      TRANSPORT_BOTS_FILE: path.join(stateDir, 'no-pool.json'), TRANSPORT_POOL_STATE: path.join(stateDir, 'pool-state.json'),
      MASTERS_FILE: path.join(stateDir, 'no-masters.json'), VAULT_REGISTRY_FILE: path.join(stateDir, 'vaults.json'),
      DIRECT_DIAGNOSTICS_DIR: path.join(stateDir, 'diag'),
      AWS_CONFIG_FILE: path.join(stateDir, 'no-aws-config'), AWS_SHARED_CREDENTIALS_FILE: path.join(stateDir, 'no-aws-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
    });
    const preloads = ['catalog-net-guard.cjs', 'no-dotenv.cjs', 'pg-port-guard.cjs'];
    const child = fork(path.join(__dirname, 'accounts-postgres.worker.cjs'), [], {
      execArgv: preloads.flatMap(file => ['--require', path.join(__dirname, file)]),
      env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    let output = '';
    const capture = chunk => { output = (output + chunk).slice(-4000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const closed = new Promise(resolve => child.once('close', resolve));
    async function stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    workers.push(stop);

    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Cloud ${name} no llegó a listen.\n${output}`)), 60_000);
      child.once('message', message => { clearTimeout(timer); resolve(message.port); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      void closed.then(code => { clearTimeout(timer); reject(new Error(`Cloud ${name} salió (${code}).\n${output}`)); });
    });
    assert.ok(Number.isInteger(port) && port > 0);

    return {
      stateDir,
      stop,
      mail() {
        const file = path.join(stateDir, 'mail.jsonl');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)) : [];
      },
      async post(route, body = {}, token, status = 200) {
        const res = await fetch(`http://127.0.0.1:${port}/auth/${route}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        });
        const data = await res.text();
        assert.equal(res.status, status, `${name} POST /auth/${route}: ${data}`);
        return JSON.parse(data);
      },
    };
  }

  try {
    await applyMigrations(pool);
    await pool.query(`INSERT INTO control_plane_cutovers(id,snapshot_sha256,state) VALUES('legacy-json-v1',$1,'READY')
      ON CONFLICT (id) DO NOTHING`, [snapshot]);
    await exercise({ pool, start });
  } finally {
    await Promise.all(workers.map(stop => stop()));
    try { await pool.end(); } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  }
}

function login(cloud, account, { email = account.email, secret = password, status = 200 } = {}) {
  return cloud.post('login', { email, password: secret, beatgalerUserId: account.installation }, undefined, status);
}

async function signIn(cloud, account, options) {
  const loginResult = await login(cloud, account, options);
  assert.equal(loginResult.user.id, account.id);
  assert.match(loginResult.token, /^[A-Za-z0-9_-]{43}$/);
  return loginResult.token;
}

async function sessionHashes(pool, account) {
  const { rows } = await pool.query('SELECT session_key_hash FROM auth_sessions WHERE user_id=$1 ORDER BY session_key_hash', [account.id]);
  return rows.map(row => row.session_key_hash);
}

module.exports = { login, password, seedAccount, sessionHashes, sha256, signIn, withAccountsPostgres };
