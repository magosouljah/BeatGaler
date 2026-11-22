'use strict';
// Caracterización del arranque real de cloud-server/server.js (M4.1a): lanza `node cloud-server/server.js` en un proceso hijo con
// un entorno por allowlist y guard de red, y devuelve cómo terminó el arranque (falló con qué mensaje, o llegó a listen).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findLocalSecretFiles } = require('./local-secret-files.cjs');

const cloudDir = path.resolve(__dirname, '../..');
const root = path.dirname(cloudDir);
const helpers = __dirname;
const PASS_THROUGH = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'TZ', 'CI', 'GITHUB_ACTIONS'];

// env: variables del Cloud a fijar (clave undefined = ausente). pgAllow: "host:puerto" de la instancia efímera verificada.
async function bootCloud(env = {}, { timeoutMs = 60_000, pgAllow = '' } = {}) {
  if (findLocalSecretFiles(root).length) throw new Error('El arranque de prueba requiere un worktree limpio.');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-boot-gates-'));
  const child_env = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) child_env[k] = process.env[k];
  Object.assign(child_env, {
    TEMP: stateDir, TMP: stateDir,
    NODE_ENV: 'development',
    BEATGALER_CONTROL_PLANE_AUTHORITY: 'json',
    BEATGALER_POSTGRES_ENABLED: 'false',
    BEATGALER_STATE_DIR: stateDir,
    BEATGALER_DIRECT_TRANSPORT: 'false',
    TRANSPORT_BOTS_FILE: path.join(stateDir, 'no-pool.json'),
    TRANSPORT_POOL_STATE: path.join(stateDir, 'pool-state.json'),
    MASTERS_FILE: path.join(stateDir, 'no-masters.json'),
    VAULT_REGISTRY_FILE: path.join(stateDir, 'vaults.json'),
    DIRECT_DIAGNOSTICS_DIR: path.join(stateDir, 'diag'),
    AWS_CONFIG_FILE: path.join(stateDir, 'no-aws-config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(stateDir, 'no-aws-credentials'),
    AWS_EC2_METADATA_DISABLED: 'true',
    BEATGALER_CATALOG_DIRECT_PREWARM_BOTS: '0',
    CATALOG_NET_POLICY: 'loopback',
    BEATGALER_TEST_PG_ALLOW: pgAllow,
  });
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete child_env[k]; else child_env[k] = String(v); }
  const preloads = ['catalog-net-guard.cjs', 'no-dotenv.cjs', 'pg-port-guard.cjs', 'boot-gates-preload.cjs'];
  const args = [...preloads.flatMap((f) => ['--require', path.join(helpers, f)]), path.join(cloudDir, 'server.js')];
  let output = '';
  let listening = false;
  let startupFailed = false;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: child_env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`El arranque no terminó en ${timeoutMs} ms.\n${output.slice(-2000)}`)); }, timeoutMs);
      const settle = (code) => { clearTimeout(timer); resolve(code); };
      const onData = (chunk) => {
        output += chunk.toString('utf8');
        if (!listening && output.includes('BOOT_GATES_LISTENING')) { listening = true; child.kill(); }
        if (!startupFailed && output.includes('startup failed; cloud-server will not start')) { startupFailed = true; setTimeout(() => child.kill(), 500).unref(); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => settle(code));
    });
    const failure = /\[control-plane\] startup failed; cloud-server will not start: (.*)/.exec(output);
    const catalogLine = (/^\[catalog\] native=.*$/m.exec(output) || [null])[0];
    return { exitCode, listening, startupFailed, failureMessage: failure ? failure[1].trim() : null, catalogLine, output };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

module.exports = { bootCloud };
