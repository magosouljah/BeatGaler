// LAB navegador: utilidades compartidas por los runners V09 y V10 (WebdriverIO 9 + WebDriver BiDi, Chrome o Edge).
// Evidencia LAB: gateway Telegram FAKE, PostgreSQL efímero, sin proveedor real. No sustituye G2/G3/G4 ni CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { remote } from 'webdriverio';

const require = createRequire(import.meta.url);
const L = require('./lab-env.cjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv = process.argv.slice(2)) {
  const a = { browser: 'chrome', out: L.DEFAULT_OUT, only: null, headed: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--browser') a.browser = argv[++i];
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--only') a.only = new Set(argv[++i].split(','));
    else if (k === '--skip') a.skip = new Set(argv[++i].split(','));
    else if (k === '--headed') a.headed = true;
    else if (k === '--duration-min') a.durationMin = Number(argv[++i]);
    else if (k === '--sample-sec') a.sampleSec = Number(argv[++i]);
    else if (k === '--seed-n') a.seedN = Number(argv[++i]);
    else a.rest.push(k);
  }
  return a;
}

export function loadLab() {
  if (!fs.existsSync(L.CFG_FILE)) throw new Error(`LAB no levantado: falta ${L.CFG_FILE}. Ejecuta: node scripts/catalog-lab/lab.cjs up`);
  const cfg = JSON.parse(fs.readFileSync(L.CFG_FILE, 'utf8'));
  return { cfg, POSTGRES: `http://127.0.0.1:${cfg.ports.webPostgres}`, LEGACY: `http://127.0.0.1:${cfg.ports.webLegacy}`, N: cfg.seedN, L };
}

export function edgeInstalled() {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  return bases.map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((p) => fs.existsSync(p)) || null;
}

