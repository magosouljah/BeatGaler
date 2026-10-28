import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("MASTER is a minimal resizable/collapsible navigation and centered component canvas", () => {
  const master = read("./MASTER/MasterPage.tsx");
  const css = read("./MASTER/master.css");
  assert.match(master, /lab-master-sidebar/);
  assert.match(master, /lab-master-workspace/);
  assert.match(master, /lab-master-specimens/);
  assert.match(master, /setPointerCapture/);
  assert.match(master, /SIDEBAR_HIDE_AT/);
  assert.match(master, /aria-label="Mostrar navegación de MASTER"/);
  assert.match(master, /REGLAS/);
  assert.match(master, /COMPONENTES/);
  assert.match(master, /Márgenes/);
  assert.match(master, /Playbar/);
  assert.match(master, /<Player/);
  for (const unwanted of ["Inspector","Search components","MotionPlayground","Tablet","Fluid","DsButton"]) {
    assert.doesNotMatch(master, new RegExp(unwanted));
  }
  assert.match(css, /padding: var\(--lab-space-6\) var\(--lab-space-8\)/);
  assert.doesNotMatch(css, /lab-master-specimens \{ padding: var\(--lab-space-4\)/);
  assert.match(read("./MASTER/Player.tsx"), /lab-playbar-seek--preview/);
  assert.match(master, /<Player preview/);
  assert.match(read("../BLUEPRINT/DESIGN-SYSTEM/MASTER.md"), /Botones de Playbar/);
  assert.doesNotMatch(read("./main.tsx"), /studio\.css/);
});

test("isolated Playbar retains production controls, icons and volume while fixing its height", () => {
  const production = read("../src/components/Player.tsx");
  const lab = read("./MASTER/Player.tsx");
  for (const element of ["Custom vertical slider", "volThumbBottom", "onVolumeChange(Number(e.target.value))", "data-testid=\"player-scrubber\"",
    "shuffleEnabled", "onCycleRepeat", "onToggleQueue", "speaker3FillPng", "backdropFilter: \"blur(20px)\""]) {
    assert.ok(production.includes(element), "Production removed " + element);
    assert.ok(lab.includes(element), "Lab removed " + element);
  }
  assert.match(lab, /const playerHeight = 68;/);
  assert.doesNotMatch(lab, /playerHeight = isSmall \? 62/);
  assert.match(lab, /narrowSeekLayout = preview && viewportWidth <= 760/);
  assert.match(lab, /new ResizeObserver\(update\)/);
  assert.match(lab, /className=\{preview \? "lab-playbar-seek/);
  assert.match(lab, /position: preview \? "absolute" : "relative"/);
  assert.match(lab, /right: preview \? 0 : undefined/);
  assert.match(lab, /left: preview \? \(isNarrow \? 6 : artworkSize \+ infoGap\)/);
  assert.doesNotMatch(lab, /seekGeometry|trackDataRef/);
  assert.match(read("./MASTER/MasterPage.tsx"), /<Player preview/);
});

test("Playbar mode changes use one FLIP motion; regular resize and artwork never chase dimensions", () => {
  const lab = read("./MASTER/Player.tsx");
  const css = read("./MASTER/master.css");
  assert.match(lab, /seekFromRef/);
  assert.match(lab, /\(before <= 760\) !== \(width <= 760\)/);
  assert.match(lab, /seek\.animate\(/);
  assert.match(lab, /from\.width \/ to\.width/);
  assert.match(lab, /transformOrigin: preview \? "left center"/);
  assert.match(lab, /prefers-reduced-motion: reduce/);
  assert.match(lab, /const artworkSize = preview \? 48/);
  assert.match(lab, /padding: `10px \$\{playerPadding\}px`/);
  assert.match(css, /\.lab-playbar-metadata-row \{ transform: translate3d\(0, -4px, 0\); \}/);
  assert.match(lab, /className=\{preview \? "lab-playbar-metadata-row"/);
  assert.match(lab, /lab-playbar-text-content\$\{isNarrow \? " is-condensed" : ""\}/);
  assert.match(css, /\.lab-playbar-text-content \{/);
  assert.match(css, /\.lab-playbar-text-content\.is-condensed \{/);
  assert.match(css, /translate3d\(-6px, 0, 0\)/);
  assert.match(css, /transition: transform var\(--lab-normal\) var\(--lab-ease\)/);
  assert.match(css, /\.lab-playbar-text-content \{ transition: none; \}/);
  assert.match(css, /\.lab-playbar-cover-slot\.is-condensed \.lab-playbar-artwork/);
  assert.match(css, /translate3d\(0, -4px, 0\) scale\(\.75\)/);
  assert.doesNotMatch(css, /transition:\s*left|transition:\s*width|transition:\s*height/);
  assert.doesNotMatch(css, /transition:\s*all/);
});

test("all original player PNG icon assets are copied unchanged", () => {
  const icons = ["shuffle.png","repeat.png","backward.fill.png","forward.fill.png","ellipsis.png","plus.png","music.note.list.png","play.fill.png","pause.fill.png","speaker.fill.png","speaker.slash.fill.png","speaker.1.fill.png","speaker.2.fill.png","speaker.3.fill.png"];
  for (const name of icons) {
    const original = readFileSync(new URL("../src/assets/player-icons/" + name, import.meta.url));
    const copied = readFileSync(new URL("./MASTER/assets/" + name, import.meta.url));
    assert.deepEqual(copied, original, name);
  }
});

test("isolated lab has no product runtime imports or network/audio calls", () => {
  for (const path of ["main.tsx","App.tsx","GALLERY/GalleryPage.tsx","shared/components.tsx","MASTER/Player.tsx","MASTER/MasterPage.tsx","MASTER/bridge.tsx"]) {
    const code = read("./" + path);
    assert.doesNotMatch(code, /from\s*["'][^"']*\.\.\/src\//);
    assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|new Audio\s*\(/);
  }
  assert.match(read("./vite.config.ts"), /root: labRoot/);
});

test("landing & gallery and exact procedural artwork are retained", () => {
  const app = read("./App.tsx"), css = read("./LANDING/landing.css");
  assert.match(app, /useState<View>\("landing"\)/);
  const landing = read("./LANDING/LandingPage.tsx");
  assert.match(landing, /<Orbit coverMode=/);
  assert.match(landing, /addEventListener\("pointermove"/);
  assert.match(app, /<GalleryPage/);
  assert.match(app, /<MasterPage/);
  assert.match(css, /lab-landing-orbit/);
  assert.match(css, /prefers-reduced-motion/);
  const original = read("../src/lib/proceduralBeatBackground.ts");
  const copy = read("./shared/proceduralBeatBackground.ts");
  assert.equal(copy.split("\n").slice(3).join("\n"), original);
  const dir = new URL("./shared/assets/real-covers/", import.meta.url);
  assert.equal(readdirSync(dir).filter(name => /^cover-\d{2}\.(jpg|avif)$/.test(name)).length,24);
});

test("DESIGN contains MASTER, LANDING, GALLERY and shared assets", () => {
  const app = read("./App.tsx"), main = read("./main.tsx");
  assert.match(app, /from "\.\/MASTER\/MasterPage"/);
  assert.match(app, /from "\.\/LANDING\/LandingPage"/);
  assert.match(app, /from "\.\/GALLERY\/GalleryPage"/);
  assert.match(main, /"\.\/shared\/tokens\.css"/);
  assert.match(main, /"\.\/LANDING\/landing\.css"/);
  assert.match(main, /"\.\/GALLERY\/gallery\.css"/);
  assert.match(read("./shared/coverSources.ts"), /\.\/assets\/real-covers/);
  assert.match(read("./import-real-covers.ps1"), /shared\/assets\/real-covers/);
  assert.match(read("../BLUEPRINT/DESIGN-SYSTEM/MASTER.md"), /DESIGN\/MASTER\/Player\.tsx/);
  assert.match(read("./README.md"), /--config DESIGN\/vite\.config\.ts/);
});

test("shared Toolbar has four icon references, five sort modes and anchored accessible menus", () => {
  const toolbar = read("./shared/Toolbar.tsx");
  const css = read("./shared/toolbar.css");
  const gallery = read("./GALLERY/GalleryPage.tsx");
  const master = read("./MASTER/MasterPage.tsx");
  for(const name of ["magnifyingglass","line.3.horizontal.decrease","xmark","person.crop.circle"]) assert.ok(toolbar.includes(name));
  for(const value of ["manual","name","bpm","stars","date"]) assert.ok(toolbar.includes('key:"' + value + '"'));
  assert.match(toolbar,/role="menuitemradio"/);
  assert.match(toolbar,/onMenuKeyDown/);
  assert.match(toolbar,/document.addEventListener\("pointerdown"/);
  assert.match(css,/top:calc\(100% \+ 12px\);right:0/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.doesNotMatch(css,/transition:\\s*all/);
  assert.match(gallery,/<LabToolbar/);
  assert.match(master,/<LabToolbar/);
  assert.match(gallery,/b\.stars - a\.stars/);
  assert.match(gallery,/b\.createdAt\.localeCompare/);
});

test("Toolbar search has no rectangular focus ring, keeps circular glass edge, and selection stays visibly active", () => {
  const css = read("./shared/toolbar.css");
  assert.match(css,/\.lab-root \.lab-toolbar-search-input:focus-visible\{outline:none;box-shadow:none;\}/);
  assert.match(css,/\.lab-toolbar-search:focus-within \.lab-toolbar-search-glass\{border-color:/);
  assert.match(css,/\.lab-toolbar-search\.is-open \.lab-toolbar-search-trigger\{/);
  assert.match(css,/\.lab-toolbar-search-glass\{position:absolute;right:0;top:0;width:44px;height:44px;/);
  assert.match(css,/\.lab-toolbar-search\.is-open \.lab-toolbar-search-glass\{width:min\(300px,calc\(100vw - 196px\)\);\}/);
  assert.match(css,/\.lab-toolbar-select\.is-selecting\{width:44px;background:rgba\(90,90,90,\.68\);border-color:/);
  assert.doesNotMatch(css,/\.lab-toolbar-search-glass[^}]*transform:scaleX/);
  assert.doesNotMatch(css,/\.lab-toolbar-search\.is-open \.lab-toolbar-search-trigger\{[^}]*background:var\(--glass-bg\)/);
});

test("Toolbar V2 is independent and uses vendored MIT liquid-glass-react refraction", () => {
  const v1 = read("./shared/Toolbar.tsx");
  const v2 = read("./shared/ToolbarV2.tsx");
  const style = read("./shared/toolbar-v2.css");
  const master = read("./MASTER/MasterPage.tsx");
  const engine = read("./vendor/liquid-glass-react/index.tsx");
  const licence = read("./vendor/liquid-glass-react/LICENSE");
  assert.match(master, /Toolbar V1/);
  assert.match(master, /Toolbar V2/);
  assert.match(master, /<LabToolbarV2/);
  assert.match(v2, /import LiquidGlass from "\.\.\/vendor\/liquid-glass-react"/);
  assert.match(v2, /<LiquidGlass/);
  assert.match(v2, /lab-toolbar-v2-skin/);
  assert.match(v2, /role="menuitemradio"/);
  assert.match(v2, /onMenuKeyDown/);
  for(const icon of ["magnifyingglass", "line.3.horizontal.decrease", "xmark", "person.crop.circle"])
    assert.ok(v2.includes(icon));
  assert.match(style, /\.lab-toolbar-v2 \.lab-toolbar-select\.is-selecting \.lab-toolbar-v2-skin/);
  assert.match(engine, /feDisplacementMap/);
  assert.match(engine, /ResizeObserver/);
  assert.match(licence, /MIT|Permission is hereby granted/);
  assert.match(v1, /export default function LabToolbar\(/);
  assert.doesNotMatch(v2, /from\s*["'][^"']*\.\.\/src\//);
  assert.doesNotMatch(v2, /fetch\s*\(|XMLHttpRequest|WebSocket|new Audio\s*\(/);
});
