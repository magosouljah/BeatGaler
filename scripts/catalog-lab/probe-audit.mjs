// Sonda LAB de la auditoría funcional: Download (menú de la tarjeta), PROJECT por arrastre, papelera nativa (Settings → Trash) y WAV importado (Cloud real + gateway FAKE + PostgreSQL efímero).
//   node scripts/catalog-lab/probe-audit.mjs [--out DIR]
import { buttonActions, parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'audit', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, browser, POSTGRES, cfg, sleep } = R;
const { press } = buttonActions(ex);
const notice = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
const apiList = (q) => ex(async (n) => { const r = await fetch(`/beatgaler-api/catalog/v1/beats?limit=200&q=${encodeURIComponent(n)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); return (await r.json()).items || []; }, q);
const realClick = async (finder) => { const pt = await ex(finder); if (!pt) return false; await browser.performActions([{ type: 'pointer', id: 'm', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, x: pt.x, y: pt.y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }]); await browser.releaseActions(); return true; };
const center = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
const ctxMenu = (sel, item) => ex((s, it) => { const c = document.querySelector(s); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 20 })); return new Promise((res) => setTimeout(() => { const m = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.trim() === it); m?.click(); res(Boolean(m)); }, 250)); }, sel, item);

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'cards' });
  await ex(() => { window.__saved = []; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__saved.push(this.download); return; } return orig.call(this); }; });
  const cardSel = await ex(() => `[data-beat-card-id="${document.querySelector('[data-beat-card-id]').getAttribute('data-beat-card-id')}"]`);
  const name = await ex((s) => document.querySelector(`${s} [data-beat-artwork-id]`).getAttribute('aria-label').replace(/^(Play|Pause) /, ''), cardSel);

  // 1. Download: el menú abre el modal con los archivos reales y baja el MP3 (verificado por el cliente de medios)
  const opened = await ctxMenu(cardSel, 'Download'); await sleep(900); await shot('audit-download-modal');
  const modal = await ex(() => ({ title: /Download/.test(document.body.innerText), mp3: [...document.querySelectorAll('button')].some((b) => /Download/.test(b.textContent) && !b.disabled) }));
  await press('MP3', true); // primera opción de descarga
  const done = await waitFor(async () => ((await ex(() => window.__saved)).length ? await ex(() => window.__saved) : null), { timeout: 30000, msg: 'download' }).catch(() => null);
  rec('AUDIT-DOWNLOAD', opened && modal.title && done && /\.mp3$/i.test(done[0]) ? 'PASS' : 'FAIL', { opened, modal, saved: done, notice: await notice() });
  await ex(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); await press('Close'); await sleep(300);

  // 2. PROJECT por arrastre sobre una tarjeta (zip) con confirmación
  const before = (await apiList(name)).find((x) => x.name === name);
  await ex((s) => (async () => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], 'proyecto.zip', { type: 'application/zip' })); const c = document.querySelector(s); const mk = (t) => new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }); c.dispatchEvent(mk('dragenter')); c.dispatchEvent(mk('dragover')); await new Promise((r) => setTimeout(r, 200)); c.dispatchEvent(mk('drop')); })(), cardSel);
  await sleep(500); const dlg = await ex(() => /Add project\?|Replace project\?/.exec(document.body.innerText)?.[0] || null); const pressed = await press(before.hasProject ? 'Replace' : 'Add'); await sleep(1500); const afterPress = await ex(() => ({ dialog: /Add project\?|Replace project\?/.test(document.body.innerText), notice: document.querySelector('.bg-catalog-notice')?.textContent, buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /^(Add|Replace|Cancel)$/.test(t)) })); rec('AUDIT-PROJECT-debug', 'INFO', { pressed, afterPress });
  const okP = await waitFor(async () => /Proyecto (añadido|reemplazado)/.test(await notice()) || null, { timeout: 60000, msg: 'project' }).catch(() => false);
  const afterP = (await apiList(name)).find((x) => x.name === name);
  rec('AUDIT-PROJECT-drop', dlg && okP && afterP.id === before.id && afterP.hasProject ? 'PASS' : 'FAIL', { dlg, okP, hadProject: before.hasProject, hasProject: afterP?.hasProject, notice: await notice() });

  // 3. Papelera nativa: borrar → Settings → Trash lista el beat → restaurar → vuelve a la Gallery
  await ex((s) => document.querySelector(s)?.scrollIntoView(), cardSel);
  const del = await ctxMenu(cardSel, 'Remove from library'); await sleep(1500);
  const trashedApi = (await ex(async (n) => { const r = await fetch(`/beatgaler-api/catalog/v1/beats?limit=200&state=TRASH&q=${encodeURIComponent(n)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); return (await r.json()).items || []; }, name)).some((x) => x.name === name);
  await realClick(() => { const e = document.querySelector('button[aria-label="Profile"]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }); await sleep(900); await shot('audit-profile-menu');
  await realClick(() => { const e = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Settings'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }); await sleep(2500); rec('AUDIT-DBG', 'INFO', await ex(() => ({ txt: document.body.innerText.slice(0, 160), n: [...document.querySelectorAll('*')].filter((e) => /Trash/.test(e.textContent) && e.children.length < 3).map((e) => e.tagName + ':' + e.textContent.trim().slice(0, 20)).slice(0, 6) })));
  await sleep(4000); await shot('audit-settings-open');
  await realClick(() => ({ x: 42, y: 222 })); // pestaña «Trash» del panel (columna izquierda)
  const listed = await ex((n) => [...document.querySelectorAll('[data-trash-item-id]')].some((e) => e.getAttribute('data-trash-beat-name') === n), name);
  await ex((n) => { const row = [...document.querySelectorAll('[data-trash-item-id]')].find((e) => e.getAttribute('data-trash-beat-name') === n); row?.querySelector('button')?.click(); }, name); await sleep(2500);
  const restored = (await apiList(name)).some((x) => x.name === name);
  rec('AUDIT-TRASH-native', del && trashedApi && listed && restored ? 'PASS' : 'FAIL', { del, trashedApi, listedInSettings: listed, restoredInCatalog: restored });
  rec('AUDIT-LOGS', 'INFO', { severe: (await browser.getLogs('browser').catch(() => [])).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 200)) });
} catch (e) { rec('AUDIT', 'ERROR', { message: String(e && e.message || e), logs: (await browser.getLogs('browser').catch(() => [])).slice(-8).map((l) => `${l.level} ${String(l.message).slice(0, 260)}`), url: await browser.getUrl() }); await shot('error').catch(() => {}); } finally { await R.finish(); }
