// Sonda LAB: arrastrar y soltar MP3/WAV sobre la Gallery (misma UI real; el drop se dispara con un File+DataTransfer sintético sobre window).
// Comprueba que el beat se guarda de verdad (PostgreSQL por la API del Cloud), aparece y se reproduce desde el proveedor FAKE.
//   node scripts/catalog-lab/probe-drop-beat.mjs [--out DIR]
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'drop-beat', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, installAudioCapture, audioState, browser, POSTGRES, cfg, sleep } = R;

const silentMp3Base64 = () => { const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; return Buffer.concat(Array.from({ length: 1500 }, () => frame)).toString('base64'); };

const drop = async (name, b64, targetSel = null) => {
  await ex((n, data, sel) => { const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], n, { type: /\.mp3$/i.test(n) ? 'audio/mpeg' : /\.wav$/i.test(n) ? 'audio/wav' : 'text/plain' })); window.__dt = dt; window.__tgt = sel; const t = sel ? document.querySelector(sel) : window; const mk = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); t.dispatchEvent(mk('dragenter')); t.dispatchEvent(mk('dragover')); }, name, b64, targetSel);
  await sleep(150);
  const overlay = await ex(() => Boolean(document.querySelector('[data-testid="catalog-drop-overlay"]')));
  const marked = await ex(() => document.querySelectorAll('[data-card][data-drop-target="true"]').length);
  const prevented = await ex(() => { const t = window.__tgt ? document.querySelector(window.__tgt) : window; const e = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }); t.dispatchEvent(e); return e.defaultPrevented; });
  return { overlay, marked, prevented };
};
const clickByText = (text, sel = 'button') => ex((t, s) => { const b = [...document.querySelectorAll(s)].find((x) => (x.textContent || '').includes(t)); if (!b) return false; b.click(); return true; }, text, sel);
const notice = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
const apiBeats = (q) => ex(async (query) => { const r = await fetch(`/beatgaler-api/catalog/v1/beats?limit=50&q=${encodeURIComponent(query)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); return { status: r.status, body: await r.json().catch(() => null) }; }, q);
const LONG = 'Un nombre de archivo soltado que supera con holgura los cincuenta caracteres.mp3';
const SUF = String(Date.now() % 100000); const EDITED = `Soltado y renombrado ${SUF}`;
const SHORT = `Beat soltado corto ${SUF}`;
try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'catalog cards' });
  await installAudioCapture();
  const b64 = silentMp3Base64();
  // A) drop fuera de tarjeta → pantalla de revisión (Drawer review) con el nombre del archivo → Save → importado
  const reviewOpen = () => ex(() => /Review beat 1 of 1/.test(document.body.innerText));
  const setName = (v) => ex((x) => { const i = [...document.querySelectorAll('input')].find((e) => e.offsetParent !== null && !/file|checkbox|search/.test(e.type) && !/Add tag/.test(e.placeholder)); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, x); i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const save = () => ex(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Save/.test(x.textContent.trim()) && !x.disabled); b?.click(); return Boolean(b); });
  const a = await drop(`${SHORT}.mp3`, b64);
  await waitFor(async () => (await reviewOpen()) || null, { timeout: 30000, msg: 'review A' }); await sleep(600); await shot('d1-review');
  const beforeA = JSON.stringify((await apiBeats(SHORT)).body).includes(SHORT);
  await save();
  const okA = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import A' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  const inA = JSON.stringify((await apiBeats(SHORT)).body).includes(SHORT);
  rec('DROP-A-REVIEW-SAVE', a.overlay && a.prevented && !beforeA && /importado\./.test(String(okA)) && inA ? 'PASS' : 'FAIL', { ...a, earlyListed: beforeA, notice: okA, inPostgres: inA });
  // B) nombre largo: la revisión muestra el nombre del archivo; Save lo rechaza (>50) y no sube; editado se guarda
  await sleep(500); await ex(() => document.querySelector('.bg-catalog-notice button')?.click());
  await drop(LONG, b64);
  await waitFor(async () => (await reviewOpen()) || null, { timeout: 30000, msg: 'review B' }); await sleep(600);
  await save(); await sleep(1200);
  const tooLong = await ex(() => /Máximo 50 caracteres/.test(document.body.innerText));
  const early = JSON.stringify((await apiBeats('Un nombre de archivo soltado')).body).includes('Un nombre de archivo soltado');
  await setName(EDITED); await sleep(300); await save();
  const okB = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import B' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  const inB = JSON.stringify((await apiBeats(EDITED)).body).includes(EDITED);
  const orig = JSON.stringify((await apiBeats('Un nombre de archivo soltado')).body).includes('Un nombre de archivo soltado');
  rec('DROP-B-LONG-NAME', tooLong && !early && /importado\./.test(String(okB)) && inB && !orig ? 'PASS' : 'FAIL', { tooLong, earlyListed: early, notice: okB, savedEdited: inB, savedUnderFileName: orig });
  // C) reproducción del beat soltado (proveedor FAKE)
  await typeSearch(EDITED); await sleep(800);
  const card = await waitFor(async () => (await ex(() => document.querySelector('[data-card]')?.getAttribute('data-card') ?? null)), { timeout: 20000, msg: 'card' }).catch(() => null);
  let played = null;
  if (card) { await (await browser.$(`[data-card="${card}"] [data-beat-artwork-id]`)).click(); played = await waitFor(async () => { const x = (await audioState())[0]; return x && !x.paused && x.t > 0.1 && !x.error ? x : null; }, { timeout: 30000, msg: 'audio' }).catch(async () => (await audioState())[0] || null); }
  rec('DROP-C-PLAY', card && played && !played.paused ? 'PASS' : 'FAIL', { card: Boolean(card), audio: played });
  // E-G) arrastre sobre una BeatCard: reemplazo de audio con confirmación (servicios de mutación PostgreSQL + gateway FAKE)
  const beatInfo = async (name) => { const r = (await apiBeats(name)).body; const it = (r.items || r.beats || []).find((x) => x.name === name); return it ? { id: it.id, version: it.version, fileId: it.playback?.fileId, hasWav: it.hasWav, name: it.name, tags: it.tags, bpm: it.bpm, key: it.key } : null; };
  const total = async () => { const r = await ex(async () => { const x = await fetch('/beatgaler-api/catalog/v1/beats?limit=200', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); return x.json(); }); return (r.items || r.beats || []).length; };
  const dialog = () => ex(() => { const b = [...document.querySelectorAll('button')].map((x) => x.textContent.trim()); const t = document.body.innerText; return { buttons: b.filter((x) => /^(Replace|Add|Cancel)$/.test(x)), title: /Replace MP3\?|Replace WAV\?|Add WAV\?/.exec(t)?.[0] || null }; });
  const press = (label) => ex((l) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === l); b?.click(); return Boolean(b); }, label);
  await typeSearch(EDITED); await sleep(900);
  const tag = `[data-card] `; const cardSel = await ex(() => { const c = document.querySelector('[data-card]'); return c ? `[data-card="${c.getAttribute('data-card')}"]` : null; });
  const before = await beatInfo(EDITED); const count0 = await total();
  // E) cancelar: nada cambia
  const e1 = await drop('cancelado.mp3', b64, cardSel); await sleep(300); const dE = await dialog(); await press('Cancel'); await sleep(500);
  const afterCancel = await beatInfo(EDITED);
  rec('DROP-E-CARD-CANCEL', dE.title === 'Replace MP3?' && afterCancel && afterCancel.fileId === before.fileId && afterCancel.version === before.version && (await total()) === count0 ? 'PASS' : 'FAIL', { e1, dialog: dE, before, afterCancel });
  // F) MP3 sobre la tarjeta: confirma → MISMO beat, nuevo MASTER, metadatos intactos, ningún beat nuevo
  const f1 = await drop('reemplazo.mp3', b64, cardSel); await sleep(300); const dF = await dialog(); await press('Replace');
  const okF = await waitFor(async () => /MP3 reemplazado/.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'replace MP3' }).catch(async (er) => `ERR ${er.message} :: ${await notice()}`);
  const afterF = await beatInfo(EDITED);
  rec('DROP-F-CARD-MP3-REPLACE', dF.title === 'Replace MP3?' && /MP3 reemplazado/.test(String(okF)) && afterF && afterF.id === before.id && afterF.fileId !== before.fileId && afterF.name === before.name && JSON.stringify(afterF.tags) === JSON.stringify(before.tags) && afterF.bpm === before.bpm && (await total()) === count0 && !(await beatInfo('reemplazo')) ? 'PASS' : 'FAIL', { f1, dialog: dF, notice: okF, before, afterF, countBefore: count0, countAfter: await total() });
  // G) WAV: primero «Add WAV?» (el beat no tiene WAV) y luego «Replace WAV?»
  const g1 = await drop('hq.wav', b64, cardSel); await sleep(300); const dG1 = await dialog(); await press('Add');
  const okG1 = await waitFor(async () => /WAV añadido/.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'add WAV' }).catch(async (er) => `ERR ${er.message} :: ${await notice()}`);
  const afterG1 = await beatInfo(EDITED);
  await sleep(600);
  const g2 = await drop('hq2.wav', b64, cardSel); await sleep(300); const dG2 = await dialog(); await press('Replace');
  const okG2 = await waitFor(async () => /WAV reemplazado/.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'replace WAV' }).catch(async (er) => `ERR ${er.message} :: ${await notice()}`);
  const afterG2 = await beatInfo(EDITED);
  rec('DROP-G-CARD-WAV', !before.hasWav && dG1.title === 'Add WAV?' && /WAV añadido/.test(String(okG1)) && afterG1?.hasWav && afterG1.id === before.id && afterG1.fileId === afterF.fileId && dG2.title === 'Replace WAV?' && /WAV reemplazado/.test(String(okG2)) && afterG2?.hasWav && afterG2.id === before.id && (await total()) === count0 ? 'PASS' : 'FAIL', { g1, dG1, okG1, afterG1, dG2, okG2, afterG2 });
  await shot('d4-card-replaced');
  // H) fuera de una tarjeta sigue importando un beat nuevo (la tarjeta no captura todo)
  await typeSearch(''); await sleep(800);
  await ex(() => document.querySelector('.bg-catalog-notice button')?.click()); await drop(`Nuevo fuera ${SUF}.mp3`, b64);
  await waitFor(async () => (await reviewOpen()) || null, { timeout: 30000, msg: 'review H' }); await sleep(500); await save();
  const okH = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import outside card' }).catch(async (er) => `ERR ${er.message} :: ${await notice()}`);
  rec('DROP-H-OUTSIDE-IMPORTS-NEW', /importado\./.test(String(okH)) && (await total()) === count0 + 1 ? 'PASS' : 'FAIL', { notice: okH, total: await total(), expected: count0 + 1 });
  // D) archivos no soportados / varios: aviso y no se importa nada; arrastre que no es de archivos se ignora
  const d = await drop('notas.txt', b64);
  await sleep(500); const dialogText = await ex(() => /Nothing to import|Drop an MP3 or WAV file/.test(document.body.innerText));
  rec('DROP-D-UNSUPPORTED', dialogText ? 'PASS' : 'FAIL', { d, alertShown: dialogText });
  await shot('d3-unsupported');
} catch (e) { rec('DROP', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
