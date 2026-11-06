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
  assert.match(gallery,/<StudioToolbarCandidate gallery/);
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


test("gallery uses 24 distinct one-word names, multi-tags and real covers", () => {
  const data = read("./shared/data.ts");
  const gallery = read("./GALLERY/GalleryPage.tsx");
  const tile = read("./shared/components.tsx");
  const navigation = read("./GALLERY/TagNavigation.tsx");
  const ids = [...data.matchAll(/id:"(demo-\d{2})"/g)].map(m => m[1]);
  const names = [...data.matchAll(/title:"([A-Za-z]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, 24);
  assert.deepEqual(ids, Array.from({length:24},(_,i)=>"demo-"+String(i+1).padStart(2,"0")));
  assert.equal(new Set(names).size, 24);
  assert.equal(names.length, 24);
  const tags = [...data.matchAll(/tags:\[([^\]]+)\]/g)].map(m=>m[1].split(","));
  assert.equal(tags.length, 24);
  assert.ok([4,5].every(n=>tags.some(group=>group.length===n)));
  assert.ok(tags.every(group=>group.length>=3&&group.length<=6));
  const declaredTags = JSON.parse(data.match(/export const DEMO_TAGS = (\[[^;]+\]) as const;/)?.[1] ?? "[]");
  assert.equal(declaredTags.length,35);
  assert.equal(new Set(declaredTags).size,declaredTags.length);
  assert.deepEqual(new Set(tags.flat().map(name=>JSON.parse(name))),new Set(declaredTags));
  assert.ok(declaredTags.includes("BoomBap")&&declaredTags.includes("Hyperpop"));
  assert.ok(tile.includes("beat.tags.map(tag =>"));
  assert.ok(gallery.includes("included.some(name => item.tags.includes(name))"));
  assert.ok(gallery.includes("<StudioToolbarCandidate gallery"));
  assert.ok(gallery.includes("<TagNavigation"));
  assert.ok(!gallery.includes("lab-gallery-header"));
  for (const piece of ["CLOSE_DELAY = 900","useLayoutEffect","beforeLayout","spring.velocity","prefers-reduced-motion","passive: false","ArrowRight","LONG_PRESS_DELAY"]) {
    assert.ok(navigation.includes(piece), piece);
  }
  assert.ok(gallery.includes("!excluded.some(name => item.tags.includes(name))"));
  assert.ok(!navigation.includes("lab-tag-color-trigger"));
  assert.ok(!navigation.includes("···"));
  assert.ok(!read("./GALLERY/gallery.css").includes(".lab-tag-color-trigger"));
  assert.ok(navigation.includes("onContextMenu"));
  assert.ok(navigation.includes("onPointerDown"));
  assert.ok(navigation.includes("lab-tag-color-popover"));
  assert.ok(navigation.includes("setTagColors"));
  assert.ok(read("./App.tsx").includes("tagColors={tagColors} setTagColors={setTagColors}"));
  const covers = readdirSync(new URL("./shared/assets/real-covers/", import.meta.url));
  assert.equal(covers.filter(name => /^cover-\d{2}\.(jpg|avif)$/.test(name)).length, 24);
});

test("MASTER switches generated/real covers above REGLAS for Gallery and Landing", () => {
  const master = read("./MASTER/MasterPage.tsx");
  const app = read("./App.tsx");
  const cover = master.indexOf('className="lab-master-sidebar-heading">PORTADAS');
  const rules = master.indexOf('className="lab-master-sidebar-heading">REGLAS');
  assert.ok(cover >= 0 && rules > cover);
  assert.ok(master.includes('aria-pressed={coverMode === "real"}'));
  assert.ok(master.includes('setCoverMode("real")'));
  assert.ok(master.includes('setCoverMode("generated")'));
  assert.ok(app.includes("<GalleryPage coverMode={coverMode}"));
  assert.ok(app.includes("<LandingPage")&&app.includes("coverMode={coverMode}"));
  assert.ok(app.includes("<MasterPage coverMode={coverMode} setCoverMode={setCoverMode} tagBarVariant={tagBarVariant}"));
});

test("gallery navigation has a real one-line bar that pushes the Studio toolbar", () => {
  const gallery = read("./GALLERY/GalleryPage.tsx");
  const nav = read("./GALLERY/TagNavigation.tsx");
  const css = read("./GALLERY/gallery.css");
  const studio = read("./MASTER/StudioToolbarCandidate.tsx");
  const studioCss = read("./MASTER/studio-toolbar.css");
  assert.match(gallery, /lab-gallery-top-stack/);
  assert.match(gallery, /data-tags-open=\{tagsVisible/);
  assert.match(gallery, /galleryTagsOpen=\{tagsVisible\}/);
  assert.match(nav, /onVisibilityChange/);
  assert.match(nav, /createPortal\(/);
  assert.match(nav, /scrollBy\(/);
  assert.match(nav, /passive: false/);
  assert.match(nav, /useLayoutEffect/);
  assert.match(css, /grid-template-rows: 0fr/);
  assert.match(css, /grid-template-rows: 1fr/);
  assert.match(css, /lab-gallery-tag-surface/);
  assert.match(css, /padding-top: calc\(var\(--lab-space-24\) - var\(--lab-space-2\)\)/);
  assert.match(css, /background: #0c0c0c/);
  assert.match(css, /content: attr\(data-label\)/);
  assert.match(css, /text-shadow: 0 0 \.8px currentColor/);
  assert.match(nav, /event\.altKey/);
  assert.match(gallery, /exclude \? "exclude" : "include"/);
  assert.doesNotMatch(nav, /Click to include, exclude or clear/);
  assert.match(css, /overflow-x: auto/);
  assert.match(css, /white-space: nowrap/);
  assert.match(css, /has-left\.has-right/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css.slice(css.indexOf("/* Single fixed navigation stack")), /lab-gallery-tags-layer \{[^}]*position: fixed/);
  assert.match(studioCss, /height: 600px/);
  assert.match(studio, /galleryTagsOpen/);
  assert.match(studio, /const end=performance.now\(\)\+340/);
});

test("softened Studio 44 preset keeps the untouched diagnostic reference", () => {
  const original = JSON.parse(read("./MASTER/studio-toolbar-44-original.json"));
  const current = JSON.parse(read("./MASTER/studio-toolbar-44.json"));
  const exact = read("./MASTER/StudioExact44.tsx");
  assert.equal(original.controls.glareFactor,33.82);
  assert.equal(original.controls.glareOppositeFactor,78.81);
  assert.ok(current.controls.glareFactor<original.controls.glareFactor);
  assert.ok(current.controls.glareOppositeFactor<original.controls.glareOppositeFactor);
  assert.ok(current.controls.glareFactor>original.controls.glareFactor*.82);
  assert.ok(current.controls.glareOppositeFactor>original.controls.glareOppositeFactor*.82);
  assert.equal(current.controls.refDistance,original.controls.refDistance);
  assert.equal(current.controls.refFresnelFactor,original.controls.refFresnelFactor);
  assert.match(exact, /studio-toolbar-44-original\.json\?raw/);
});

test("Studio gallery transparent shader supports Windows CRLF and Linux LF, with graceful fallback", () => {
  const candidate = read("./MASTER/StudioToolbarCandidate.tsx");
  const shader = read("./MASTER/engines/studio/fragment-main.glsl");
  const output = /\bfragColor\s*=\s*outColor\s*;\s*\}\s*$/;
  assert.ok(candidate.includes("const galleryOutput=" + String(output) + ";"));
  assert.ok(candidate.includes("const galleryShaderAvailable=galleryShader!==opticalShader"));
  assert.ok(candidate.includes("if(gallery&&!galleryShaderAvailable)throw Error("));
  assert.doesNotMatch(candidate, /if\(galleryShader===opticalShader\)throw/);
  for (const ending of ["\n", "\r\n"]) {
    const source = shader.replace(/\r?\n/g, ending);
    assert.match(source, output);
    const patched = source.replace(output, "fragColor = vec4(outColor.rgb, 0.0);\n}");
    assert.notEqual(patched, source);
    assert.match(patched, /fragColor = vec4\(outColor.rgb, 0.0\)/);
  }
});


test("Gallery tag bar pins filters, sits at top, and differentiates assigned colors", () => {
 const gallery=read("./GALLERY/GalleryPage.tsx"),nav=read("./GALLERY/TagNavigation.tsx"),css=read("./GALLERY/gallery.css");
 assert.match(gallery,/const tagsVisible = tagsOpen \|\| hasActiveFilters/);
 assert.match(gallery,/hasActiveFilters=\{hasActiveFilters\}/);
 assert.match(nav,/if \(hasActiveFilters \|\| editingTag \|\| keyboardFocus/);
 assert.match(nav,/matches\(":focus-visible"\)/);
 assert.match(nav,/pointerNearby/);
 assert.match(css,/top: env\(safe-area-inset-top, 0px\)/);
 assert.match(css,/gap: 8px/);
 assert.match(css,/\.lab-gallery-tag\.is-idle\.is-custom/);
 assert.match(css,/\.lab-gallery-tag\.is-exclude\.is-custom/);
 assert.doesNotMatch(css,/\.lab-gallery-tag\.is-custom::after/);
 assert.match(css,/data-tag-variant="playbar"/);
 assert.match(gallery,/lab-gallery-tag-cue/);
});
test("Gallery mounts the real DESIGN Player and MASTER controls its material", () => {
 const master=read("./MASTER/MasterPage.tsx"), app=read("./App.tsx");
 const gallery=read("./GALLERY/GalleryPage.tsx"), player=read("./GALLERY/GalleryPlayer.tsx");
 assert.match(master,/Full black/);assert.match(master,/Playbar material/);
 assert.match(master,/setTagBarVariant\("playbar"\)/);
 assert.match(app,/beatgaler\.lab\.tag-bar-variant/);
 assert.match(gallery,/<GalleryPlayer/);assert.doesNotMatch(gallery,/<LabPlayer/);
 assert.match(player,/import Player from "\.\.\/MASTER\/Player"/);
 assert.match(player,/<Player preview/);
 assert.match(player,/onVolumeChange=\{setVolume\}/);
 assert.match(player,/onSeek=\{setProgress\}/);
});



test("Gallery overlays use viewport tokens, never beat geometry, and prevent wheel bleed", () => {
 const gallery=read("./GALLERY/GalleryPage.tsx"), css=read("./GALLERY/gallery.css");
 const nav=read("./GALLERY/TagNavigation.tsx");
 assert.match(css,/\.lab-gallery-top-stack \{[\s\S]*?position: fixed/);
 assert.match(css,/\.lab-gallery-toolbar-float \{[\s\S]*?position: fixed/);
 assert.match(gallery,/data-tags-open=\{tagsVisible/);
 assert.doesNotMatch(gallery,/getBoundingClientRect|ResizeObserver|--gallery-tags-push|querySelector<HTMLElement>/);
 assert.match(css,/--gallery-frame-width:\s*min\(1370px/);
 assert.match(css,/--gallery-tag-height:calc\(var\(--lab-space-24\) - var\(--lab-space-2\)\)/);
 assert.match(css,/--gallery-tag-gap:\s*var\(--lab-space-2\)/);
 assert.match(css,/calc\(var\(--gallery-tag-top\) \+ var\(--gallery-tag-height\) \+ var\(--gallery-tag-gap\) - var\(--gallery-toolbar-top\)\)/);
 assert.match(css,/overflow-anchor: none/);
 assert.match(nav,/preserveScroll\.current = scrollerRef\.current\?\.scrollLeft/);
 assert.doesNotMatch(nav,/scrollToStart/);
 assert.match(nav,/event\.preventDefault\(\);\n\s*const scale/);
 assert.match(nav,/mousePresent\.current = true/);
 assert.match(nav,/mousePresent\.current = false/);
 assert.match(nav,/document\.addEventListener\("pointerdown", touchDown/);
 assert.match(nav,/!mousePresent\.current && window\.matchMedia/);
 assert.match(css,/overscroll-behavior: contain/);
 assert.match(css,/will-change: backdrop-filter/);
});


test("Gallery uses the inset hover layout, deliberate ink and approved 44 preset", () => {
 const gallery=read("./GALLERY/GalleryPage.tsx");
 const nav=read("./GALLERY/TagNavigation.tsx");
 const css=read("./GALLERY/gallery.css");
 const studio=read("./MASTER/StudioToolbarCandidate.tsx");
 const preset=JSON.parse(read("./MASTER/studio-toolbar-44.json")).controls;
 assert.match(css,/\.lab-gallery-top-stack \{[\s\S]*?position: fixed/);
 assert.match(css,/\.lab-gallery-tag-track \{\s*transform:none/);
 assert.match(css,/\.lab-gallery-top-stack \.lab-gallery-tag-surface \{ background: #0c0c0c; \}/);
 assert.match(css,/\.lab-gallery-tag-cue \{[\s\S]*?position:fixed/);
 assert.match(gallery,/tags-hint-seen/);
 assert.doesNotMatch(gallery,/lastRight|first\.top|--gallery-tags-push|useLayoutEffect/);
 assert.match(css,/right:var\(--gallery-toolbar-right\)/);
 assert.match(css,/--gallery-toolbar-optical-inset:10px/);
 assert.match(css,/--gallery-grid-track-width:calc\(/);
 assert.match(css,/grid-template-columns:repeat\(var\(--gallery-grid-columns\)/);
 assert.match(css,/--gallery-tag-top:env\(safe-area-inset-top,0px\)/);
 assert.doesNotMatch(css,/--gallery-toolbar-inset|translate3d\(0,-6px,0\)/);
 assert.match(css,/transition: transform var\(--gallery-reveal-duration\) var\(--lab-ease\)/);
 assert.match(css,/transition: grid-template-rows var\(--gallery-reveal-duration\) var\(--lab-ease\)/);
 assert.match(nav,/event\.clientY <= 78/);
 assert.doesNotMatch(nav,/window\.scrollY < 50/);
 assert.doesNotMatch(studio,/getImageData\(/);
 assert.match(read("./MASTER/studio-toolbar.css"),/color: #fff; --studio-ink: #fff/);
 assert.equal(preset.tint.r,94);
 assert.equal(preset.tint.a,176/255);
 assert.equal(preset.shadowExpand,20);
 assert.equal(preset.shadowFactor,20);
});
