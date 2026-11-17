// Sonda LAB: flujo real de «Add beat» en el navegador del LAB (Chrome aislado, Cloud real + gateway FAKE + PostgreSQL efímero).
// El selector de archivos nativo no es automatizable: se sustituye HTMLInputElement.click() por un File inyectado; todo lo demás es la UI real.
// Comprueba que el beat se guarda de verdad (lista de PostgreSQL por la API del Cloud), aparece en la Gallery y se reproduce desde el proveedor FAKE.
//   node scripts/catalog-lab/probe-add-beat.mjs [--out DIR]
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'add-beat', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, installAudioCapture, audioState, browser, POSTGRES, cfg, sleep } = R;

const silentMp3Base64 = () => { const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; return Buffer.concat(Array.from({ length: 1500 }, () => frame)).toString('base64'); };
const LONG = 'Un nombre de archivo que supera con holgura los cincuenta caracteres.mp3'; // 66 sin extensión
const EDITED = 'Nombre editado en Add beat';
const SHORT = 'Beat corto Add';

const armPicker = (name, b64) => ex((n, data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  window.__pickName = n; window.__pickBytes = bytes;
  if (!window.__pickerPatched) {
    window.__pickerPatched = true;
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file' || !window.__pickName) return orig.call(this);
      const file = new File([window.__pickBytes], window.__pickName, { type: 'audio/mpeg' });
      const dt = new DataTransfer(); dt.items.add(file);
      this.files = dt.files; window.__pickName = null;
      setTimeout(() => this.dispatchEvent(new Event('change', { bubbles: true })), 0);
    };
  }
}, name, b64);
const clickByText = (text, sel = 'button') => ex((t, s) => { const b = [...document.querySelectorAll(s)].find((x) => (x.textContent || '').trim() === t || (x.textContent || '').includes(t)); if (!b) return false; b.click(); return true; }, text, sel);
const notice = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
const apiBeats = (q) => ex(async (query) => {
  const r = await fetch(`/beatgaler-api/catalog/v1/beats?limit=50&q=${encodeURIComponent(query)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } });
  return { status: r.status, body: await r.json().catch(() => null) };
}, q);

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'catalog cards' });
  await installAudioCapture();
  const b64 = silentMp3Base64();
  const before = (await apiBeats(''))?.body;
  rec('ADD-PRE', 'INFO', { listStatus: (await apiBeats('')).status, keys: Object.keys(before || {}) });

  // A) nombre válido: sin paso adicional
  await armPicker(`${SHORT}.mp3`, b64);
  await clickByText('Add beat'); await sleep(400);
  await shot('a1-modal');
  await clickByText('Choose MP3 or WAV'); await sleep(300);
  const dialogA = await ex(() => Boolean(document.querySelector('#add-beat-name')));
  const okA = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import A notice' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  await shot('a2-imported');
  const listA = await apiBeats(SHORT);
  rec('ADD-A-SHORT-NAME', !dialogA && /importado\./.test(String(okA)) && JSON.stringify(listA.body).includes(SHORT) ? 'PASS' : 'FAIL', { renameDialogShown: dialogA, notice: okA, inPostgres: JSON.stringify(listA.body).includes(SHORT) });

  // B) nombre largo: paso de renombrado; sin subir hasta que sea válido
  await sleep(500);
  await armPicker(LONG, b64);
  await clickByText('Add beat'); await sleep(400);
  await clickByText('Choose MP3 or WAV'); await sleep(500);
  const dlg = await ex(() => ({ shown: Boolean(document.querySelector('#add-beat-name')), original: document.querySelector('[data-testid="add-beat-original-file"]')?.textContent, count: document.querySelector('[data-testid="add-beat-name-count"]')?.textContent, disabled: document.querySelector('[data-testid="add-beat-confirm"]')?.disabled }));
  await shot('b1-rename-dialog');
  const earlyList = JSON.stringify((await apiBeats('Un nombre de archivo')).body).includes('Un nombre de archivo');
  await ex((v) => { const i = document.querySelector('#add-beat-name'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); }, EDITED);
  await sleep(200);
  const after = await ex(() => ({ count: document.querySelector('[data-testid="add-beat-name-count"]')?.textContent, disabled: document.querySelector('[data-testid="add-beat-confirm"]')?.disabled }));
  await clickByText('Add beat', '[data-testid="add-beat-confirm"]');
  const okB = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import B notice' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  await shot('b2-imported');
  const listB = await apiBeats('Nombre editado');
  const listOrig = JSON.stringify((await apiBeats('Un nombre de archivo')).body).includes('Un nombre de archivo');
  rec('ADD-B-LONG-NAME', dlg.shown && dlg.original === LONG && dlg.disabled === true && !earlyList && after.disabled === false && /importado\./.test(String(okB)) && JSON.stringify(listB.body).includes(EDITED) && !listOrig ? 'PASS' : 'FAIL',
    { dialog: dlg, earlyListedBeforeConfirm: earlyList, afterEdit: after, notice: okB, savedUnderEditedName: JSON.stringify(listB.body).includes(EDITED), savedUnderFileName: listOrig });

  // C) el beat importado aparece en la Gallery y se reproduce (medio servido por el proveedor FAKE: send → verify → read)
  await typeSearch(EDITED); await sleep(800);
  const card = await waitFor(async () => (await ex(() => { const c = document.querySelector('[data-card]'); return c ? c.getAttribute('data-card') : null; })), { timeout: 20000, msg: 'imported card' }).catch(() => null);
  let played = null;
  if (card) {
    await (await browser.$(`[data-card="${card}"] [data-beat-artwork-id]`)).click();
    played = await waitFor(async () => { const a = (await audioState())[0]; return a && !a.paused && a.t > 0.1 && !a.error ? a : null; }, { timeout: 30000, msg: 'audio playing' }).catch(async () => (await audioState())[0] || null);
  }
  await shot('c-playing');
  rec('ADD-C-GALLERY-PLAY', card && played && !played.paused ? 'PASS' : 'FAIL', { card: Boolean(card), audio: played });
  rec('ADD-LOGS', 'INFO', { severe: (await browser.getLogs('browser').catch(() => [])).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 200)) });
} catch (e) { rec('ADD', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
