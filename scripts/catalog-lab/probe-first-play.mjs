// Primer play en frío y en caliente + línea de tiempo del precalentamiento del login (LAB con dobles: Cloud real + gateway Telegram FAKE
// + PostgreSQL efímero; NO es latencia real de Telegram ni build de producción: Vite dev). Receta en README (sección «Primer play»).
// Mide, por repetición: (1) instante (ms) de creación de cada Worker, de cada WebSocket del hilo principal, de la primera petición al doble
// /lab-telegram y de las peticiones a /catalog/v1/direct, relativos al envío del login (frío) o a la carga de la página (caliente);
// qué módulos se cargaron antes del clic en play; (2) ms desde el clic en play hasta que currentTime avanza.
// FRÍO = perfil de Chrome nuevo (caché HTTP e IndexedDB vacías) + login + Gallery + clic. CALIENTE = mismo perfil ya usado, recarga de la página
// con la sesión recordada (sin login), mismo beat. Salida: STEP/RUN por repetición, tabla final y JSON crudo en <out>/first-play/.
// Variables: FP_COLD (6), FP_HOT (8), FP_SETTLE_MS (2000: espera entre «Gallery lista» y el clic), FP_PLAY_SELECTOR (solo para la mutación del README),
// FP_PLAY_TIMEOUT_MS (40000), SMOKE_CHROME / SMOKE_CHROMEDRIVER (como probe-smoke-v1).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { parseArgs, createRun, loadLab, sleep } from './browser-common.mjs';

const args = parseArgs();
const abort = (why) => { console.log('RUN 0-PREFLIGHT FAIL ' + why); console.log('FIRST-PLAY FAIL (LAB con dobles) fallos: 0-PREFLIGHT'); process.exit(1); };
// 0) Aislamiento: solo contra el LAB con gateway Telegram FAKE (nunca proveedor real). Antes de abrir navegador.
let lab;
{
  try { lab = loadLab(); } catch (e) { abort(String(e.message)); }
  const logFile = lab.L.statePath('cloud.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  if (!log.includes('[lab] preload active: Telegram FAKE')) abort('cloud.log sin «[lab] preload active: Telegram FAKE» (lab-preload.cjs): no se mide contra un LAB sin doble confirmado');
  const fakePort = lab.cfg.ports.cloud + 5;
  const up = await new Promise((res) => { const sk = net.connect(fakePort, '127.0.0.1'); sk.once('connect', () => { sk.destroy(); res(true); }); sk.once('error', () => res(false)); });
  if (!up) abort(`doble /lab-telegram no escucha en 127.0.0.1:${fakePort}`);
  if (/real-preload|gateway=REAL/i.test(log) || log.includes('[real]')) abort('cloud.log indica gateway/proveedor real: abortado');
}
// 0b) Chrome y ChromeDriver locales ya instalados; nunca se descarga nada.
const findFirst = (c) => c.filter(Boolean).find((p) => fs.existsSync(p)) || null;
const tmpBase = process.env.TEMP || process.env.TMP || '';
const cached = (() => { try { const d = path.join(tmpBase, 'chromedriver'); return fs.readdirSync(d).map((v) => path.join(d, v, 'chromedriver-win64', 'chromedriver.exe')); } catch { return []; } })();
args.chromedriver = findFirst([process.env.SMOKE_CHROMEDRIVER, ...cached]);
args.chromeBinary = findFirst([process.env.SMOKE_CHROME, ...[process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'))]);
if (!args.chromedriver) abort('ChromeDriver local no encontrado: fija SMOKE_CHROMEDRIVER=<ruta a chromedriver.exe> (no se descarga nada)');
if (!args.chromeBinary) abort('Chrome local no encontrado: fija SMOKE_CHROME=<ruta a chrome.exe>');

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const N_COLD = num(process.env.FP_COLD, 6);
const N_HOT = num(process.env.FP_HOT, 8);
const SETTLE = num(process.env.FP_SETTLE_MS, 2000);
const PLAY_TIMEOUT = num(process.env.FP_PLAY_TIMEOUT_MS, 40000);
const PLAY_SELECTOR = process.env.FP_PLAY_SELECTOR || '[data-beat-artwork-id]';
args.out = path.join(lab.L.DEFAULT_OUT, 'first-play');
fs.mkdirSync(args.out, { recursive: true });
const POSTGRES = lab.POSTGRES;
const account = lab.cfg.account;

// Instrumentación previa a cualquier script de la página (BiDi preload). No toca fetch ni el CSRF: solo observa Worker/WebSocket, los clics y
// currentTime del <audio> capturado por createRun (window.__v09Audio). Las peticiones salen del Resource Timing (buffer ampliado).
const PRELOAD = `() => {
  if (window.__fp) return;
  const now = () => Date.now();
  const fp = window.__fp = { origin: performance.timeOrigin, workers: [], ws: [], submit: null, loginDone: null, cards: null, click: null, playing: null };
  try { performance.setResourceTimingBufferSize(20000); } catch (e) {}
  const OW = window.Worker;
  if (OW) { const W = function (u, o) { fp.workers.push({ t: now(), url: String(u), type: (o && o.type) || null }); return new OW(u, o); }; W.prototype = OW.prototype; window.Worker = W; }
  const OS = window.WebSocket;
  if (OS) { const S = function (u, p) { fp.ws.push({ t: now(), url: String(u).replace(/[?#].*$/, '') }); return p === undefined ? new OS(u) : new OS(u, p); }; S.prototype = OS.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) S[k] = OS[k]; window.WebSocket = S; }
  try { document.addEventListener('click', (e) => { const t = e.target; if (!t || !t.closest) return; if (t.closest('.bg-auth-form button[type="submit"]')) { if (!fp.submit) fp.submit = now(); } else if (t.closest(${JSON.stringify(PLAY_SELECTOR)}) && fp.click === null) fp.click = now(); }, true); } catch (e) {}
  setInterval(() => {
    if (fp.submit && !fp.loginDone && !document.querySelector('#auth-login-identifier')) fp.loginDone = now();
    if (!fp.cards && document.querySelector('[data-beat-card-id]')) fp.cards = now();
    const a = window.__v09Audio;
    if (fp.click && !fp.playing && a && !a.paused && a.currentTime > 0.05) fp.playing = now();
  }, 4);
}`;

const KEY = /(webTransport\.worker|webTransportWorkerClient|webGalerCloudTransport|webStartupPlaybackCoordinator|webRememberedDirectPreconnect|webTempAuth|mtcute|catalogDirect|catalogLabDirectPort|AccountGate|AuthExperienceGate)/i;
const isModule = (u) => /\.(m?[jt]sx?)(\?|$)/.test(u.replace(/^https?:\/\/[^/]+/, '')) || /\/node_modules\/\.vite\//.test(u) || /\/@(fs|id|vite)\//.test(u);
const short = (u) => u.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '');
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const p90 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)]; };
const rmProfile = async (kind) => {
  const dir = path.join(lab.L.STATE_DIR, `${kind}-chrome-profile`);
  if (!dir.startsWith(lab.L.STATE_DIR)) return;
  for (let i = 0; i < 8; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(500); } }
};

