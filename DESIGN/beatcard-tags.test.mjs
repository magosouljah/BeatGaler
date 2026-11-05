import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactTileTags } from "./shared/beatCardTags.ts";

test("BeatCard tags sort alphabetically and use every available label slot", () => {
  const short = compactTileTags(["Z", "A", "C"], {}, 160);
  assert.deepEqual(short.visible, ["A", "C", "Z"]);
  assert.deepEqual(short.hidden, []);
  assert.equal(short.unrepresented, 0);
  const labels = ["Ambient", "Cinematic", "Piano", "Sad"];
  const wide = compactTileTags(labels, {}, 160);
  const narrow = compactTileTags(labels, {}, 130);
  assert.ok(wide.visible.length >= narrow.visible.length);
  assert.equal(wide.visible.length + wide.hidden.length, labels.length);
});

test("one dot per distinct color; +N counts only redundant or colorless hidden tags", () => {
  const long = ["LongAlphaTagExample", "LongBetaTagExample", "LongGammaTagExample", "LongDeltaTagExample"];
  const colors = Object.fromEntries(long.map((tag, index) => [tag, index < 2 ? "#888888" : "#ff0000"]));
  const packed = compactTileTags(long, colors, 36);
  assert.deepEqual(packed.visible, []);
  assert.deepEqual(packed.dots, ["#888888", "#ff0000"]);
  assert.equal(packed.unrepresented, 2);
  const noColors = compactTileTags(long, {}, 36);
  assert.deepEqual(noColors.dots, []);
  assert.equal(noColors.unrepresented, 4);
});

test("the BeatCard visibly prints +N without the old literal dollar sign", () => {
  const source = readFileSync(new URL("./shared/components.tsx", import.meta.url), "utf8");
  assert.match(source, />\+\{compact\.unrepresented\}<\/span>/);
  assert.doesNotMatch(source, />\+\$\{compact\.unrepresented\}/);
});

test("the preview is delegated and waits 800ms instead of opening on every card hover", () => {
  const source = readFileSync(new URL("./shared/BeatTagPeek.tsx", import.meta.url), "utf8");
  const gallery = readFileSync(new URL("./GALLERY/GalleryPage.tsx", import.meta.url), "utf8");
  assert.match(source, /setTimeout\(\(\) =>/);
  assert.match(source, /}, 800\)/);
  assert.match(gallery, /onPointerOver=\{tagPeek\.onPointerOver\}/);
  assert.doesNotMatch(gallery, /position:"fixed",bottom:110,right:24/);
});


test("single approved BeatCard uses Web's real PNG and four playing bars", () => {
 const source = readFileSync(new URL("./shared/components.tsx", import.meta.url), "utf8");
 const css = readFileSync(new URL("./shared/beatCard.css", import.meta.url), "utf8");
 const master = readFileSync(new URL("./MASTER/MasterPage.tsx", import.meta.url), "utf8");
 assert.match(source, /src\/assets\/player-icons\/play\.fill\.png/);
 assert.match(css, /width:26px;height:26px/);
 assert.match(css, /transition:opacity \.15s/);
 assert.match(source, /WebPlayingBars/);
 assert.match(master, /BeatCardSpecimen/);
 assert.doesNotMatch(master, /BeatCard · 3 ideas/);
 assert.doesNotMatch(css, /lab-tag-peek--cover-overlay|lab-tag-peek--edge-rail/);
});


test("Play hover only activates when pointer is on artwork, not on tags", () => {
 const css = readFileSync(new URL("./shared/beatCard.css", import.meta.url), "utf8");
 assert.match(css, /\.lab-beat-tile--v2 \.lab-beat-tile__cover:hover \.lab-beat-tile__play\{opacity:1\}/);
 assert.doesNotMatch(css, /\.lab-beat-tile--v2:hover \.lab-beat-tile__play/);
});