export async function createRun({ kind, args }) {
  const lab = loadLab();
  const OUT = path.join(args.out, kind); fs.mkdirSync(OUT, { recursive: true });
  const results = []; const t0 = Date.now();
  const rec = (id, status, detail = {}) => { const e = { id, status, at: Date.now() - t0, ...detail }; results.push(e); console.log(JSON.stringify(e)); return e; };
  const want = (id) => (!args.only || args.only.has(id)) && !(args.skip && args.skip.has(id));

  let browserName = 'chrome';
  if (args.browser === 'edge') {
    const exe = edgeInstalled();
    if (!exe) { rec('BROWSER', 'NO EJECUTADO', { reason: 'Microsoft Edge no instalado' }); fs.writeFileSync(path.join(OUT, `${kind}-results.json`), JSON.stringify({ kind, browser: 'edge', results }, null, 2)); return null; }
    browserName = 'MicrosoftEdge';
  }
  const chromeArgs = [...(args.headed ? [] : ['--headless=new']), '--window-size=1440,900', `--user-data-dir=${path.join(L.STATE_DIR, `${kind}-${args.browser}-profile`)}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--force-device-scale-factor=1', '--enable-precise-memory-info', '--no-first-run'];
  const caps = { browserName, 'goog:loggingPrefs': { browser: 'ALL', performance: 'ALL' } };
  if (browserName === 'chrome') caps['goog:chromeOptions'] = { args: chromeArgs }; else caps['ms:edgeOptions'] = { args: chromeArgs };
  let browser;
  try { browser = await remote({ logLevel: 'error', capabilities: caps }); }
  catch (e) { rec('BROWSER', 'NO EJECUTADO', { reason: `no se pudo abrir ${args.browser}: ${String(e.message).slice(0, 200)}` }); fs.writeFileSync(path.join(OUT, `${kind}-results.json`), JSON.stringify({ kind, browser: args.browser, results }, null, 2)); return null; }

  // Captura del <audio> del motor aprobado (new Audio() sin DOM) ANTES de cualquier script de la página (BiDi preload).
  try { await browser.scriptAddPreloadScript({ functionDeclaration: "() => { const Orig = window.Audio; const Hooked = function (...a) { const el = new Orig(...a); window.__v09Audio = el; return el; }; Hooked.prototype = Orig.prototype; window.Audio = Hooked; const oc = document.createElement.bind(document); document.createElement = (tag, ...r) => { const el = oc(tag, ...r); if (String(tag).toLowerCase() === 'audio') window.__v09Audio = el; return el; }; window.__v09AudioHooked = true; }" }); } catch (e) { console.log('audio preload unavailable', e.message); }

  const ex = (fn, ...a) => browser.execute(fn, ...a);
  const NET = [];
  const drainNet = async () => { try { for (const e of await browser.getLogs('performance')) { try { const m = JSON.parse(e.message).message; if (m.method === 'Network.requestWillBeSent') NET.push(m.params.request.url); } catch {} } } catch {} return NET; };
  const apiReqs = async (re) => (await drainNet()).filter((u) => u.includes('/beatgaler-api/') && re.test(u.replace(/^.*\/beatgaler-api/, ''))).length;
  const shot = async (name) => { try { fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(await browser.takeScreenshot(), 'base64')); } catch (e) { console.error('shot failed', name, e.message); } };
  async function waitFor(fn, { timeout = 20000, interval = 100, msg = 'condition' } = {}) { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > timeout) throw new Error(`timeout: ${msg}`); await sleep(interval); } }

  // CDP vía chromedriver/msedgedriver (WebdriverIO 9 no expone browser.cdp): POST /session/:id/{goog|ms}/cdp/execute.
  const cdp = async (cmd, params = {}) => {
    const o = browser.options; const base = `${o.protocol || 'http'}://${o.hostname}:${o.port}${(o.path || '/').replace(/\/?$/, '/')}session/${browser.sessionId}`;
    let lastErr = null;
    for (const ns of browserName === 'chrome' ? ['goog'] : ['ms', 'goog']) {
      const r = await fetch(`${base}/${ns}/cdp/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, params }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j.value; lastErr = j.value?.message || r.status;
    }
    throw new Error(`CDP ${cmd}: ${lastErr}`);
  };
  const setViewport = async (width, height, dpr) => {
    try { await browser.browsingContextSetViewport({ context: await browser.getWindowHandle(), viewport: { width, height }, ...(dpr ? { devicePixelRatio: dpr } : {}) }); } catch { await browser.setWindowSize(width, height); }
  };

  async function login(base, account) {
    await browser.url(`${base}/gallery`);
    await waitFor(async () => (await browser.$('#auth-login-identifier').isExisting()) || (await browser.$('[data-library-scroll="true"]').isExisting()), { timeout: 90000, msg: 'login or library' });
    if (await browser.$('#auth-login-identifier').isExisting()) {
      await browser.$('#auth-login-identifier').setValue(account.email);
      await browser.$('#auth-login-password').setValue(account.password);
      await browser.$('.bg-auth-form button[type="submit"]').click();
      await waitFor(async () => !(await browser.$('#auth-login-identifier').isExisting()), { timeout: 60000, msg: 'login' });
    }
  }
  async function logout() {
    await ex(() => { try { localStorage.removeItem('beatgaler:web-session-present:v1'); } catch {} });
    const csrf = await ex(() => { try { return sessionStorage.getItem('beatgaler:web-csrf:v1') || ''; } catch { return ''; } });
    await ex(async (c) => { await fetch('/beatgaler-api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web', ...(c ? { 'X-BeatGaler-CSRF': c } : {}) }, body: '{}' }).catch(() => {}); }, csrf);
    await browser.deleteCookies();
  }
  const galleryState = () => ex(() => {
    const scroller = document.querySelector('[data-library-scroll="true"]');
    const cards = [...document.querySelectorAll('[data-card]')];
    const rows = [...document.querySelectorAll('.bg-catalog-row')];
    const ids = cards.map((c) => c.getAttribute('data-card'));
    const ordinals = cards.map((c) => Number(c.getAttribute('data-ordinal')));
    const track = document.querySelector('.bg-catalog-track');
    const cs = rows[0] ? getComputedStyle(rows[0]) : null;
    const first = cards[0]; const r = first ? first.getBoundingClientRect() : null;
    const status = document.querySelector('.bg-catalog-shell-status');
    const page = document.querySelector('.lab-gallery-page') || document.body;
    return {
      mode: document.querySelector('[data-catalog-mode]')?.getAttribute('data-catalog-mode') ?? null,
      composition: document.querySelector('[data-library-composition]')?.getAttribute('data-library-composition') ?? null,
      cards: cards.length, rows: rows.length, residentRows: Number(track?.getAttribute('data-resident-rows') ?? -1), dupIds: ids.length - new Set(ids).size,
      ordinalMin: Math.min(...ordinals), ordinalMax: Math.max(...ordinals), contiguous: ordinals.length ? ordinals.slice().sort((a, b) => a - b).every((v, i, a) => i === 0 || v === a[i - 1] + 1) : null,
      columns: cs ? cs.gridTemplateColumns.split(' ').filter((t) => /px/.test(t)).length : null, columnGap: cs ? cs.columnGap : null,
      cardWidth: r ? Math.round(r.width) : null, cardHeight: r ? Math.round(r.height) : null,
      rowTops: rows.slice(0, 3).map((x) => parseFloat(x.style.top)), rowHeight: rows[0] ? parseFloat(rows[0].style.height) : null,
      trackHeight: track ? parseFloat(track.style.height) : null, scrollTop: scroller?.scrollTop ?? null, scrollHeight: scroller?.scrollHeight ?? null, clientHeight: scroller?.clientHeight ?? null,
      setsize: document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize') ?? null, feed: Boolean(document.querySelector('[role="feed"]')),
      placeholders: [...document.querySelectorAll('[data-catalog-placeholder]')].map((p) => p.getAttribute('data-catalog-placeholder')),
      selectionCount: status?.getAttribute('data-selection-count') ?? null, selectionStatus: status?.getAttribute('data-selection-status') ?? null, playbackStatus: status?.getAttribute('data-playback-status') ?? null, storeStatus: status?.getAttribute('data-store-status') ?? null,
      notice: document.querySelector('.bg-catalog-notice')?.textContent ?? null,
      audio: (() => { const a = window.__v09Audio; return a ? [{ paused: a.paused, t: Number(a.currentTime.toFixed(2)), src: (a.currentSrc || a.src || '').slice(0, 5), ready: a.readyState, error: a.error ? a.error.code : null }] : []; })(),
      domNodes: document.getElementsByTagName('*').length, activeTag: document.activeElement?.tagName ?? null, activeIsBody: document.activeElement === document.body,
      cssVars: { cols: getComputedStyle(page).getPropertyValue('--gallery-grid-columns').trim(), tile: getComputedStyle(page).getPropertyValue('--gallery-tile-width').trim(), gap: getComputedStyle(page).getPropertyValue('--gallery-grid-column-gap').trim(), rowGap: getComputedStyle(page).getPropertyValue('--gallery-grid-row-gap').trim() },
      pager: Boolean(document.querySelector('.bg-web-pagination, [data-web-pagination]')),
      chrome: Boolean(document.querySelector('.bg-gallery-chrome')), tagBar: Boolean(document.querySelector('.lab-gallery-tag-bar')), toolbar: Boolean(document.querySelector('[aria-label="Toolbar Studio"]')),
      url: location.href,
    };
  });
  const installAudioCapture = () => ex(() => {
    if (window.__v09AudioHooked) return;
    window.__v09AudioHooked = true;
    const Orig = window.Audio; const Hooked = function (...a) { const el = new Orig(...a); window.__v09Audio = el; return el; };
    Hooked.prototype = Orig.prototype; window.Audio = Hooked;
    const oc = document.createElement.bind(document);
    document.createElement = (tag, ...r) => { const el = oc(tag, ...r); if (String(tag).toLowerCase() === 'audio') window.__v09Audio = el; return el; };
  });
  const audioState = () => ex(() => { const a = window.__v09Audio; return a ? [{ paused: a.paused, t: Number(a.currentTime.toFixed(2)), src: (a.currentSrc || a.src || '').slice(0, 5), ready: a.readyState, error: a.error ? a.error.code : null, ended: a.ended }] : []; });
  const typeSearch = async (text) => {
    await browser.$('button[aria-label="Search beats"]').click().catch(() => {}); await sleep(600);
    await ex((t) => { const i = document.querySelector('input[placeholder="Search beats"]'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, t); i.dispatchEvent(new Event('input', { bubbles: true })); }, text);
    await sleep(900);
  };
  const openTagBar = async () => { await browser.performActions([{ type: 'pointer', id: 'm', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: 700, y: 2, duration: 100 }, { type: 'pause', duration: 700 }] }]); await sleep(300); };
  const scrollTo = (top) => ex((t) => { const el = document.querySelector('[data-library-scroll="true"]'); el.scrollTop = t === 'end' ? el.scrollHeight : t; }, top);

  async function finish() {
    const header = { kind, browser: args.browser, browserVersion: browser.capabilities?.browserVersion ?? null, label: 'LAB: Cloud real + gateway Telegram FAKE + PostgreSQL efímero + worker en proceso; no es evidencia de proveedor, CI ni gate', at: new Date().toISOString(), lab: { seedN: lab.N, ports: lab.cfg.ports }, os: { platform: os.platform(), release: os.release(), cpus: os.cpus().length, memGB: Math.round(os.totalmem() / 1e9) } };
    const summary = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
    fs.writeFileSync(path.join(OUT, `${kind}-results.json`), JSON.stringify({ ...header, summary, results }, null, 2));
    try { await browser.deleteSession(); } catch {}
    const sums = fs.readdirSync(OUT).filter((f) => f !== 'SHA256SUMS' && fs.statSync(path.join(OUT, f)).isFile()).sort()
      .map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, f))).digest('hex')}  ${f}`);
    fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), sums.join('\n') + '\n');
    console.log('SUMMARY', JSON.stringify(summary), 'OUT', OUT);
    return summary;
  }
  return { ...lab, args, OUT, browser, browserName, results, rec, want, ex, shot, waitFor, sleep, cdp, setViewport, login, logout, galleryState, installAudioCapture, audioState, typeSearch, openTagBar, scrollTo, drainNet, apiReqs, NET, finish, t0 };
}