async function collect(R, base) {
  const raw = await R.ex(() => ({ fp: window.__fp, res: performance.getEntriesByType('resource').map((e) => ({ n: e.name, t: Math.round(performance.timeOrigin + e.startTime), i: e.initiatorType })), href: location.href }));
  const fp = raw.fp; const res = raw.res;
  const rel = (t) => (t == null ? null : t - base);
  const click = fp.click;
  const before = res.filter((r) => click == null || r.t <= click);
  const mods = before.filter((r) => isModule(r.n));
  const keyMods = mods.filter((r) => KEY.test(r.n)).map((r) => ({ at: rel(r.t), url: short(r.n) }));
  const tg = res.filter((r) => r.n.includes('/lab-telegram/'));
  const direct = res.filter((r) => r.n.includes('/catalog/v1/direct'));
  const tgAfter = tg.find((r) => click != null && r.t >= click);
  const wsRes = res.filter((r) => /^wss?:/.test(r.n));
  return {
    base, submit: fp.submit, loginDone: fp.loginDone, pageStart: Math.round(fp.origin), cards: fp.cards, click, playing: fp.playing,
    playMs: click != null && fp.playing != null ? fp.playing - click : null,
    cardsMs: fp.cards != null ? fp.cards - base : null,
    workers: fp.workers.map((w) => ({ at: rel(w.t), url: short(w.url), type: w.type })),
    websocketsMainThread: fp.ws.map((w) => ({ at: rel(w.t), url: w.url })),
    firstLabTelegramRequestAt: tg.length ? rel(Math.min(...tg.map((r) => r.t))) : null,
    firstLabTelegramReadAfterClickMs: tgAfter ? tgAfter.t - click : null,
    directSessionRequestsAt: direct.map((r) => rel(r.t)),
    wsResourceEntries: wsRes.length,
    modulesBeforePlay: mods.length, resourcesBeforePlay: before.length,
    keyModulesBeforePlay: keyMods.slice(0, 60),
    keyModulesTruncated: Math.max(0, keyMods.length - 60),
    externalHosts: [...new Set(res.map((r) => { try { return new URL(r.n).host; } catch { return ''; } }).filter((h) => h && !/^127\.0\.0\.1:/.test(h)))],
  };
}

