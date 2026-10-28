// Browser geometry check for DESIGN/MASTER; Chrome DevTools Protocol, no extra npm packages.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = ["google-chrome", "chromium", "chromium-browser"].find(name => spawnSync("which", [name]).status === 0);
if (!chrome) throw new Error("Chrome/Chromium unavailable for visual verification");
const output = path.resolve("DESIGN/visual-check");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "beatgaler-chrome-"));
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "DESIGN/vite.config.ts", "--port", "4173"], { stdio: "ignore" });
const browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", "--remote-debugging-port=9229", "--remote-allow-origins=*", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let ws;
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:4173/")).ok) { ready = true; break; } } catch {}
    if (vite.exitCode !== null) throw new Error(`Vite exited ${vite.exitCode}`);
    await sleep(250);
  }
  assert.ok(ready, "Vite not available");
  let tab;
  for (let i = 0; i < 90; i++) {
    try { tab = (await (await fetch("http://127.0.0.1:9229/json")).json()).find(page => page.type === "page"); if (tab) break; } catch {}
    if (browser.exitCode !== null) throw new Error(`Chrome exited ${browser.exitCode}`);
    await sleep(250);
  }
  assert.ok(tab, "Chrome CDP not available");
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    message.error ? p.reject(Error(JSON.stringify(message.error))) : p.resolve(message.result);
  });
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Page.enable");
  await call("Runtime.enable");
  const viewport = (width, height = 900) => call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await viewport(1440);
  await call("Page.navigate", { url: "http://127.0.0.1:4173/" });
  for (let i = 0; i < 100; i++) {
    if (await evaluate('Boolean(document.querySelector(".lab-dev-switches"))')) break;
    await sleep(100);
  }
  assert.ok(await evaluate('Boolean(document.querySelector(".lab-dev-switches"))'), "Lab navigation not mounted");
  await evaluate('[...document.querySelectorAll(".lab-dev-switches button")].find(x => x.textContent === "MASTER").click()');
  for (let i = 0; i < 50; i++) {
    if (await evaluate('Boolean(document.querySelector(".lab-playbar-seek--preview"))')) break;
    await sleep(100);
  }
  assert.ok(await evaluate('Boolean(document.querySelector(".lab-playbar-seek--preview"))'), "MASTER Playbar not mounted");
  const measure = () => evaluate(`(() => {
    const rect = selector => {
      const el = document.querySelector(selector);
      if (!el) throw Error("Missing " + selector);
      const r = el.getBoundingClientRect();
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height };
    };
    return {
      artwork: rect(".lab-playbar-cover-slot .lab-playbar-artwork"),
      text: rect(".lab-playbar-text-content"),
      track: rect(".lab-playbar-seek--preview > div"),
      metadata: rect(".lab-playbar-metadata-row > div > div:nth-child(2)"),
      layout: document.querySelector(".lab-playbar").dataset.layout,
      seekTransition: getComputedStyle(document.querySelector(".lab-playbar-seek--preview")).transitionProperty
    };
  })()`);
  const screenshot = async filename => {
    const result = await call("Page.captureScreenshot", { format:"png", captureBeyondViewport:false });
    await writeFile(path.join(output, filename), Buffer.from(result.data, "base64"));
  };
  // Measure every rendered frame through both directions. A single screenshot misses
  // the original bug: the gap used to grow from 12px to 18px mid-morph.
  const captureFrames = () => evaluate(`(() => {
    window.__playbarMotionFrames = [];
    let remaining = 34;
    const record = () => {
      const cover = document.querySelector(".lab-playbar-cover-slot .lab-playbar-artwork");
      const label = document.querySelector(".lab-playbar-text-content");
      if (cover && label) {
        const image = cover.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        window.__playbarMotionFrames.push({
          gap: text.left - image.right,
          imageWidth: image.width,
          mode: document.querySelector(".lab-playbar").dataset.layout
        });
      }
      if (--remaining > 0) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    return true;
  })()`);
  const frames = () => evaluate("window.__playbarMotionFrames ?? []");
  const checkGapFrames = (samples, direction) => {
    assert.ok(samples.length >= 12, `${direction}: not enough animation frames`);
    for (const [index, item] of samples.entries()) {
      assert.ok(Math.abs(item.gap - 12) < 1.5,
        `${direction}: frame ${index} jumps to ${item.gap.toFixed(2)}px instead of 12px`);
    }
    const intermediate = samples.filter(item => item.imageWidth > 37 && item.imageWidth < 47);
    assert.ok(intermediate.length >= 2, `${direction}: did not observe a smooth cover morph`);
    return { frames: samples.length, interpolatedFrames: intermediate.length,
      minGap: Math.min(...samples.map(item => item.gap)),
      maxGap: Math.max(...samples.map(item => item.gap)) };
  };
  await sleep(350);
  const wide = await measure();
  assert.equal(wide.layout, "wide");
  assert.ok(Math.abs(wide.artwork.width - 48) < 1, "Wide cover must measure 48px");
  assert.ok(Math.abs(wide.track.left - (wide.artwork.right + 12)) < 2, "Wide seek must align with text");
  assert.ok(wide.track.top - wide.metadata.bottom >= 10, "Wide metadata too close to seek");
  assert.ok(Math.abs(wide.text.left - wide.artwork.right - 12) < 1, "Wide artwork/text gap is not 12px");
  await screenshot("master-playbar-wide.png");
  await captureFrames();
  await viewport(980);
  await sleep(650);
  const intoCompact = checkGapFrames(await frames(), "wide-to-compact");
  const compact = await measure();
  assert.equal(compact.layout, "narrow");
  assert.ok(Math.abs(compact.artwork.width - 36) < 1, "Compact cover must measure 36px");
  assert.ok(Math.abs(compact.track.left - compact.artwork.left) < 2, "Compact seek must align with the cover");
  assert.ok(compact.track.top - compact.metadata.bottom >= 10, "Compact metadata too close to seek");
  assert.ok(Math.abs(compact.text.left - compact.artwork.right - 12) < 1, "Compact gap must be exactly 12px");
  assert.ok(!compact.seekTransition.includes("left") && !compact.seekTransition.includes("width"), "Seek must not trail resize");
  await screenshot("master-playbar-compact.png");
  await captureFrames();
  await viewport(1440);
  await sleep(650);
  const intoWide = checkGapFrames(await frames(), "compact-to-wide");
  const wideAgain = await measure();
  assert.equal(wideAgain.layout, "wide");
  assert.ok(Math.abs(wideAgain.text.left - wideAgain.artwork.right - 12) < 1);
  // Reduced motion must remove both linked transforms simultaneously.
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reduced = await evaluate(`(() => ({
    cover: getComputedStyle(document.querySelector(".lab-playbar-artwork")).transitionDuration,
    text: getComputedStyle(document.querySelector(".lab-playbar-text-content")).transitionDuration
  }))()`);
  assert.equal(reduced.cover, "0s", "Reduced motion: artwork still animates");
  assert.equal(reduced.text, "0s", "Reduced motion: metadata still animates");

  // Toolbar: interact with the actual rendered component in Chrome, capture both
  // popovers and confirm that they remain on the identical top-right anchor.
  await call("Emulation.setEmulatedMedia", { features: [] });
  await evaluate('[...document.querySelectorAll(".lab-master-sidebar-nav button")].find(x => x.textContent === "Toolbar").click()');
  for(let i=0;i<50;i++){
    if(await evaluate('Boolean(document.querySelector(".lab-master-toolbar-frame .lab-toolbar"))'))break;
    await sleep(100);
  }
  assert.ok(await evaluate('Boolean(document.querySelector(".lab-master-toolbar-frame .lab-toolbar"))'),"Toolbar not mounted in MASTER");
  await sleep(220);
  await screenshot("master-toolbar-default.png");

  await evaluate('document.querySelector(".lab-toolbar-circle[aria-label=\"Sort beats\"]").click()');
  await sleep(230);
  const sortOpen=await evaluate('document.querySelector("[role=menu][aria-label=\"Sort beats\"]").classList.contains("is-open")');
  assert.ok(sortOpen,"Sort menu did not open");
  const anchor=await evaluate(`(() => {
    const rect = (name) => {
      const r=document.querySelector('[role=menu][aria-label="'+name+'"]').getBoundingClientRect();
      return {left:r.left,right:r.right,top:r.top,width:r.width};
    };
    return {sort:rect("Sort beats"),profile:rect("Profile")};
  })()`);
  assert.ok(Math.abs(anchor.sort.top-anchor.profile.top)<1,"Popover vertical anchors differ");
  assert.ok(Math.abs(anchor.sort.right-anchor.profile.right)<1,"Popover right anchors differ");
  await screenshot("master-toolbar-sorting.png");

  await evaluate('document.querySelector(".lab-toolbar-circle[aria-label=\"Profile\"]").click()');
  await sleep(230);
  assert.ok(await evaluate('document.querySelector("[role=menu][aria-label=\"Profile\"]").classList.contains("is-open")'),"Profile menu did not open");
  await screenshot("master-toolbar-profile.png");
  await evaluate('document.querySelector(".lab-toolbar-search-trigger").click()');
  await sleep(230);
  const searchShape=await evaluate(`(() => {
    const glass=document.querySelector(".lab-toolbar-search-glass").getBoundingClientRect();
    const button=document.querySelector(".lab-toolbar-search-trigger").getBoundingClientRect();
    const field=document.querySelector(".lab-toolbar-search-input");
    return {glassLeft:glass.left,glassRight:glass.right,buttonLeft:button.left,focused:document.activeElement===field};
  })()`);
  assert.ok(searchShape.glassLeft<searchShape.buttonLeft-80,"Search does not extend left");
  assert.ok(searchShape.focused,"Search is not immediately focused");
  await screenshot("master-toolbar-search.png");
  await evaluate('document.querySelector(".lab-toolbar-select").click()');
  await sleep(230);
  assert.ok(await evaluate('document.querySelector(".lab-toolbar-select").classList.contains("is-selecting")'),"Select did not become X");
  await screenshot("master-toolbar-select.png");

  await viewport(390,844);
  await sleep(260);
  const mobile=await evaluate(`(() => {
    const root=document.querySelector(".lab-toolbar").getBoundingClientRect();
    const controls=[...document.querySelectorAll(".lab-toolbar-search-trigger,.lab-toolbar-circle,.lab-toolbar-select")];
    return {left:root.left,right:root.right,controls:controls.map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}))};
  })()`);
  assert.equal(mobile.controls.length,4,"Mobile must retain all four controls");
  assert.ok(mobile.controls.every(r=>r.left>=0&&r.right<=390),"Mobile toolbar clipped");
  await screenshot("master-toolbar-mobile.png");
  await evaluate('document.querySelector(".lab-toolbar-search-trigger").click()');
  await sleep(230);
  const mobileSearch=await evaluate('document.querySelector(".lab-toolbar-search-glass").getBoundingClientRect().left');
  assert.ok(mobileSearch>=0,"Mobile expanded search overflows left");
  await screenshot("master-toolbar-mobile-search.png");
  console.log(JSON.stringify({ wide, compact, intoCompact, intoWide, reduced, toolbar:{anchor,searchShape,mobile,mobileSearch}, result: "PASS" }, null, 2));
} finally {
  ws?.close();
  vite.kill("SIGTERM");
  browser.kill("SIGTERM");
  // Chrome may still be writing its profile after SIGTERM; retry cleanup instead of failing a passed visual check.
  await rm(profile, { recursive:true, force:true, maxRetries:8, retryDelay:200 });
}
