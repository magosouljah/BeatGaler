// Humo V1 en navegador (LAB con dobles: Cloud real + gateway Telegram FAKE + PostgreSQL efímero; NO es proveedor real).
// Landing -> sesión -> Gallery -> reproducir -> Add beat (File inyectado) -> editar en Drawer (persiste tras recargar) -> papelera.
// Cada paso imprime «STEP <id> PASS|FAIL <ms> <causa>»; sale con código 1 si alguno falla. Un fallo no oculta los pasos siguientes.
// Receta en README (sección «Humo V1»).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { parseArgs, createRun, loadLab } from './browser-common.mjs';
import { makeFileInjector, silentMp3Base64, BUILD } from './file-inject.mjs';
const args = parseArgs();
const abort = (why) => { console.log('STEP 0-PREFLIGHT FAIL ' + why); console.log('SMOKE-V1 FAIL (LAB con dobles) fallos: 0-PREFLIGHT'); process.exit(1); };
// 0) Aislamiento: solo contra el LAB con gateway Telegram FAKE (nunca proveedor real). Antes de abrir navegador o tocar el catálogo.
{
  let lab; try { lab = loadLab(); } catch (e) { abort(String(e.message)); }
  const logFile = lab.L.statePath('cloud.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  if (!log.includes('[lab] preload active: Telegram FAKE')) abort('cloud.log sin «[lab] preload active: Telegram FAKE» (lab-preload.cjs): no se prueba contra un LAB sin doble confirmado');
  const fakePort = lab.cfg.ports.cloud + 5; // doble HTTP «Telegram» FAKE del preload (/lab-telegram)
  const up = await new Promise((res) => { const sk = net.connect(fakePort, '127.0.0.1'); sk.once('connect', () => { sk.destroy(); res(true); }); sk.once('error', () => res(false)); });
  if (!up) abort(`doble /lab-telegram no escucha en 127.0.0.1:${fakePort}`);
  if (/real-preload|gateway=REAL/i.test(log) || log.includes('[real]')) abort('cloud.log indica gateway/proveedor real: abortado');
}
// 0b) Red: Chrome y ChromeDriver locales ya instalados (SMOKE_CHROME / SMOKE_CHROMEDRIVER o detección local); nunca se descarga nada.
const findFirst = (c) => c.filter(Boolean).find((p) => fs.existsSync(p)) || null;
const tmpBase = process.env.TEMP || process.env.TMP || '';
const cached = (() => { try { const d = path.join(tmpBase, 'chromedriver'); return fs.readdirSync(d).map((v) => path.join(d, v, 'chromedriver-win64', 'chromedriver.exe')); } catch { return []; } })();
args.chromedriver = findFirst([process.env.SMOKE_CHROMEDRIVER, ...cached]);
args.chromeBinary = findFirst([process.env.SMOKE_CHROME, ...[process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'))]);
if (!args.chromedriver) abort('ChromeDriver local no encontrado: fija SMOKE_CHROMEDRIVER=<ruta a chromedriver.exe> (no se descarga nada)');
if (!args.chromeBinary) abort('Chrome local no encontrado: fija SMOKE_CHROME=<ruta a chrome.exe>');
const R = await createRun({ kind: 'smoke-v1', args });
if (!R) { console.log('STEP BROWSER FAIL no se pudo abrir Chrome'); process.exit(1); }
const { ex, shot, waitFor, login, logout, galleryState, typeSearch, installAudioCapture, audioState, browser, POSTGRES, cfg, sleep } = R;
const inj = makeFileInjector(ex);

const PLAY_SELECTOR = process.env.SMOKE_PLAY_SELECTOR || '[data-beat-artwork-id]'; // solo para la prueba de mutación (README)
const failures = [];
const timings = [];
async function step(id, fn) {
  const t = Date.now();
  let status = 'FAIL'; let cause = '';
  try {
    const r = await fn();
    if (r === true) status = 'PASS'; else cause = (r && r.why) || 'condición no cumplida';
  } catch (e) { cause = String(e && e.message).slice(0, 300); }
  const ms = Date.now() - t;
  R.rec(id, status, status === 'PASS' ? { ms } : { ms, why: cause });
  console.log(`STEP ${id} ${status} ${ms}ms ${cause}`);
  timings.push([id, ms]);
  if (status === 'FAIL') { failures.push(id); await shot(`fail-${id}`); }
}
// Nota: menu/cardOf replican dos helpers de probe-e2e-ui.mjs, que es un script ejecutable sin exportaciones (no importable).
const api = (p) => ex(async (p0) => { const r = await fetch('/beatgaler-api/catalog/v1' + p0, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; }, p);
// Lista completa con paginación por cursor; HTTP 200 y esquema {items:[{id,name}]} obligatorios (un fallo NO se interpreta como lista vacía).
const listAll = async (p) => {
  const all = []; let cursor = null;
  for (let i = 0; i < 40; i++) {
    const r = await api(p + (p.includes('?') ? '&' : '?') + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    if (r.status !== 200) throw new Error('GET ' + p + ' devolvió HTTP ' + r.status);
    const b = r.body;
    if (!b || !Array.isArray(b.items) || b.items.some((x) => !x || typeof x.id !== 'string' || typeof x.name !== 'string')) throw new Error('esquema inválido en ' + p);
    all.push(...b.items); cursor = b.nextCursor || null; if (!cursor) return all;
  }
  throw new Error('paginación sin fin en ' + p);
};
const beats = () => listAll('/beats');
const byName = async (n) => (await beats()).find((b) => b.name === n) || null;
const idIn = async (p, id) => (await listAll(p)).some((b) => b.id === id);
const clickByText = (text) => ex((t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === t || (t.length > 8 && (x.textContent || '').includes(t))); if (!b) return false; b.click(); return true; }, text);
const clickStarts = (text) => ex((t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith(t) && !x.disabled); if (!b) return false; b.click(); return true; }, text);
const cardOf = (name) => ex((n) => { const c = [...document.querySelectorAll('[data-beat-card-id]')].find((x) => x.textContent.includes(n)); return c ? c.getAttribute('data-beat-card-id') : null; }, name);
const menu = (cardId, label) => ex((id, l) => { const c = document.querySelector(`[data-beat-card-id="${id}"]`); if (!c) return false; const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 20 })); return new Promise((res) => setTimeout(() => { const m = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.trim() === l); if (m) m.click(); res(Boolean(m)); }, 300)); }, cardId, label);
const fieldSel = 'input:not([type=search]):not([type=file]):not([type=checkbox]):not([type=range])';
const setVal = (idx, v) => ex((i, x, s) => { const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null); const e = els[i]; if (!e) return -1; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, x); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('blur', { bubbles: true })); return els.length; }, idx, v, fieldSel);
const galleryReady = () => waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.storeStatus !== 'loading' && g.cards > 0 ? g : null; }, { timeout: 90000, msg: 'gallery con tarjetas' });

