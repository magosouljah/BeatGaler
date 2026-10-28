import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("MASTER is a minimal resizable/collapsible navigation and centered component canvas", () => {
  const master = read("./playbar/MasterPage.tsx");
  const css = read("./playbar/master.css");
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
  assert.match(css, /padding: var\(--lab-space-8\)/);
  assert.doesNotMatch(css, /lab-master-specimens \{ padding: var\(--lab-space-4\)/);
  assert.match(css, /lab-playbar-seek--preview/);
  assert.match(master, /<Player preview/);
  assert.match(read("../BLUEPRINT/DESIGN-SYSTEM/MASTER.md"), /Botones de Playbar/);
  assert.doesNotMatch(read("./main.tsx"), /studio\.css/);
});

test("isolated Playbar retains production controls, icons and volume while fixing its height", () => {
  const production = read("../src/components/Player.tsx");
  const lab = read("./playbar/Player.tsx");
  for (const element of ["Custom vertical slider", "volThumbBottom", "onVolumeChange(Number(e.target.value))", "data-testid=\"player-scrubber\"",
    "shuffleEnabled", "onCycleRepeat", "onToggleQueue", "speaker3FillPng", "backdropFilter: \"blur(20px)\""]) {
    assert.ok(production.includes(element), "Production removed " + element);
    assert.ok(lab.includes(element), "Lab removed " + element);
  }
  assert.match(lab, /const playerHeight = 68;/);
  assert.doesNotMatch(lab, /playerHeight = isSmall \? 62/);
  assert.match(lab, /isNarrow = preview && viewportWidth <= 760/);
  assert.match(lab, /new ResizeObserver\(update\)/);
  assert.match(lab, /className=\{preview \? "lab-playbar-seek/);
  assert.match(lab, /position: preview \? "absolute" : "relative"/);
  assert.match(lab, /width: preview \? seekGeometry.width/);
  assert.match(read("./playbar/MasterPage.tsx"), /<Player preview/);
});

test("all original player PNG icon assets are copied unchanged", () => {
  const icons = ["shuffle.png","repeat.png","backward.fill.png","forward.fill.png","ellipsis.png","plus.png","music.note.list.png","play.fill.png","pause.fill.png","speaker.fill.png","speaker.slash.fill.png","speaker.1.fill.png","speaker.2.fill.png","speaker.3.fill.png"];
  for (const name of icons) {
    const original = readFileSync(new URL("../src/assets/player-icons/" + name, import.meta.url));
    const copied = readFileSync(new URL("./playbar/assets/" + name, import.meta.url));
    assert.deepEqual(copied, original, name);
  }
});

test("isolated lab has no product runtime imports or network/audio calls", () => {
  for (const path of ["main.tsx","App.tsx","GalleryPage.tsx","components.tsx","playbar/Player.tsx","playbar/MasterPage.tsx","playbar/bridge.tsx"]) {
    const code = read("./" + path);
    assert.doesNotMatch(code, /from\s*["'][^"']*\.\.\/src\//);
    assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|new Audio\s*\(/);
  }
  assert.match(read("./vite.config.ts"), /root: labRoot/);
});

test("landing & gallery and exact procedural artwork are retained", () => {
  const app = read("./App.tsx"), css = read("./lab.css");
  assert.match(app, /useState<View>\("landing"\)/);
  assert.match(app, /<Orbit coverMode=/);
  assert.match(app, /addEventListener\("pointermove"/);
  assert.match(app, /<GalleryPage/);
  assert.match(app, /<MasterPage/);
  assert.match(css, /lab-landing-orbit/);
  assert.match(css, /prefers-reduced-motion/);
  const original = read("../src/lib/proceduralBeatBackground.ts");
  const copy = read("./proceduralBeatBackground.ts");
  assert.equal(copy.split("\n").slice(3).join("\n"), original);
  const dir = new URL("./assets/real-covers/", import.meta.url);
  assert.equal(readdirSync(dir).filter(name => /^cover-\d{2}\.(jpg|avif)$/.test(name)).length,24);
});
