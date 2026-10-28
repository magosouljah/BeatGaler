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
  await sleep(350);
  const wide = await measure();
  assert.equal(wide.layout, "wide");
  assert.ok(Math.abs(wide.artwork.width - 48) < 1, "Wide cover must measure 48px");
  assert.ok(Math.abs(wide.track.left - (wide.artwork.right + 12)) < 2, "Wide seek must align with text");
  assert.ok(wide.track.top - wide.metadata.bottom >= 10, "Wide metadata too close to seek");
  await screenshot("master-playbar-wide.png");
  await viewport(980);
  await sleep(350);
  const compact = await measure();
  assert.equal(compact.layout, "narrow");
  assert.ok(Math.abs(compact.artwork.width - 36) < 1, "Compact cover must measure 36px");
  assert.ok(Math.abs(compact.track.left - compact.artwork.left) < 2, "Compact seek must align with the cover");
  assert.ok(compact.track.top - compact.metadata.bottom >= 10, "Compact metadata too close to seek");
  assert.ok(!compact.seekTransition.includes("left") && !compact.seekTransition.includes("width"), "Seek must not trail resize");
  await screenshot("master-playbar-compact.png");
  console.log(JSON.stringify({ wide, compact, result: "PASS" }, null, 2));
} finally {
  ws?.close();
  vite.kill("SIGTERM");
  browser.kill("SIGTERM");
  // Chrome may still be writing its profile after SIGTERM; retry cleanup instead of failing a passed visual check.
  await rm(profile, { recursive:true, force:true, maxRetries:8, retryDelay:200 });
}