const NAME = 'Humo V1 ' + (Date.now() % 1000000);
const NAME2 = NAME + ' ed';
let count0 = 0;
let createdId = null;

try {
  await step('1-LANDING', async () => {
    await browser.url(POSTGRES + '/'); await sleep(1500);
    await logout(); await browser.url(POSTGRES + '/'); await sleep(1500);
    const s = await ex(() => ({ h1: document.querySelector('h1')?.textContent || '', login: [...document.querySelectorAll('a')].some((a) => a.textContent.trim() === 'Log in'), create: /Create Gallery/.test(document.body.innerText) }));
    return s.h1 === 'BeatGaler' && s.login && s.create ? true : { why: `landing inesperada ${JSON.stringify(s)}` };
  });

  await step('2-SESSION', async () => {
    await ex(() => [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Log in')?.click()); await sleep(800);
    await waitFor(async () => (await browser.$('#auth-login-identifier').isExisting()) || null, { timeout: 60000, msg: 'formulario de login tras «Log in»' });
    await login(POSTGRES, cfg.account);
    const ses = await api('/beats?limit=1');
    return ses.status === 200 ? true : { why: `API autenticada devolvió ${ses.status}` };
  });

  await step('3-GALLERY-SEEDED', async () => {
    const g = await galleryReady(); await installAudioCapture(); await sleep(1000);
    count0 = (await beats()).length;
    return g.cards > 0 && count0 >= 30 ? true : { why: `tarjetas=${g.cards} beats API=${count0} (esperado >=30 sembrados)` };
  });

  await step('4-PLAY-AUDIO', async () => {
    const id = await ex(() => document.querySelector('[data-beat-card-id]')?.getAttribute('data-beat-card-id'));
    if (!id) return { why: 'sin tarjeta' };
    await (await browser.$(`[data-beat-card-id="${id}"] ${PLAY_SELECTOR}`)).click();
    const a1 = await waitFor(async () => { const a = (await audioState())[0]; return a && !a.paused && a.t > 0.1 && !a.error ? a : null; }, { timeout: 40000, msg: 'audio sonando' });
    await sleep(1500);
    const a2 = (await audioState())[0];
    await ex(() => { window.__v09Audio?.pause(); });
    return a2 && a2.t > a1.t + 0.5 ? true : { why: `currentTime no avanza (${a1.t} -> ${a2 && a2.t})` };
  });

  await step('5-ADD-BEAT', async () => {
    await ex((b64, build) => { window.__mp3 = b64; (0, eval)(build); }, silentMp3Base64(), BUILD);
    await inj.armPicker(['Humo.mp3', 'mp3']);
    if (!(await clickByText('Add beat'))) return { why: 'sin botón «Add beat»' }; await sleep(500);
    if (!(await clickByText('Choose MP3 or WAV'))) return { why: 'sin botón «Choose MP3 or WAV»' };
    await waitFor(async () => (await ex(() => /Review beat 1 of 1/.test(document.body.innerText))) || null, { timeout: 30000, msg: 'pantalla de revisión' });
    await sleep(600); await setVal(0, NAME); await sleep(200);
    if (!(await clickStarts('Save'))) return { why: 'sin botón Save' };
    await waitFor(async () => await byName(NAME), { timeout: 90000, msg: 'beat importado en PostgreSQL (API)' });
    const created = await byName(NAME); const n = (await beats()).length;
    if (n !== count0 + 1) return { why: `total ${n}, esperado ${count0 + 1}` };
    createdId = created.id;
    await typeSearch(NAME); await sleep(600);
    const card = await waitFor(async () => ((await ex((id) => Boolean(document.querySelector(`[data-beat-card-id="${id}"]`)), createdId)) ? true : null), { timeout: 30000, msg: 'tarjeta del ID creado en la Gallery' });
    return card ? true : { why: 'sin tarjeta del ID creado' };
  });

  await step('6-EDIT-DRAWER-PERSISTS', async () => {
    await typeSearch(NAME); await sleep(800);
    const id = await waitFor(() => cardOf(NAME), { timeout: 30000, msg: 'tarjeta del beat añadido' });
    if (!(await menu(id, 'Edit metadata'))) return { why: 'menú contextual sin «Edit metadata»' }; await sleep(900);
    await setVal(0, NAME2); await sleep(200); await setVal(2, '140'); await sleep(200);
    if (!(await clickByText('Save changes'))) return { why: 'sin botón «Save changes»' };
    const b = await waitFor(async () => await byName(NAME2), { timeout: 30000, msg: 'renombrado visible en API' });
    await browser.url(POSTGRES + '/gallery'); await sleep(2000); await galleryReady();
    await typeSearch(NAME2); await sleep(500);
    const shown = await cardOf(NAME2); const old = await byName(NAME); // nombre antiguo ya no existe (NAME es prefijo de NAME2: no se compara por tarjeta)
    if (b.id !== createdId) return { why: `el ID cambió tras renombrar (${createdId} -> ${b.id})` };
    const d = (await api('/beats/' + b.id)).body || {};
    return shown && !old && String(d.bpm) === '140' ? true : { why: `tras recargar: tarjeta nueva=${Boolean(shown)} antiguaEnAPI=${Boolean(old)} bpm=${d.bpm}` };
  });

  await step('7-TRASH', async () => {
    await typeSearch(NAME2); await sleep(600);
    const id = await waitFor(() => cardOf(NAME2), { timeout: 30000, msg: 'tarjeta a eliminar' });
    if (!(await menu(id, 'Remove from library'))) return { why: 'menú sin «Remove from library»' }; await sleep(900);
    for (const l of ['Remove', 'Move to trash', 'Delete', 'Confirm']) await clickByText(l);
    await waitFor(async () => ((await idIn('/beats', createdId)) ? null : true), { timeout: 30000, msg: 'beat fuera de la lista (API)' });
    await typeSearch(''); await sleep(500); await typeSearch(NAME2); await sleep(700);
    const still = await cardOf(NAME2);
    const stillActive = await idIn('/beats', createdId); const trashed = await idIn('/beats?state=TRASH', createdId);
    return !still && !stillActive && trashed ? true : { why: `tarjeta sigue=${Boolean(still)} activoAun=${stillActive} enPapelera(ID exacto)=${trashed}` };
  });
} catch (e) { console.log('STEP RUN FAIL ' + String(e && e.message)); failures.push('RUN'); }

await R.finish();
console.log(`SMOKE-V1 ${failures.length ? 'FAIL' : 'PASS'} (LAB con dobles) ${timings.map(([i, t]) => `${i}=${t}ms`).join(' ')}${failures.length ? ' fallos: ' + failures.join(',') : ''}`);
process.exit(failures.length ? 1 : 0);
