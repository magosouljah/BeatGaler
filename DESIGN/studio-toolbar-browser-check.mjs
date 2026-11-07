// Chromium CDP smoke test for the isolated Studio 44 toolbar.
// Run from repository root: node DESIGN/studio-toolbar-browser-check.mjs
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {existsSync,readFileSync} from "node:fs";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const latestPreset=JSON.parse(readFileSync("DESIGN/MASTER/studio-toolbar-44.json","utf-8"));
assert.equal(latestPreset.timestamp,"2026-11-02T23:59:40.405Z","Expected most recent user preset");
const originalPreset=JSON.parse(readFileSync("DESIGN/MASTER/studio-toolbar-44-original.json","utf-8"));
assert.equal(originalPreset.controls.glareFactor,33.82);
assert.equal(originalPreset.controls.glareOppositeFactor,78.81);
assert.equal(latestPreset.controls.glareFactor,30.2);
assert.equal(latestPreset.controls.glareOppositeFactor,69);
assert.equal(latestPreset.controls.glareRange,originalPreset.controls.glareRange);
const binaries=[
 process.env.PROGRAMFILES&&path.join(process.env.PROGRAMFILES,"Google","Chrome","Application","chrome.exe"),
 process.env["PROGRAMFILES(X86)"]&&path.join(process.env["PROGRAMFILES(X86)"],"Google","Chrome","Application","chrome.exe"),
 process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,"Google","Chrome","Application","chrome.exe")
].filter(Boolean);
const chrome=process.env.CHROME_BIN||(process.platform==="win32"?binaries.find(existsSync):
 ["google-chrome","chromium","chromium-browser"].find(n=>spawnSync("which",[n]).status===0));
assert.ok(chrome,"Chrome / Chromium required (or CHROME_BIN)");
const output=path.resolve("DESIGN/studio-toolbar-visual-check");
await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),"beatgaler-studio44-"));
const vite=spawn(process.execPath,["node_modules/vite/bin/vite.js","--config","DESIGN/vite.config.ts",
 "--port","4186","--strictPort"],{stdio:"ignore"});
const browser=spawn(chrome,["--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--enable-unsafe-swiftshader","--remote-debugging-port=9256","--remote-allow-origins=*",
 "--window-size=1440,1150","--user-data-dir="+profile,"about:blank"],{stdio:"ignore"});
