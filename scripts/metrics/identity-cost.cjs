'use strict';
// M7.4-char: coste por petición autenticada del almacén de identidad (solo medición, sin PostgreSQL).
// Uso: node scripts/metrics/identity-cost.cjs [N1,N2,...] [iteraciones]
// Modos: json = accounts-data.json en disco; postgres-virtual = archivo virtual de control-plane-json-compat (sin disco).
// Cuenta cuántas veces se lee/analiza el almacén completo (fs.readFileSync sobre accounts-data.json) y mide ms/petición.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cloud = path.join(__dirname, '..', '..', 'cloud-server');
const { createSessionSecurityRuntime } = require(path.join(cloud, 'session-security'));
const { createAccountLifecycleRuntime } = require(path.join(cloud, 'account-lifecycle'));
const { installLegacyJsonCompatibility } = require(path.join(cloud, 'control-plane-json-compat'));
const { clone, authSnapshotDelta } = require(path.join(cloud, 'postgres-auth-multiprocess-compat'));

const sizes = (process.argv[2] || '10,1000,10000').split(',').map(Number);
const iterOverride = Number(process.argv[3] || 0);
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const now = 1_800_000_000_000;

function store(n) {
  const users = [];
  const sessions = {};
  for (let i = 0; i < n; i += 1) {
    users.push({ id: `usr_${i}`, username: `user${i}#0001`, usernameSource: 'beatgaler', email: `user${i}@example.test`,
      passwordSalt: 'a'.repeat(32), passwordHash: 'b'.repeat(128), createdAt: now - i, storageChatId: `-100${i}`,
      storageChatTitle: 'Vault', storageCreatedAt: now, providers: {}, plan: { id: 'free', state: 'active' } });
    sessions[sha(`token-${i}`)] = { userId: `usr_${i}`, createdAt: now - 10, expiresAt: now + 1e8 };
  }
  return { users, sessions };
}
function res() { return { statusCode: 200, body: null, setHeader() { return this; }, getHeader() {}, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } }; }
function pct(a, p) { return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }

function measure(mode, n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-identity-cost-'));
  const file = path.join(dir, 'accounts-data.json');
  const data = store(n);
  const raw = JSON.stringify(data, null, 2);
  const originalRead = fs.readFileSync;
  const saves = [];
  let uninstall = () => {};
  if (mode === 'json') fs.writeFileSync(file, raw);
  else uninstall = installLegacyJsonCompatibility({ fsModule: fs, authPath: file, persistentPath: path.join(dir, 'cloud-data.json'),
    runtime: { saveAuthSnapshot: s => saves.push(s), savePersistentSnapshot() {} }, initialAuth: data, initialPersistent: {} });
  let reads = 0; let bytes = 0;
  const counting = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    const out = counting.call(this, p, ...rest);
    if (path.resolve(String(p)) === path.resolve(file)) { reads += 1; bytes += out.length; }
    return out;
  };
  try {
    const sec = createSessionSecurityRuntime({ dataDir: dir, now: () => now });
    const life = createAccountLifecycleRuntime({ dataDir: dir, now: () => now });
    const token = `token-${Math.floor(n / 2)}`;
    const iters = iterOverride || (n >= 10000 ? 60 : n >= 1000 ? 300 : 1000);
    const req = () => ({ method: 'POST', path: '/auth/account', url: '/auth/account', headers: { host: 'x', authorization: `Bearer ${token}` }, body: {} });
    const timesSec = []; const timesAll = [];
    reads = 0; bytes = 0;
    for (let i = 0; i < iters; i += 1) {
      const r = req(); const t0 = process.hrtime.bigint();
      let ok = false; sec.requestMiddleware(r, res(), () => { ok = true; });
      timesSec.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (!ok) throw new Error('sesión rechazada en la medición');
      const t1 = process.hrtime.bigint();
      if (!life.api.session.sessionInfoFromRequest(r)) throw new Error('lifecycle rechazó la sesión');
      timesAll.push(timesSec[i] + Number(process.hrtime.bigint() - t1) / 1e6);
    }
    const readsPerRequest = reads / iters;
    const bytesPerRequest = Math.round(bytes / iters);
    timesSec.sort((a, b) => a - b); timesAll.sort((a, b) => a - b);
    // Camino de escritura (crear una sesión): serialize(indent 2) + parse + 2 clones + delta de filas (solo CPU, sin SQL).
    const wIters = Math.max(3, Math.floor(iters / 10)); const tw = [];
    for (let i = 0; i < wIters; i += 1) {
      const next = clone(data); next.sessions[sha(`new-${i}`)] = { userId: 'usr_0', createdAt: now, expiresAt: now + 1e8 };
      const t = process.hrtime.bigint();
      const text = JSON.stringify(next, null, 2); const parsed = JSON.parse(text);
      authSnapshotDelta(clone(data), clone(parsed));
      tw.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    tw.sort((a, b) => a - b);
    return { mode, n, bytes: raw.length, iters, readsPerRequest, bytesPerRequest,
      secMean: timesSec.reduce((a, b) => a + b, 0) / iters, secP95: pct(timesSec, 0.95),
      reqMean: timesAll.reduce((a, b) => a + b, 0) / iters, reqP95: pct(timesAll, 0.95), writeCpuMs: tw[Math.floor(tw.length / 2)] };
  } finally {
    fs.readFileSync = originalRead; uninstall(); fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('modo\tN\tKB\tlecturas_completas/petición\tKB_analizados/petición\tseguridad_ms(media/p95)\tpetición_ms(sec+lifecycle, media/p95)\tescritura_CPU_ms(mediana)');
for (const n of sizes) for (const mode of ['json', 'postgres-virtual']) {
  const m = measure(mode, n);
  console.log([m.mode, m.n, (m.bytes / 1024).toFixed(0), m.readsPerRequest, (m.bytesPerRequest / 1024).toFixed(0),
    `${m.secMean.toFixed(3)}/${m.secP95.toFixed(3)}`, `${m.reqMean.toFixed(3)}/${m.reqP95.toFixed(3)}`, m.writeCpuMs.toFixed(1)].join('\t'));
}
