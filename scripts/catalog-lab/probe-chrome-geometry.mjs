// Sonda LAB: mide la geometría de la barra superior (GalleryChrome) a varios anchos contra el LAB. Chrome aislado del LAB, no el del propietario.
//   node scripts/catalog-lab/probe-chrome-geometry.mjs [--out DIR]
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'geometry', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, setViewport, openTagBar, POSTGRES, cfg } = R;
try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'catalog cards' });
  for (const [w, h] of [[1440, 900], [1920, 1080], [1024, 768], [390, 844]]) {
    await setViewport(w, h); await R.sleep(600);
    const m = await ex(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: Math.round(r.x), w: Math.round(r.width), r: Math.round(r.right), mw: cs.maxWidth, ml: cs.marginLeft, pl: cs.paddingLeft, pr: cs.paddingRight, disp: cs.display }; };
      const root = document.querySelector('.bg-product-gallery');
      const chain = []; let el = root && root.firstElementChild;
      const tops = [...(root ? root.children : [])].slice(0, 4).map((c) => ({ cls: String(c.className).slice(0, 50), tag: c.tagName, ...box(c) }));
      const search = document.querySelector('input[type=search], input[placeholder*="earch" i]');
      const headerLike = [...document.querySelectorAll('header, nav, [class*=chrome i], [class*=topbar i], [class*=top-bar i]')].slice(0, 8).map((c) => ({ cls: String(c.className).slice(0, 60), tag: c.tagName, ...box(c) }));
      // cadena de ancestros del buscador
      const anc = []; for (let e = search; e && e !== document.body && anc.length < 8; e = e.parentElement) anc.push({ tag: e.tagName, cls: String(e.className).slice(0, 40), ...box(e) });
      return { vw: innerWidth, docW: document.documentElement.clientWidth, root: box(root), tops, headerLike, anc };
    });
    rec(`GEOM-${w}`, 'INFO', m); await shot(`geom-${w}`);
  }
  await setViewport(1440, 900); await openTagBar(); await R.sleep(600);
  const t = await ex(() => {
    const b = (sel) => [...document.querySelectorAll(sel)].map((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pos: cs.position, left: cs.left, right: cs.right, width: cs.width, mw: cs.maxWidth, ml: cs.marginLeft, mr: cs.marginRight }; });
    return [...b('.lab-gallery-top-stack'), ...b('.lab-gallery-tags-layer'), ...b('.lab-gallery-tag-surface'), ...b('.lab-gallery-tag-shadow'), ...b('.lab-gallery-tag-bar'), ...b('.lab-gallery-tag-track'), ...b('.lab-gallery-toolbar-float')];
  });
  rec('GEOM-TAGS-OPEN', 'INFO', { t }); await shot('geom-tags-open');
} catch (e) { rec('GEOM', 'ERROR', { message: String(e && e.message || e) }); } finally { await R.finish(); }