let ws;
try {
 let tab;
 for(let i=0;i<120;i++){
  try{if((await fetch("http://127.0.0.1:4186/")).ok)break;}catch{}
  if(vite.exitCode!==null)throw Error("Vite exited "+vite.exitCode);
  await sleep(250);
 }
 for(let i=0;i<120;i++){
  try{tab=(await (await fetch("http://127.0.0.1:9256/json")).json()).find(x=>x.type==="page");if(tab)break;}catch{}
  if(browser.exitCode!==null)throw Error("Chromium exited "+browser.exitCode);
  await sleep(250);
 }
 assert.ok(tab,"Chromium CDP unavailable");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 const pending=new Map();let serial=0;
 ws.addEventListener("message",event=>{
  const msg=JSON.parse(event.data),item=pending.get(msg.id);
  if(item){pending.delete(msg.id);msg.error?item.reject(Error(JSON.stringify(msg.error))):item.resolve(msg.result);}
 });
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
 });
 const evaluate=async expression=>{
  const result=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
 };
 const click=selector=>evaluate("document.querySelector("+JSON.stringify(selector)+").click()");
 const bounds=selector=>evaluate("(()=>{const r=document.querySelector("+JSON.stringify(selector)+").getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,width:r.width,height:r.height};})()");
 const capture=async name=>{
  const s=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await writeFile(path.join(output,name),Buffer.from(s.data,"base64"));
 };
 const errors=[];
 ws.addEventListener("message",event=>{
  const m=JSON.parse(event.data);
  if(m.method==="Runtime.exceptionThrown")errors.push(m.params.exceptionDetails.text);
 });
 await call("Runtime.enable");await call("Page.enable");
 await call("Page.navigate",{url:"http://127.0.0.1:4186/"});
 for(let i=0;i<100;i++){
  if(await evaluate("Boolean(document.querySelector('.lab-dev-switches'))"))break;
  await sleep(100);
 }
 assert.ok(await evaluate("Boolean(document.querySelector('.lab-dev-switches'))"),"Design Lab did not mount");
 await evaluate("[...document.querySelectorAll('.lab-dev-switches button')].find(x=>x.textContent==='MASTER').click()");
 for(let i=0;i<100;i++){
  if(await evaluate("Boolean(document.querySelector('.lab-master-sidebar-nav'))"))break;
  await sleep(100);
 }
 // Test ORIGINAL Studio shaders before loading the animated candidate.
 await evaluate("[...document.querySelectorAll('.lab-master-sidebar-nav button')].find(x=>x.textContent==='Glass · Studio Original 44').click()");
 for(let i=0;i<100;i++){
  if(await evaluate("Boolean(document.querySelector('.studio-exact-canvas[data-engine-ready]'))"))break;
  await sleep(100);
 }
 const original=await evaluate("(()=>{let c=document.querySelector('.studio-exact-canvas');return {ready:c?.dataset.engineReady,shader:c?.dataset.shader,radius:c?.dataset.shapeRadiusPx,preset:c?.dataset.presetTimestamp};})()");
 assert.equal(original.ready,"true","Original Studio reference WebGL could not initialize");
 assert.equal(original.shader,"original","Original Studio shaders are not loaded");
 assert.equal(original.radius,"22","Studio percentage radius conversion should be 22px");
 assert.equal(await evaluate("document.querySelector('.studio-exact-canvas').dataset.surfaceSize"),"600x600","Original Studio reference should use 600x600 pixel canvas");
 assert.equal(await evaluate("document.querySelector('.studio-exact-canvas').dataset.backgroundColor"),"#26262b","Original Studio reference should use a solid-color background");
 assert.equal(original.preset,"2026-11-02T23:59:40.405Z");
 await evaluate("document.querySelector('.studio-exact-stage').scrollIntoView({block:'center'})");
 await sleep(350);
 await capture("00-studio-original-static-dark.png");
 await click(".studio-exact-options button:nth-child(2)");
 await sleep(260);
 await capture("00b-studio-original-static-light.png");
  await evaluate("[...document.querySelectorAll('.lab-master-sidebar-nav button')].find(x=>x.textContent==='Toolbar · Studio 44').click()");
 for(let i=0;i<100;i++){
  if(await evaluate("Boolean(document.querySelector('.studio-candidate-canvas[data-engine-ready]'))"))break;
  await sleep(100);
 }
 const engine=await evaluate("document.querySelector('.studio-candidate-canvas')?.dataset.engineReady");
 assert.equal(engine,"true","Original Studio WebGL shader did not compile / initialize");
 assert.equal(await evaluate("document.querySelector('.studio-candidate-canvas').dataset.geometry"),"studio-original-rounded-rect");
 assert.equal(await evaluate("document.querySelector('.studio-candidate-canvas').dataset.optics"),"studio-original-shader");
 assert.equal(await evaluate("document.querySelector('.studio-candidate-canvas').dataset.viewportHeight"),"600");
 assert.equal(await evaluate("document.querySelector('.studio-candidate-canvas').dataset.background"),"#26262b");
 // V2 menus must be the actual V2 popover markup/styles, not old demo menus.
 assert.equal(await evaluate("document.querySelectorAll('.studio-candidate-toolbar .lab-toolbar-v2-popover').length"),2);
 assert.equal(await evaluate("document.querySelectorAll('.studio-candidate-menu').length"),0);
 await evaluate("document.querySelector('.studio-candidate-stage').scrollIntoView({block:'center'})");
 await sleep(500);
 assert.equal(await evaluate("document.querySelectorAll('.studio-lens').length"),4);
 const closed=await bounds(".studio-search");
 const selectBefore=await bounds(".studio-select");
 assert.ok(Math.abs(closed.width-44)<1&&Math.abs(selectBefore.width-78)<1,"Wrong 44/78px geometry");
 await capture("01-studio-default-dark.png");
 // Long hold is essential: the old 6Hz return became imperceptible once
 // the press had settled, even though quick clicks looked animated.
 const sortButton=await bounds('.studio-lens:nth-of-type(2)>button');
 const sx=sortButton.left+sortButton.width/2,sy=sortButton.top+sortButton.height/2;
 const pressure=async index=>Number((await evaluate("document.querySelector(\'.studio-candidate-canvas\').dataset.pressValues")).split(",")[index]);
 await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:sx,y:sy});
 await call("Input.dispatchMouseEvent",{type:"mousePressed",x:sx,y:sy,button:"left",clickCount:1});
 await sleep(850);
 let held=await pressure(1);
 // Headless WebGL may render slowly; allow one extra paint to settle.
 for(let retry=0;retry<8&&held<.96;retry++){
   await sleep(115);held=await pressure(1);
 }
 assert.ok(held>.96&&held<1.02,"Long hold must settle at full grown size, got "+held);
 await capture("01b-studio-long-hold.png");
 await call("Input.dispatchMouseEvent",{type:"mouseReleased",x:sx,y:sy,button:"left",clickCount:1});
 const releaseSamples=[];
 for(let i=0;i<11;i++){await sleep(50);releaseSamples.push(await pressure(1));}
 // Chrome/SwiftShader may skip the negative overshoot on screen when a
 // single WebGL draw costs longer than the half-period. The separate 120Hz
 // spring unit test asserts the negative overshoot deterministically; here
 // assert that pointer release works and actually returns to normal.
 assert.ok(releaseSamples.every(Number.isFinite),"Release yielded invalid values");
 assert.ok(releaseSamples.at(-1)<.055,"Held release must recover: "+releaseSamples.join(","));
 console.log("Observed WebGL release samples (frame-rate dependent):",releaseSamples.join(","));
 await sleep(300);
 assert.ok(Math.abs(await pressure(1))<.045,"Release must settle to exact normal size");
 await capture("01c-studio-long-hold-recovered.png");
 // Actions happen AFTER mouseup. A held Sort should not open its menu until released.
 assert.equal(await evaluate("document.querySelector('.lab-toolbar-v2-popover.is-sort').getAttribute('aria-hidden')"),"false");
 await sleep(220);
 assert.equal(await evaluate("document.querySelector('.studio-candidate-canvas').dataset.menuMaterial"),"studio");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.lab-toolbar-v2-popover.is-sort')).backgroundColor"),"rgba(0, 0, 0, 0)","Sorting menu must use Studio WebGL, not CSS background");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.lab-toolbar-v2-popover.is-sort')).backdropFilter"),"none","Sorting menu CSS blur must be disabled");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.lab-toolbar-v2-popover.is-sort')).transitionDuration"),"0s","Sort menu must have no open/close transition");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.lab-toolbar-v2-popover.is-sort')).transform"),"none","Sort menu must not translate/scale on open");
 assert.equal(await evaluate("Math.round(document.querySelector('.lab-toolbar-v2-popover.is-sort').getBoundingClientRect().width)"),260,"Preserve original V2 popup dimensions");
 assert.equal(await evaluate("document.querySelector('.lab-toolbar-v2-popover.is-sort .lab-toolbar-v2-menu-title').textContent"),"Sort by");
 await click('.lab-toolbar-v2-popover.is-sort .lab-toolbar-v2-menu-item:nth-of-type(3)');
 assert.equal(await evaluate("document.querySelector('.lab-toolbar-v2-popover.is-sort').getAttribute('aria-hidden')"),"true");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.lab-toolbar-v2-popover.is-sort')).visibility"),"hidden","Sort menu must disappear immediately on close");
 await click('.studio-lens:nth-of-type(2)>button');
 assert.equal(await evaluate("[...document.querySelectorAll('.lab-toolbar-v2-popover.is-sort .lab-toolbar-v2-menu-item')].find(x=>x.textContent==='BPM').getAttribute('aria-checked')"),"true");
 await click('.studio-lens:nth-of-type(2)>button');
 // Hold-and-release: verify press produces a rendered pixel change, not just an icon scaling.
 const target=await bounds(".studio-select>button"),x=target.left+target.width/2,y=target.top+target.height/2;
 await call("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
 await call("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});
 await sleep(190);
 await capture("02-studio-pressed.png");
 await call("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1});
 await sleep(580);
 await capture("03-studio-after-bounce.png");
 // Return Select to pill before checking its active -> circle transition.
 if(await evaluate("document.querySelector('.studio-select>button').getAttribute('aria-pressed')==='true'"))
  await click(".studio-select>button");
 await sleep(580);
 assert.ok((await bounds(".studio-select")).width>75,"Select failed to return to pill");
 await click(".studio-select>button");await sleep(620);
 const circleWidth=(await bounds(".studio-select")).width;
 console.log("Select circle width after 620ms:",circleWidth);
 assert.ok(Math.abs(circleWidth-44)<1,"Select morph did not end as circle; actual="+circleWidth);
 assert.equal(await evaluate("document.querySelector('.studio-select>button').getAttribute('aria-pressed')"),"true");
 await capture("04-studio-select-circle.png");
 await click(".studio-select>button");await sleep(620);
 assert.ok((await bounds(".studio-select")).width>75,"Select spring did not reverse");
 const searchClosed=await bounds(".studio-search");
 await click(".studio-search>button");await sleep(750);
 const searchOpen=await bounds(".studio-search");
 assert.ok(searchOpen.width>165,"Search circle did not morph");
 assert.ok(Math.abs(searchOpen.right-searchClosed.right)<1.5,"Search moved its right anchor");
 assert.ok(await evaluate("document.activeElement===document.querySelector('.studio-search input')"),"Search input not focused");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.studio-search input')).outlineStyle"),"none","Rectangular search focus outline leaked through");
 await capture("05-studio-search-open.png");
 // Expanded Search: whole pill grows uniformly about the 44px trigger center.
 const searchRightTrigger=await bounds('.studio-search>button');
 const tx=searchRightTrigger.left+searchRightTrigger.width*.5;
 const ty=searchRightTrigger.top+searchRightTrigger.height*.5;
 await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:tx,y:ty});
 await call("Input.dispatchMouseEvent",{type:"mousePressed",x:tx,y:ty,button:"left",clickCount:1});
 await sleep(420);
 assert.ok((await bounds(".studio-search")).width>165,"Expanded Search collapsed during press");
 assert.equal(await evaluate("document.querySelector('.studio-candidate-canvas').dataset.searchScaleAnchor"),"trigger-center");
 // SDF shader must use one single rounded rectangle: no separate cap.
 assert.equal(await evaluate("document.querySelector('.studio-candidate-canvas').dataset.geometry"),"studio-original-rounded-rect");
 assert.equal(await evaluate("document.querySelector(\'.studio-search>button\').offsetWidth"),44,"Search trigger layout must remain 44px while its icon scales visually");
 await capture("05a-studio-expanded-search-pressed.png");
 // With pointer capture, releasing outside would normally still click Search.
 // Reject that click and preserve its open state.
 await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:tx+110,y:ty+95,button:"left",buttons:1});
 await call("Input.dispatchMouseEvent",{type:"mouseReleased",x:tx+110,y:ty+95,button:"left",clickCount:1});
 await sleep(230);
 assert.equal(await evaluate("document.querySelector('.studio-search>button').getAttribute('aria-expanded')"),"true","Outside release toggled Search");
 assert.ok((await bounds(".studio-search")).width>165,"Outside release collapsed Search");
 await capture("05b-studio-search-outside-release.png");
 await click(".studio-search>button");await sleep(40);await click(".studio-search>button");
 await sleep(40);await click(".studio-search>button");
 // SwiftShader can render the 600px Studio pass slower than real-time. Check
 // the settled geometry, not a fixed wall-clock delay after three reversals.
 let reverseWidth=NaN;
 for(let retry=0;retry<32;retry++){
   await sleep(125);
   reverseWidth=(await bounds(".studio-search")).width;
   if(Math.abs(reverseWidth-44)<1.5)break;
 }
 assert.ok(Math.abs(reverseWidth-44)<1.5,"Rapid reverse left an intermediate size: "+reverseWidth);
 await click(".studio-lens:nth-of-type(2)>button");
 assert.equal(await evaluate("document.querySelector('.lab-toolbar-v2-popover.is-sort').getAttribute('aria-hidden')"),"false");
 // Release over blank stage after dragging out of Sort; no menu action.
 const sortDrop=await bounds('.studio-lens:nth-of-type(2)>button');
 const mx=sortDrop.left+sortDrop.width*.5,my=sortDrop.top+sortDrop.height*.5;
 await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:mx,y:my});
 await call("Input.dispatchMouseEvent",{type:"mousePressed",x:mx,y:my,button:"left",clickCount:1});
 await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:mx,y:my+150,button:"left",buttons:1});
 await call("Input.dispatchMouseEvent",{type:"mouseReleased",x:mx,y:my+150,button:"left",clickCount:1});
 await sleep(120);
 assert.equal(await evaluate("document.querySelector('.lab-toolbar-v2-popover.is-sort').getAttribute('aria-hidden')"),"false","Sort was toggled by outside release");
 // Profile must reuse V2 profile popover content and keyboard-friendly roles.
 await click('.studio-lens:nth-of-type(4)>button');
 assert.equal(await evaluate("document.querySelector('.lab-toolbar-v2-popover.is-profile').getAttribute('aria-hidden')"),"false");
 await sleep(220);
 assert.equal(await evaluate("document.querySelector('.studio-candidate-canvas').dataset.menuMaterial"),"studio");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.lab-toolbar-v2-popover.is-profile')).backgroundColor"),"rgba(0, 0, 0, 0)");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.lab-toolbar-v2-popover.is-profile')).transitionDuration"),"0s","Profile menu must have no open/close transition");
 assert.equal(await evaluate("getComputedStyle(document.querySelector('.lab-toolbar-v2-popover.is-profile')).transform"),"none","Profile menu must not scale on open");
 assert.equal(await evaluate("Math.round(document.querySelector('.lab-toolbar-v2-popover.is-profile').getBoundingClientRect().width)"),260);
 assert.equal(await evaluate("document.querySelector('.lab-toolbar-v2-popover.is-profile .lab-toolbar-v2-profile-name strong').textContent"),"Demo User");
 await click('.lab-toolbar-v2-popover.is-profile .lab-toolbar-v2-menu-item');
 assert.equal(await evaluate("document.querySelector('.lab-toolbar-v2-popover.is-profile').getAttribute('aria-hidden')"),"true");
 await click(".studio-candidate-theme button:nth-child(2)");
 await sleep(350);await capture("06-studio-light.png");
 assert.deepEqual(errors,[],"Browser runtime exceptions");
 console.log("Studio 44: WebGL compiled; press screenshots; two reversible spring morphs; no runtime exceptions.");
 console.log("Screenshots in",output);
}finally{
 ws?.close();vite.kill("SIGTERM");browser.kill("SIGTERM");
 await rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200}).catch(()=>{});
}
