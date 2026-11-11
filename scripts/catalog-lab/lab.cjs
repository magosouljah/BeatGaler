'use strict';
// LAB navegador: orquestador. Uso: node scripts/catalog-lab/lab.cjs <up|down|status|detect> [--no-legacy] [--keep-pg] [--seed N]
//   up     PG efímero propio (WSL) → bootstrap → Cloud real + gateway fake + siembra → Vite (POSTGRES y LEGACY) → espera siembra
//   down   mata Cloud/Vite, borra la DB/rol del LAB y detiene+borra el clúster WSL (salvo --keep-pg)
//   status procesos, puertos y estado de siembra
//   detect navegadores disponibles (Chrome / Edge)
// Solo loopback, solo LAB. Nunca lee .env: el Cloud arranca con cwd = state dir que contiene un .env VACÍO.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const L = require('./lab-env.cjs');

const cmd = process.argv[2];
const flag = (f) => process.argv.includes(f);
const argVal = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
if (argVal('--seed')) process.env.LAB_SEED_N = argVal('--seed');
const L2 = argVal('--seed') ? (delete require.cache[require.resolve('./lab-env.cjs')], require('./lab-env.cjs')) : L;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[lab]', ...a);

function wsl(script, args, { timeout = 180000 } = {}) {
  const r = spawnSync('wsl', ['-d', L2.WSL_DISTRO, '-u', 'root', '--', 'bash', L2.toWsl(path.join(__dirname, script)), ...args], { encoding: 'utf8', timeout });
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\u0000/g, '').trim();
  if (out) console.log(out.split('\n').map((l) => `  wsl> ${l}`).join('\n'));
  if (r.status !== 0) throw new Error(`wsl ${script} falló (status ${r.status})`);
}
const tcpUp = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
const httpOk = (port, p = '/') => new Promise((res) => { const q = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, (r) => { r.resume(); res(r.statusCode < 500); }); q.on('error', () => res(false)); q.on('timeout', () => { q.destroy(); res(false); }); });
async function waitFor(fn, timeoutMs, msg) { const t = Date.now(); while (Date.now() - t < timeoutMs) { if (await fn()) return; await sleep(500); } throw new Error(`timeout esperando ${msg}`); }
const pidFile = (n) => L2.statePath(`${n}.pid`);
function killPid(name) {
  const f = pidFile(name); if (!fs.existsSync(f)) return;
  const pid = fs.readFileSync(f, 'utf8').trim();
  const r = spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { encoding: 'utf8' });
  log(`${name} pid=${pid}`, (r.stdout || r.stderr || '').trim().split('\n')[0]);
  fs.unlinkSync(f);
}

