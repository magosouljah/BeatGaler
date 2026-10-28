import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

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
  for (const file of ["main.tsx", "App.tsx", "GalleryPage.tsx", "components.tsx", "data.ts"]) {
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
  assert.match(read("./coverSources.ts"), /getProceduralBeatBackgroundDataUrl\(id\)/);
});

test("landing is default with a real demo CTA and discreet MASTER access", () => {
  const app = read("./App.tsx");
  assert.match(app, /useState<View>\("landing"\)/);
  assert.match(app, /Create ur Galer/);
  assert.match(app, /Unlimited cloud storage for your beats/);
  assert.match(app, /Profiles and sharing coming soon\./);
  assert.match(app, /lab-dev-switches/);
  assert.match(app, /onClick=\{openGallery\}/);
  assert.doesNotMatch(app, /Pause motion|Made for music creators|Your beats\. Your space\. Your Galer\./);
  assert.doesNotMatch(app, /lab-tabs|Explore demo gallery|Make space for your sound/);
  const css = read("./lab.css");
  assert.match(css, /lab-landing-orbit/);
  assert.match(css, /prefers-reduced-motion/);
});

test("central scrim cannot shade any orbit cover", () => {
 const css = read("./lab.css");
 assert.match(css, /\.lab-center-scrim\s*\{[^}]*z-index:0;/);
 assert.match(css, /\.lab-landing-orbit\s*\{[^}]*z-index:1;/);
 assert.match(css, /\.lab-landing-center\s*\{[^}]*z-index:22;/);
});
test("buttons use size tokens and intrinsic width, not a fixed CTA width", () => {
 const css=read("./lab.css"),tokens=read("./tokens.css"),component=read("./components.tsx");
 assert.match(css,/width:max-content/);
 assert.match(css,/--btn-pad/);
 assert.doesNotMatch(css,/\.lab-create\s*\{[^}]*min-width:/);
 for(const size of ["sm","md","lg","hero"]) assert.ok(tokens.includes(`--lab-button-${size}-height:`));
 assert.match(component,/trailingIcon/);
 assert.match(component,/aria-busy=/);
});
test("one session-scoped cover mode is wired into landing gallery and MASTER", () => {
 const app=read("./App.tsx"),cover=read("./coverSources.ts");
 assert.match(app,/useState<CoverMode>/);
 assert.match(app,/sessionStorage/);
 assert.match(app,/Generated/);
 assert.match(app,/Real covers/);
 assert.match(app,/<Orbit coverMode=/);
 assert.match(app,/<GalleryPage[^\n]*coverMode=/);
 assert.match(app,/<ComponentPage[^\n]*coverMode=/);
 assert.match(cover,/import\.meta\.glob/);
 assert.match(cover,/getProceduralBeatBackgroundDataUrl\(id\)/);
 assert.doesNotMatch(cover,/https?:\/\/|\bfetch\s*\(/);
});

test("24 distinct real covers are bundled locally with valid JPEG and AVIF headers", () => {
  const dir = new URL("./assets/real-covers/", import.meta.url);
  const covers = readdirSync(dir).filter(name => /^cover-\\d{2}\\.(jpg|avif)$/.test(name)).sort();
  assert.equal(covers.length, 24);
  covers.forEach((name, index) => {
    assert.equal(name, `cover-${String(index + 1).padStart(2, "0")}.${index < 20 ? "jpg" : "avif"}`);
    const bytes = readFileSync(new URL(name, dir));
    if (index < 20) assert.equal(bytes.subarray(0, 3).toString("hex"), "ffd8ff", name);
    else assert.equal(bytes.subarray(4, 12).toString("ascii"), "ftypavif", name);
  });
});

test("gallery uses the compact glass header, real tag color palette and no redundant marketing copy", () => {
  const gallery = read("./GalleryPage.tsx");
  const css = read("./gallery.css");
  assert.match(gallery, /lab-glass-toolbar/);
  assert.match(gallery, /type="search"/);
  assert.match(gallery, /aria-label="Sort by"/);
  assert.match(gallery, /lab-gallery-tag-bar/);
  assert.match(gallery, /TAG_PALETTE/);
  assert.match(gallery, /Change \$\{name\} tag color/);
  assert.match(gallery, /selected\.includes/);
  assert.doesNotMatch(gallery, /Your Galer|Your beats, organized|PRIVATE LIBRARY/);
  assert.match(css, /backdrop-filter:blur\(20px\)/);
});
test("Landing and MASTER are plain dev-only bottom navigation, with no upper Landing link", () => {
  const app = read("./App.tsx"), css = read("./gallery.css");
  assert.match(app, /lab-dev-switches/);
  assert.doesNotMatch(app, /← Landing|lab-back/);
  assert.match(css, /\.lab-dev-switches button \{[^}]*background:transparent/);
});
test("floating player copies production visual geometry while keeping simulated controls", () => {
  const component = read("./components.tsx"),css=read("./gallery.css");
  assert.match(component, /lab-player--\$\{variant\}/);
  assert.match(component, /Previous beat/);
  assert.match(component, /Next beat/);
  assert.match(component, /Repeat:/);
  assert.match(component, /Demo playback position/);
  assert.match(component, /aria-label="Up next"/);
  assert.match(component, /Demo volume/);
  assert.match(component, /no audio/);
  assert.match(css, /height:68px/);
  assert.match(css, /border-radius:34px/);
  assert.match(css, /position:fixed/);
});
