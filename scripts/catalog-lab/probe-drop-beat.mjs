// Sonda LAB: arrastrar y soltar MP3/WAV sobre la Gallery (misma UI real; el drop se dispara con un File+DataTransfer sintético sobre window).
// Comprueba que el beat se guarda de verdad (PostgreSQL por la API del Cloud), aparece y se reproduce desde el proveedor FAKE.
//   node scripts/catalog-lab/probe-drop-beat.mjs [--out DIR]
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'drop-beat', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, installAudioCapture, audioState, browser, POSTGRES, cfg, sleep } = R;

const silentMp3Base64 = () => { const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; return Buffer.concat(Array.from({ length: 1500 }, () => frame)).toString('base64'); };

const drop = async (name, b64) => {
  await ex((n, data) => { const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], n, { type: /.(mp3|wav)$/i.test(n) ? 'audio/mpeg' : 'text/plain' })); window.__dt = dt; const e = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }); window.dispatchEvent(e); }, name, b64);
  await sleep(150);
  const overlay = await ex(() => Boolean(document.querySelector('[data-testid="catalog-drop-overlay"]')));
  const prevented = await ex(() => { const e = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }); window.dispatchEvent(e); return e.defaultPrevented; });
  return { overlay, prevented };
};
const clickByText = (text, sel = 'button') => ex((t, s) => { const b = [...document.querySelectorAll(s)].find((x) => (x.textContent || '').includes(t)); if (!b) return false; b.click(); return true; }, text, sel);
const notice = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
const apiBeats = (q) => ex(async (query) => { const r = await fetch(`/beatgaler-api/catalog/v1/beats?limit=50&q=${encodeURIComponent(query)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); return { status: r.status, body: await r.json().catch(() => null) }; }, q);
const LONG = 'Un nombre de archivo soltado que supera con holgura los cincuenta caracteres.mp3';
const EDITED = 'Soltado y renombrado';
const SHORT = 'Beat soltado corto';
try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'catalog cards' });
  await installAudioCapture();
  const b64 = silentMp3Base64();
  // A) nombre válido: drop → se importa sin pasos extra
  const a = await drop(`${SHORT}.mp3`, b64);
  const okA = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import A' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  await shot('d1-dropped');
  const inA = JSON.stringify((await apiBeats(SHORT)).body).includes(SHORT);
  rec('DROP-A-SHORT-NAME', a.overlay && a.prevented && /importado\./.test(String(okA)) && inA ? 'PASS' : 'FAIL', { ...a, notice: okA, inPostgres: inA });
  // B) nombre largo: drop → renombrar → guardar con el nombre editado
  await sleep(500);
  await drop(LONG, b64);
  await waitFor(() => ex(() => Boolean(document.querySelector('#add-beat-name'))), { timeout: 10000, msg: 'rename dialog' });
  const dlg = await ex(() => ({ original: document.querySelector('[data-testid="add-beat-original-file"]')?.textContent, disabled: document.querySelector('[data-testid="add-beat-confirm"]')?.disabled, count: document.querySelector('[data-testid="add-beat-name-count"]')?.textContent }));
  await shot('d2-rename');
  const early = JSON.stringify((await apiBeats('Un nombre de archivo soltado')).body).includes('Un nombre de archivo soltado');
  await ex((v) => { const i = document.querySelector('#add-beat-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); }, EDITED);
  await sleep(200); await clickByText('Add beat', '[data-testid="add-beat-confirm"]');
  const okB = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import B' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  const inB = JSON.stringify((await apiBeats(EDITED)).body).includes(EDITED);
  const orig = JSON.stringify((await apiBeats('Un nombre de archivo soltado')).body).includes('Un nombre de archivo soltado');
  rec('DROP-B-LONG-NAME', dlg.original === LONG && dlg.disabled === true && !early && /importado\./.test(String(okB)) && inB && !orig ? 'PASS' : 'FAIL', { dialog: dlg, earlyListed: early, notice: okB, savedEdited: inB, savedUnderFileName: orig });
  // C) reproducción del beat soltado (proveedor FAKE)
  await typeSearch(EDITED); await sleep(800);
  const card = await waitFor(async () => (await ex(() => document.querySelector('[data-card]')?.getAttribute('data-card') ?? null)), { timeout: 20000, msg: 'card' }).catch(() => null);
  let played = null;
  if (card) { await (await browser.$(`[data-card="${card}"] [data-beat-artwork-id]`)).click(); played = await waitFor(async () => { const x = (await audioState())[0]; return x && !x.paused && x.t > 0.1 && !x.error ? x : null; }, { timeout: 30000, msg: 'audio' }).catch(async () => (await audioState())[0] || null); }
  rec('DROP-C-PLAY', card && played && !played.paused ? 'PASS' : 'FAIL', { card: Boolean(card), audio: played });
  // D) archivos no soportados / varios: aviso y no se importa nada; arrastre que no es de archivos se ignora
  const d = await drop('notas.txt', b64);
  await sleep(500); const dialogText = await ex(() => /Nothing to import|Drop an MP3 or WAV file/.test(document.body.innerText));
  rec('DROP-D-UNSUPPORTED', dialogText ? 'PASS' : 'FAIL', { d, alertShown: dialogText });
  await shot('d3-unsupported');
} catch (e) { rec('DROP', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
