// Independent Chrome CDP smoke test for the isolated Studio optical variants.
// Run from repository root: node DESIGN/studio-toolbar-browser-check.mjs
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const windowsPaths=[
  process.env.PROGRAMFILES&&path.join(process.env.PROGRAMFILES,"Google","Chrome","Application","chrome.exe"),
  process.env["PROGRAMFILES(X86)"]&&path.join(process.env["PROGRAMFILES(X86)"],"Google","Chrome","Application","chrome.exe"),
  process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,"Google","Chrome","Application","chrome.exe")
].filter(Boolean);
const chrome=process.env.CHROME_BIN ||
 (process.platform==="win32"?windowsPaths.find(existsSync):
  ["google-chrome","chromium","chromium-browser"].find(x=>spawnSync("which",[x]).status===0));
assert.ok(chrome,"Chrome/Chromium not found. Set CHROME_BIN to its executable path.");
const output=path.resolve("DESIGN/studio-toolbar-screenshots");
await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),"beatgaler-studio-"));
const vite=spawn(process.execPath,["node_modules/vite/bin/vite.js","--config","DESIGN/vite.config.ts","--port","4186","--strictPort"],{stdio:"ignore"});
const browser=spawn(chrome,[
  "--headless=new","--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader",
  "--remote-debugging-port=9256","--remote-allow-origins=*",
  "--window-size=1440,1050","--user-data-dir="+profile,"about:blank"
],{stdio:"ignore"});
let ws;
try{
  let tab=null;
  for(let i=0;i<120;i++){try{if((await fetch("http://127.0.0.1:4186/")).ok)break;}catch{}await sleep(250);}
  for(let i=0;i<120;i++){try{tab=(await (await fetch("http://127.0.0.1:9256/json")).json()).find(x=>x.type==="page");if(tab)break;}catch{}await sleep(250);}
  assert.ok(tab,"Chromium CDP unavailable");
  ws=new WebSocket(tab.webSocketDebuggerUrl);
  const pending=new Map();let serial=0;
  ws.addEventListener("message",event=>{
    const m=JSON.parse(event.data);const p=pending.get(m.id);
    if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
  });
  await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
  });
  const read=async expression=>{
    const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const bounds=selector=>read("(()=>{const r=document.querySelector("+JSON.stringify(selector)+").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:r.width,height:r.height};})()");
  const click=selector=>read("document.querySelector("+JSON.stringify(selector)+").click()");
  const shot=async name=>{
    const r=await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    await writeFile(path.join(output,name),Buffer.from(r.data,"base64"));
  };
  const errors=[];ws.addEventListener("message",ev=>{
    const m=JSON.parse(ev.data);if(m.method==="Runtime.exceptionThrown")errors.push(m.params.exceptionDetails.text);
  });
  await call("Page.enable");await call("Runtime.enable");
  await call("Page.navigate",{url:"http://127.0.0.1:4186/"});
  for(let i=0;i<100;i++){if(await read("Boolean(document.querySelector('.lab-dev-switches'))"))break;await sleep(100);}
  await read("[...document.querySelectorAll('.lab-dev-switches button')].find(b=>b.textContent==='MASTER').click()");
  await sleep(350);
  await read("[...document.querySelectorAll('.lab-master-sidebar-nav button')].find(b=>b.textContent==='Glass · Studio Bench').click()");
  for(let i=0;i<100;i++){if(await read("document.querySelectorAll('.sg-chip-canvas[data-engine-ready=true]').length===4"))break;await sleep(150);}
  const statuses=await read("[...document.querySelectorAll('.sg-chip-canvas')].map(x=>x.dataset.engineReady)");
  assert.deepEqual(statuses,["true","true","true","true"],"WebGL Studio surfaces not ready");
  await read("document.querySelector('.sg-stage').scrollIntoView({block:'center'})");
  await sleep(550);
  assert.equal(await read("document.querySelectorAll('.sg-chip').length"),4);
  for(const variant of ["original","geometry","depth","curvature"]){
    await read("document.querySelector('.sg-variants button[aria-pressed=false]:not([disabled])') !== null");
    await read("[...document.querySelectorAll('.sg-variants button')].find(x=>x.textContent.startsWith("+JSON.stringify(
       variant==="original"?"A":variant==="geometry"?"B":variant==="depth"?"C":"D")+")).click()");
    await sleep(320);
    await shot(variant+"-rest.png");
    const el=await bounds(".sg-select .sg-chip-content button");
    const x=el.left+el.width/2,y=el.top+el.height/2;
    await call("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
    await call("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});
    await sleep(140);
    assert.equal(await read("document.querySelector('.sg-select').dataset.pressed"),"true","Press state not registered");
    await shot(variant+"-pressed.png");
    await call("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1});
    await sleep(330);
  }
  const closed=await bounds(".sg-search-slot .sg-chip");
  await click(".sg-search-trigger");
  await sleep(360);
  const open=await bounds(".sg-search-slot .sg-chip");
  assert.ok(open.width>180,"Search failed to morph to pill");
  assert.ok(Math.abs(open.right-closed.right)<2,"Search right anchor moved");
  assert.ok(await read("document.activeElement===document.querySelector('.sg-search-field')"),"Search input not focused");
  await shot("search-open.png");
  await click(".sg-search-trigger");await sleep(40);await click(".sg-search-trigger");
  await sleep(40);await click(".sg-search-trigger");await sleep(360);
  assert.ok(Math.abs((await bounds(".sg-search-slot .sg-chip")).width-44)<1,"Search reversal failed");
  const before=await bounds(".sg-select");
  await click(".sg-select button");await sleep(360);
  const after=await bounds(".sg-select");
  assert.ok(before.width>70&&Math.abs(after.width-44)<1,"Select pill-to-circle failed");
  await shot("select-circle.png");
  await click(".sg-select button");await sleep(360);
  assert.ok((await bounds(".sg-select")).width>70,"Select return failed");
  await read("document.querySelector('.sg-settings select').value='split';document.querySelector('.sg-settings select').dispatchEvent(new Event('change',{bubbles:true}))");
  await sleep(270);await shot("split-background.png");
  assert.deepEqual(errors,[],"Uncaught browser errors");
  console.log("Studio bench smoke test passed: four live shader surfaces and four visual response variants.");
  console.log("Screenshots:",output);
}finally{
  ws?.close();
  vite.kill("SIGTERM");browser.kill("SIGTERM");
  await rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200}).catch(()=>{});
}