const waitForTrue = async (fn, timeout, msg) => { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > timeout) throw new Error('timeout: ' + msg); await sleep(25); } };
const galleryReady = (R) => waitForTrue(async () => { const g = await R.galleryState(); return g.mode === 'postgres' && g.storeStatus !== 'loading' && g.cards > 0 ? g : null; }, 90000, 'gallery con tarjetas');

async function playOnce(R, base, cardId) {
  await sleep(SETTLE);
  const id = cardId || (await R.ex(() => document.querySelector('[data-beat-card-id]')?.getAttribute('data-beat-card-id')));
  if (!id) throw new Error('sin tarjeta');
  await (await R.browser.$(`[data-beat-card-id="${id}"] ${PLAY_SELECTOR}`)).click();
  await waitForTrue(() => R.ex(() => window.__fp.playing != null && !window.__v09Audio?.error), PLAY_TIMEOUT, 'currentTime avanza tras play');
  const a1 = (await R.audioState())[0]; await sleep(1200); const a2 = (await R.audioState())[0];
  if (!(a2 && a1 && a2.t > a1.t + 0.5)) throw new Error(`currentTime no avanza (${a1 && a1.t} -> ${a2 && a2.t})`);
  const data = await collect(R, base);
  await R.ex(() => { window.__v09Audio?.pause(); });
  return { id, data };
}

const runs = []; const failures = [];
const note = (r) => { runs.push(r); console.log('RUN ' + JSON.stringify({ id: r.id, status: r.status, playMs: r.data?.playMs ?? null, workers: r.data?.workers?.length ?? null, why: r.why })); };

async function coldRun(i) {
  const kind = `first-play-cold-${i}`; const id = `cold-${i}`;
  await rmProfile(kind);
  const R = await createRun({ kind, args });
  if (!R) { failures.push(id); note({ id, status: 'FAIL', why: 'no se pudo abrir Chrome' }); return; }
  try {
    await R.browser.scriptAddPreloadScript({ functionDeclaration: PRELOAD });
    await R.browser.url(POSTGRES + '/gallery');
    await waitForTrue(async () => (await R.browser.$('#auth-login-identifier').isExisting()) || null, 90000, 'formulario de login');
    await R.browser.$('#auth-login-identifier').setValue(account.email);
    await R.browser.$('#auth-login-password').setValue(account.password);
    await R.browser.$('.bg-auth-form button[type="submit"]').click();
    await waitForTrue(() => R.ex(() => window.__fp.loginDone != null), 60000, 'login confirmado');
    await galleryReady(R);
    await R.installAudioCapture();
    const submit = await R.ex(() => window.__fp.submit);
    const { data } = await playOnce(R, submit);
    // Segunda base: instante del login confirmado (D7: «ms desde el login confirmado»).
    const loginDone = data.loginDone;
    const rebased = (x) => (x == null ? null : x + data.base - loginDone);
    data.relToLoginConfirmed = {
      submitAt: data.submit - loginDone,
      workers: data.workers.map((w) => ({ ...w, at: rebased(w.at) })),
      firstLabTelegramRequestAt: rebased(data.firstLabTelegramRequestAt),
      directSessionRequestsAt: data.directSessionRequestsAt.map(rebased),
      cardsAt: data.cards - loginDone,
    };
    data.baseNote = 'at/cardsMs relativos al envío del login (clic en submit); relToLoginConfirmed relativo al login confirmado';
    note({ id, status: 'PASS', type: 'cold', data });
  } catch (e) { failures.push(id); await R.shot('fail-' + id); note({ id, status: 'FAIL', type: 'cold', why: String(e && e.message).slice(0, 300) }); }
  await R.finish(); await sleep(400); await rmProfile(kind);
}

async function hotRuns(n) {
  const kind = 'first-play-hot';
  await rmProfile(kind);
  const R = await createRun({ kind, args });
  if (!R) { failures.push('hot'); note({ id: 'hot', status: 'FAIL', why: 'no se pudo abrir Chrome' }); return; }
  try {
    await R.browser.scriptAddPreloadScript({ functionDeclaration: PRELOAD });
    await R.login(POSTGRES, account);
    await galleryReady(R); await R.installAudioCapture();
    // Calentamiento (no se cuenta): un play completo para llenar caché HTTP / IndexedDB del perfil.
    const warm = await playOnce(R, await R.ex(() => window.__fp.origin));
    const cardId = warm.id;
    for (let k = 1; k <= n; k++) {
      const id = `hot-${k}`;
      try {
        await R.browser.url(POSTGRES + '/gallery');
        await galleryReady(R); await R.installAudioCapture();
        const origin = await R.ex(() => Math.round(window.__fp.origin));
        const { data } = await playOnce(R, origin, cardId);
        data.baseNote = 'at/cardsMs relativos al inicio de la carga de la página (sesión recordada, sin login)';
        note({ id, status: 'PASS', type: 'hot', data });
      } catch (e) { failures.push(id); await R.shot('fail-' + id); note({ id, status: 'FAIL', type: 'hot', why: String(e && e.message).slice(0, 300) }); }
    }
  } catch (e) { failures.push('hot-setup'); note({ id: 'hot-setup', status: 'FAIL', type: 'hot', why: String(e && e.message).slice(0, 300) }); }
  await R.finish(); await sleep(400); await rmProfile(kind);
}

