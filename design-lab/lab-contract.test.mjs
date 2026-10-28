import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("standalone HTML loads only the lab entry", () => {
  const html = read("./index.html");
  assert.match(html, /src="\/main\.tsx"/);
  assert.doesNotMatch(html, /src\/main\.tsx|beatgaler-api|cloud-server/);
  const config = read("./vite.config.ts");
  assert.match(config, /root: labRoot/);
  assert.doesNotMatch(config, /proxy\s*:/);
});

test("lab does not import product code or initiate remote requests", () => {
  for (const file of ["main.tsx", "App.tsx", "components.tsx", "data.ts"]) {
    const source = read(`./${file}`);
    assert.doesNotMatch(source, /from\s*["'][^"']*\.\.\/src\//);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|new Audio\s*\(|\.play\s*\(/);
    assert.doesNotMatch(source, /https?:\/\//);
  }
});

test("lab tokens preserve source values except the exact procedural artwork canvas", () => {
  const css = read("./tokens.css");
  const tokens = {
    canvas: "#0c0c0c", surface: "#101010", raised: "#151515", hover: "#1c1c1c",
    pressed: "#222222", ink: "#f2f2f2", secondary: "#b0b0b0", muted: "#8b8b8b",
    hairline: "#242424", border: "#343434", focus: "#f2f2f2",
  };
  for (const [name, hex] of Object.entries(tokens)) {
    assert.ok(css.includes(`--lab-${name}: ${hex};`), `Mismatch: ${name}`);
  }
});

test("source of proposals and safety boundaries remain explicit", () => {
  const design = read("../BLUEPRINT/DESIGN-SYSTEM/DESIGN.md");
  assert.match(design, /\[EXISTENTE\]/);
  assert.match(design, /\[LAB\]/);
  assert.match(design, /\[PENDIENTE\]/);
  assert.match(design, /MASTER, INDEX|INDEX, Telegram/);
  assert.match(read("./App.tsx"), /Restablecer tokens/);
});

test("procedural artwork is the exact BeatGaler bg-v1 generator, isolated from product imports", () => {
  const original = read("../src/lib/proceduralBeatBackground.ts");
  const inLab = read("./proceduralBeatBackground.ts");
  assert.equal(inLab.split("\n").slice(3).join("\n"), original);
  assert.match(original, /BACKGROUND_HEX = "#0c0c0c"/);
  assert.match(read("./tokens.css"), /--lab-canvas: #0c0c0c/);
  assert.match(read("./App.tsx"), /COVER_BLACK = "#0c0c0c"/);
  assert.match(read("./components.tsx"), /getProceduralBeatBackgroundDataUrl\(beat\.id\)/);
});

test("landing is default with a real demo CTA and discreet MASTER access", () => {
  const app = read("./App.tsx");
  assert.match(app, /useState<View>\("landing"\)/);
  assert.match(app, /Create ur Galer/);
  assert.match(app, /Unlimited cloud storage for your beats/);
  assert.match(app, /Profiles and sharing coming soon\./);
  assert.match(app, /lab-master-switch/);
  assert.match(app, /onClick=\{openGallery\}/);
  assert.doesNotMatch(app, /Pause motion|Made for music creators|Your beats\. Your space\. Your Galer\./);
  assert.doesNotMatch(app, /lab-tabs|Explore demo gallery|Make space for your sound/);
  const css = read("./lab.css");
  assert.match(css, /lab-landing-orbit/);
  assert.match(css, /prefers-reduced-motion/);
});