async function up() {
  fs.mkdirSync(L2.STATE_DIR, { recursive: true });
  if (fs.existsSync(L2.CFG_FILE)) throw new Error('Ya hay un LAB levantado (lab.env.json existe). Ejecuta `down` primero.');
  for (const p of [L2.PORTS.cloud, L2.PORTS.webPostgres, L2.PORTS.webLegacy]) if (await tcpUp(p)) throw new Error(`puerto ${p} ocupado`);
  log(`PG efímero propio :${L2.PORTS.pg} (${L2.PG_DIR})`);
  wsl('pg-start.sh', [String(L2.PORTS.pg), L2.PG_DIR]);
  log('bootstrap DB/usuarios');
  const b = spawnSync(process.execPath, [path.join(__dirname, 'lab-bootstrap.cjs')], { encoding: 'utf8', env: { ...process.env, LAB_SEED_N: String(L2.SEED_N) }, timeout: 180000 });
  console.log((b.stdout || '').trim()); if (b.status !== 0) { console.error(b.stderr); throw new Error('bootstrap falló'); }
  const cfg = JSON.parse(fs.readFileSync(L2.CFG_FILE, 'utf8'));
  // Cloud real: cwd con .env VACÍO → dotenv jamás lee cloud-server/.env. Entorno mínimo y explícito.
  fs.writeFileSync(L2.statePath('.env'), '');
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, ...cfg.env, DATABASE_URL: cfg.databaseUrl, LAB_STATE_DIR: L2.STATE_DIR, LAB_SEED_N: String(cfg.seedN), ...(process.env.LAB_SYNTH_AUDIO ? { LAB_SYNTH_AUDIO: process.env.LAB_SYNTH_AUDIO } : {}) };
  const cloudLog = L2.statePath('cloud.log'); fs.writeFileSync(cloudLog, '');
  const cl = fs.openSync(cloudLog, 'a');
  const cloud = spawn(process.execPath, ['--require', path.join(__dirname, 'lab-preload.cjs'), path.join(L2.ROOT, 'cloud-server', 'server.js')], { cwd: L2.STATE_DIR, env, stdio: ['ignore', cl, cl], detached: true, windowsHide: true });
  fs.writeFileSync(pidFile('cloud'), String(cloud.pid)); cloud.unref();
  log(`Cloud pid=${cloud.pid} :${L2.PORTS.cloud} log=${cloudLog}`);
  const cloudUrl = `http://127.0.0.1:${L2.PORTS.cloud}`;
  const startVite = (name, port, apiFlag) => {
    const lf = fs.openSync(L2.statePath(`web-${port}.log`), 'w');
    const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'web', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: L2.ROOT, env: { ...process.env, STAGE1_CLOUD_URL: cloudUrl, VITE_CATALOG_API_ENABLED: apiFlag ? 'true' : 'false' }, stdio: ['ignore', lf, lf], detached: true, windowsHide: true });
    fs.writeFileSync(pidFile(name), String(child.pid)); child.unref();
    log(`Vite ${name} pid=${child.pid} :${port} catalogApi=${apiFlag}`);
  };
  startVite('web-postgres', L2.PORTS.webPostgres, true);
  if (!flag('--no-legacy')) startVite('web-legacy', L2.PORTS.webLegacy, false);
  const seedTimeout = Math.max(240000, cfg.seedN * 4000);
  await waitFor(() => { const t = fs.readFileSync(cloudLog, 'utf8'); if (/\[lab\] seed failed|commit not committed|EADDRINUSE|startup failed/.test(t)) throw new Error('Cloud/seed falló: ver ' + cloudLog); return /\[lab\] (seed done|library already seeded)/.test(t); }, seedTimeout, 'siembra del Cloud');
  await waitFor(() => { if (/startup failed|cloud-server will not start/.test(fs.readFileSync(cloudLog, 'utf8'))) throw new Error('Cloud no arrancó: ver ' + cloudLog); return tcpUp(L2.PORTS.cloud); }, 60000, 'Cloud escuchando');
  await waitFor(() => httpOk(L2.PORTS.webPostgres, '/gallery'), 180000, 'Vite POSTGRES');
  if (!flag('--no-legacy')) await waitFor(() => httpOk(L2.PORTS.webLegacy, '/gallery'), 180000, 'Vite LEGACY');
  log(`LAB listo: POSTGRES http://127.0.0.1:${L2.PORTS.webPostgres}  ${flag('--no-legacy') ? '(sin LEGACY)' : `LEGACY http://127.0.0.1:${L2.PORTS.webLegacy}`}  beats=${cfg.seedN}`);
}

async function down() {
  for (const n of ['web-legacy', 'web-postgres', 'cloud']) killPid(n);
  if (fs.existsSync(L2.CFG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(L2.CFG_FILE, 'utf8'));
    try { await require('./lab-bootstrap.cjs').dropDb(cfg.db); log('DB/rol del LAB eliminados', cfg.db.database); } catch (e) { log('dropDb:', e.message); }
    fs.unlinkSync(L2.CFG_FILE);
  }
  if (!flag('--keep-pg')) { try { wsl('pg-stop.sh', [L2.PG_DIR], { timeout: 90000 }); } catch (e) { log('pg-stop:', e.message); } }
  log('LAB detenido');
}

async function status() {
  const cfgOk = fs.existsSync(L2.CFG_FILE);
  const rows = {};
  for (const [k, p] of Object.entries(L2.PORTS)) rows[k] = { port: p, listening: await tcpUp(p) };
  const t = fs.existsSync(L2.statePath('cloud.log')) ? fs.readFileSync(L2.statePath('cloud.log'), 'utf8') : '';
  console.log(JSON.stringify({ configured: cfgOk, ports: rows, seeded: /\[lab\] (seed done|library already seeded)/.test(t), seedFailed: /\[lab\] seed failed/.test(t) }, null, 2));
}

function detect() {
  const prog = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const find = (rels) => { for (const b of prog) for (const r of rels) { const p = path.join(b, r); if (fs.existsSync(p)) return p; } return null; };
  const out = { chrome: find(['Google/Chrome/Application/chrome.exe']), edge: find(['Microsoft/Edge/Application/msedge.exe']) };
  console.log(JSON.stringify(out, null, 2)); return out;
}

({ up, down, status, detect }[cmd] || (async () => { console.error('uso: lab.cjs <up|down|status|detect> [--no-legacy] [--keep-pg] [--seed N]'); process.exit(2); }))()
  .catch((e) => { console.error('[lab] ERROR', e.message); process.exit(1); });