for (let i = 1; i <= N_COLD; i++) await coldRun(i);
await hotRuns(N_HOT);

const ok = (t) => runs.filter((r) => r.type === t && r.status === 'PASS').map((r) => r.data);
const stat = (list, f) => { const v = list.map(f).filter((x) => x != null); return { n: v.length, median: median(v), p90: p90(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null, values: v }; };
const cold = ok('cold'); const hot = ok('hot');
const summary = {
  label: 'LAB con dobles (Telegram FAKE, Vite dev, PostgreSQL efímero): NO es latencia real de Telegram ni de producción',
  at: new Date().toISOString(), settleMs: SETTLE, p90Method: 'nearest-rank',
  cold: { playMs: stat(cold, (d) => d.playMs), cardsMsFromSubmit: stat(cold, (d) => d.cardsMs), firstWorkerAtFromSubmit: stat(cold, (d) => d.workers[0]?.at ?? null), firstWorkerAtFromLoginConfirmed: stat(cold, (d) => d.relToLoginConfirmed?.workers[0]?.at ?? null), workersCreated: stat(cold, (d) => d.workers.length), firstLabTelegramRequestAtFromSubmit: stat(cold, (d) => d.firstLabTelegramRequestAt), firstLabTelegramReadAfterClickMs: stat(cold, (d) => d.firstLabTelegramReadAfterClickMs), modulesBeforePlay: stat(cold, (d) => d.modulesBeforePlay) },
  hot: { playMs: stat(hot, (d) => d.playMs), cardsMsFromPageStart: stat(hot, (d) => d.cardsMs), firstWorkerAtFromPageStart: stat(hot, (d) => d.workers[0]?.at ?? null), workersCreated: stat(hot, (d) => d.workers.length), firstLabTelegramRequestAtFromPageStart: stat(hot, (d) => d.firstLabTelegramRequestAt), firstLabTelegramReadAfterClickMs: stat(hot, (d) => d.firstLabTelegramReadAfterClickMs), modulesBeforePlay: stat(hot, (d) => d.modulesBeforePlay) },
  workerUrlsSeen: [...new Set(runs.flatMap((r) => (r.data?.workers || []).map((w) => w.url)))],
  externalHostsSeen: [...new Set(runs.flatMap((r) => r.data?.externalHosts || []))],
  failures,
};
fs.writeFileSync(path.join(args.out, 'first-play-results.json'), JSON.stringify({ summary, runs }, null, 2));
const f = (s) => `n=${s.n} mediana=${s.median}ms p90=${s.p90}ms [${s.min}..${s.max}]`;
console.log('TABLE cold play(click->currentTime)  ' + f(summary.cold.playMs));
console.log('TABLE hot  play(click->currentTime)  ' + f(summary.hot.playMs));
console.log('TABLE cold 1st worker from submit    ' + f(summary.cold.firstWorkerAtFromSubmit) + ' ; from login-confirmed ' + f(summary.cold.firstWorkerAtFromLoginConfirmed));
console.log('TABLE cold workers created           ' + f(summary.cold.workersCreated));
console.log('TABLE hot  1st worker from page start' + ' ' + f(summary.hot.firstWorkerAtFromPageStart) + ' ; workers ' + f(summary.hot.workersCreated));
console.log('TABLE cold 1st /lab-telegram from submit ' + f(summary.cold.firstLabTelegramRequestAtFromSubmit));
console.log('TABLE cold modules before play       ' + f(summary.cold.modulesBeforePlay) + ' ; hot ' + f(summary.hot.modulesBeforePlay));
console.log('WORKER URLs', JSON.stringify(summary.workerUrlsSeen), 'EXTERNAL HOSTS', JSON.stringify(summary.externalHostsSeen));
console.log(`FIRST-PLAY ${failures.length || cold.length < 5 || hot.length < 5 ? 'FAIL' : 'PASS'} (LAB con dobles) cold=${cold.length}/${N_COLD} hot=${hot.length}/${N_HOT}${failures.length ? ' fallos: ' + failures.join(',') : ''} OUT ${args.out}`);
process.exit(failures.length || cold.length < 5 || hot.length < 5 ? 1 : 0);
