// Sonda LAB: PROJECT por arrastre con la lógica de FUSIÓN anterior (Cloud real + gateway FAKE + PostgreSQL efímero).
//  1) un .zip reemplaza el PROJECT completo   2) un archivo de DAW se fusiona con el ZIP actual: se quitan DAW y Backup(s), se conservan samples y demás
//  3) si el PROJECT actual no se puede cargar, se aborta y el PROJECT anterior queda intacto   4) MP3/WAV/metadatos intactos
//   node scripts/catalog-lab/probe-project-merge.mjs [--out DIR]
import JSZip from 'jszip';
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'project-merge', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, browser, POSTGRES, cfg, sleep } = R;
const notice = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
const dismiss = () => ex(() => document.querySelector('.bg-catalog-notice button')?.click());
const press = (label) => ex((l) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === l); b?.click(); return Boolean(b); }, label);
const apiBeat = (name) => ex(async (n) => { const r = await fetch(`/beatgaler-api/catalog/v1/beats?limit=200&q=${encodeURIComponent(n)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); const it = ((await r.json()).items || []).find((x) => x.name === n); return it ? { id: it.id, version: it.version, tags: it.tags, bpm: it.bpm, key: it.key, hasWav: it.hasWav, hasProject: it.hasProject, master: it.playback?.fileId ?? null } : null; }, name);
const projectFileId = (id) => ex(async (bid) => { const r = await fetch(`/beatgaler-api/catalog/v1/beats/${bid}/files`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); const f = ((await r.json()).items || []).find((x) => x.role === 'PROJECT' && x.current); return f ? f.fileId : null; }, id);
const dropFile = (sel, name, b64, type) => ex((s, n, d, t) => (async () => { const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], n, { type: t })); const c = document.querySelector(s); const mk = (x) => new DragEvent(x, { bubbles: true, cancelable: true, dataTransfer: dt }); c.dispatchEvent(mk('dragenter')); c.dispatchEvent(mk('dragover')); await new Promise((r) => setTimeout(r, 200)); c.dispatchEvent(mk('drop')); })(), sel, name, b64, type);
const zipB64 = async (entries) => { const z = new JSZip(); for (const [k, v] of Object.entries(entries)) z.file(k, v); return (await z.generateAsync({ type: 'nodebuffer' })).toString('base64'); };
// Descarga el PROJECT por el flujo real de «Download» y devuelve los nombres de entrada del ZIP.
const downloadedEntries = async (cardSel) => {
  await ex(() => { window.__blobs = []; if (!window.__cou) { window.__cou = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return window.__cou(b); }; const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) return; return o.call(this); }; } });
  await ex((s) => { const c = document.querySelector(s); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 20 })); return new Promise((res) => setTimeout(() => { [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.trim() === 'Download')?.click(); res(true); }, 250)); }, cardSel); await sleep(900);
  await ex(() => { [...document.querySelectorAll('button')].find((b) => /^Full Project/.test(b.textContent.trim()) && !b.disabled)?.click(); });
  const b64 = await waitFor(async () => ex(async () => { const b = window.__blobs.filter((x) => x.type === 'application/zip' || x.size > 0).pop(); if (!b) return null; const buf = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const x of buf) s += String.fromCharCode(x); return btoa(s); }) || null, { timeout: 30000, msg: 'project blob' });
  await press('Close'); await sleep(300);
  const z = await JSZip.loadAsync(Buffer.from(b64, 'base64')); return Object.keys(z.files).filter((n) => !z.files[n].dir).sort();
};

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'cards' });
  const cardSel = await ex(() => `[data-beat-card-id="${document.querySelector('[data-beat-card-id]').getAttribute('data-beat-card-id')}"]`);
  const name = await ex((s) => document.querySelector(`${s} [data-beat-artwork-id]`).getAttribute('aria-label').replace(/^(Play|Pause) /, ''), cardSel);
  const base = await apiBeat(name);

  // 1) .zip → reemplazo completo (con samples, un DAW viejo y una carpeta Backup)
  const original = { 'cancion.flp': 'daw-viejo', 'Samples/kick.wav': 'kick', 'Samples/snare.wav': 'snare', 'Backup/cancion-old.flp': 'backup', 'notas.txt': 'notas' };
  await dropFile(cardSel, 'proyecto.zip', await zipB64(original), 'application/zip'); await sleep(500); await press(base.hasProject ? 'Replace' : 'Add');
  await waitFor(async () => /Proyecto (añadido|reemplazado)/.test(await notice()) || null, { timeout: 60000, msg: 'zip' });
  const afterZip = await apiBeat(name); const entries1 = await downloadedEntries(cardSel);
  rec('PM-1-ZIP-REPLACES-ALL', JSON.stringify(entries1) === JSON.stringify(Object.keys(original).sort()) && afterZip.id === base.id ? 'PASS' : 'FAIL', { entries: entries1 });
  const fileBefore = await projectFileId(afterZip.id);

  // 2) archivo de DAW → fusión: sin DAW viejo ni Backup; samples y notas se conservan; entra el nuevo
  await dismiss(); await dropFile(cardSel, 'nuevo.flp', Buffer.from('daw-nuevo').toString('base64'), 'application/octet-stream'); await sleep(500);
  const dlg = await ex(() => /Replace project\?/.test(document.body.innerText)); await press('Replace');
  await waitFor(async () => /Proyecto reemplazado/.test(await notice()) || null, { timeout: 60000, msg: 'merge' });
  const merged = await apiBeat(name); const entries2 = await downloadedEntries(cardSel); const fileAfter = await projectFileId(merged.id);
  const expected = ['Samples/kick.wav', 'Samples/snare.wav', 'nuevo.flp', 'notas.txt'].sort();
  rec('PM-2-DAW-MERGES', dlg && JSON.stringify(entries2) === JSON.stringify(expected) && fileAfter !== fileBefore && merged.id === base.id && merged.master === base.master && merged.bpm === base.bpm && merged.key === base.key && JSON.stringify(merged.tags) === JSON.stringify(base.tags) ? 'PASS' : 'FAIL', { dlg, entries: entries2, expected, fileChanged: fileAfter !== fileBefore, metaIntact: merged.master === base.master });

  // 3) no se puede cargar el PROJECT actual → aborta sin tocar nada (el PROJECT anterior sigue)
  await dismiss(); await ex(() => { window.__of = window.fetch; window.fetch = (u, o) => (/\/files\/[^/]+\/access|\/catalog\/v1\/media\//.test(String(u?.url ?? u)) ? Promise.resolve(new Response(JSON.stringify({ code: 'BOOM', error: 'access simulado fallido' }), { status: 500, headers: { 'Content-Type': 'application/json' } })) : window.__of(u, o)); });
  await dropFile(cardSel, 'otro.flp', Buffer.from('otro').toString('base64'), 'application/octet-stream'); await sleep(500); await press('Replace'); await sleep(2500);
  const errNotice = await notice(); await ex(() => { window.fetch = window.__of; });
  const unchanged = await apiBeat(name); const fileKept = await projectFileId(unchanged.id);
  rec('PM-3-LOAD-FAILURE-KEEPS-PROJECT', /No se pudo reemplazar el audio|could not be loaded/i.test(errNotice) && fileKept === fileAfter && unchanged.version === merged.version ? 'PASS' : 'FAIL', { errNotice, fileKept: fileKept === fileAfter, versionSame: unchanged.version === merged.version });
  // 4) la SUBIDA falla a mitad de la operación → el PROJECT anterior no se pierde (REPLACE retiene la versión vigente hasta confirmar)
  await dismiss(); await ex(() => { window.__of = window.fetch; window.fetch = (u, o) => (/\/parts\/PROJECT[^/]*\/project/.test(String(u?.url ?? u)) ? Promise.resolve(new Response(JSON.stringify({ code: 'BOOM', error: 'subida simulada fallida' }), { status: 500, headers: { 'Content-Type': 'application/json' } })) : window.__of(u, o)); });
  await dropFile(cardSel, 'falla.zip', await zipB64({ 'x.txt': 'x' }), 'application/zip'); await sleep(500); await press('Replace'); await sleep(4000);
  const errUp = await notice(); await ex(() => { window.fetch = window.__of; });
  const afterUp = await apiBeat(name); const fileUp = await projectFileId(afterUp.id); const entries4 = await downloadedEntries(cardSel);
  rec('PM-4-UPLOAD-FAILURE-KEEPS-PROJECT', /No se pudo reemplazar/.test(errUp) && fileUp === fileAfter && JSON.stringify(entries4) === JSON.stringify(expected) ? 'PASS' : 'FAIL', { errUp, fileKept: fileUp === fileAfter, entries: entries4 });
  rec('PM-LOGS', 'INFO', { severe: (await browser.getLogs('browser').catch(() => [])).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 160)) });
} catch (e) { rec('PM', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
