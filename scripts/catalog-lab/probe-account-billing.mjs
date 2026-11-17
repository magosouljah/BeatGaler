// Sonda LAB: Settings → Account / Plan / Preferences en la Gallery POSTGRES (sin pagos reales: el LAB no tiene billing y responde 503; se comprueba que degrada sin romperse).
//   node scripts/catalog-lab/probe-account-billing.mjs [--out DIR]
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'account-billing', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, browser, POSTGRES, cfg, sleep } = R;
const realClick = async (finder, ...a) => { const pt = await ex(finder, ...a); if (!pt) return false; await browser.performActions([{ type: 'pointer', id: 'm', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, x: pt.x, y: pt.y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }]); await browser.releaseActions(); return true; };
const centerOf = (text) => text; const finderText = (text) => { const all = [...document.querySelectorAll('button,div,span')].filter((x) => x.textContent.trim() === text); const e = all.find((x) => x.tagName === 'BUTTON') || all.pop(); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'cards' });
  await realClick(() => { const e = document.querySelector('button[aria-label="Profile"]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }); await sleep(900);
  await realClick(finderText, 'Settings'); await sleep(5000); await shot('acct-open');
  const tabs = {};
  for (const [tab, probe] of [['Account', /BEATGALER ACCOUNT|Account/], ['Plan', /Plan|plan/], ['Preferences', /Incomplete file warnings/]]) {
    await realClick((t) => ({ x: 42, y: ({ Account: 92, Plan: 135, Preferences: 179 })[t] || 92 }), tab); await sleep(2500); await shot(`acct-${tab.toLowerCase()}`);
    tabs[tab] = await ex((src) => ({ rendered: new RegExp(src).test(document.body.innerText) && /Settings/.test(document.body.innerText), crashed: /Something went wrong|Unexpected Application Error/i.test(document.body.innerText), text: document.body.innerText.replace(/\s+/g, ' ').slice(120, 360) }), probe.source);
  }
  rec('ACCT-TABS-RENDER', Object.values(tabs).every((t) => t.rendered && !t.crashed) ? 'PASS' : 'FAIL', tabs);
  const logs = (await browser.getLogs('browser').catch(() => [])).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 200));
  rec('ACCT-LOGS', 'INFO', { severe: logs, uncaught: logs.filter((l) => /Uncaught|TypeError|ReferenceError/.test(l)) });
} catch (e) { rec('ACCT', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
