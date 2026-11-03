// Browser smoke: fixed 24 real covers, multiple tags, shared cover mode, no ellipsis.
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const known=[
 process.env.PROGRAMFILES&&path.join(process.env.PROGRAMFILES,"Google","Chrome","Application","chrome.exe"),
 process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,"Google","Chrome","Application","chrome.exe")
].filter(Boolean).find(existsSync);
const chrome=process.env.CHROME_BIN||known||
 ["google-chrome","chromium","chromium-browser"].find(n=>spawnSync("which",[n]).status===0);
assert.ok(chrome,"Chrome required");
const folder=path.resolve("DESIGN/gallery-visual-check");
await mkdir(folder,{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),"beatgaler-gallery-"));
const vite=spawn(process.execPath,["node_modules/vite/bin/vite.js","--config",
 "DESIGN/vite.config.ts","--port","4192","--strictPort"],{stdio:"ignore"});
const browser=spawn(chrome,["--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--hide-scrollbars","--remote-debugging-port=9290","--remote-allow-origins=*",
 "--window-size=1440,1000","--user-data-dir="+profile,"about:blank"],{stdio:"ignore"});
let ws;
try{
 let ready=false,tab;
 for(let i=0;i<100;i++){
  try{if((await fetch("http://127.0.0.1:4192/")).ok){ready=true;break;}}catch{}
  if(vite.exitCode!==null)throw Error("Vite unexpectedly exited");
  await sleep(200);
 }
 assert.ok(ready,"Vite not available");
 for(let i=0;i<100;i++){
  try{tab=(await (await fetch("http://127.0.0.1:9290/json")).json()).find(x=>x.type==="page");if(tab)break;}catch{}
  if(browser.exitCode!==null)throw Error("Chrome unexpectedly exited");
  await sleep(200);
 }
 assert.ok(tab,"Chrome CDP not available");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 const waiting=new Map();let id=0;
 ws.addEventListener("message",e=>{
  const m=JSON.parse(e.data),p=waiting.get(m.id);
  if(p){waiting.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
 });
 await new Promise((res,rej)=>{ws.addEventListener("open",res,{once:true});ws.addEventListener("error",rej,{once:true});});
 const command=(method,params={})=>new Promise((resolve,reject)=>{
  const next=++id;waiting.set(next,{resolve,reject});ws.send(JSON.stringify({id:next,method,params}));
 });
 const expr=async expression=>{
  const r=await command("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
 };
 const until=async(expression,description)=>{
  for(let i=0;i<120;i++){if(await expr(expression))return;await sleep(125);}
  throw Error("Timed out: "+description);
 };
 const click=target=>expr("(()=>{const el="+target+";if(!el)throw Error('missing click target');el.click();return true;})()");
 const goMaster=()=>click("[...document.querySelectorAll('.lab-dev-switches button')].find(b=>b.textContent==='MASTER')");
 const goLanding=()=>click("[...document.querySelectorAll('.lab-dev-switches button')].find(b=>b.textContent==='Landing')");
 const goGallery=async()=>{
  await goLanding();await until("Boolean(document.querySelector('.lab-create'))","landing CTA");
  await click("document.querySelector('.lab-create')");
  await until("document.querySelectorAll('.lab-beat-tile').length===24","gallery 24 beats");
 };
 const screenshot=async name=>{
  const r=await command("Page.captureScreenshot",{format:"png",captureBeyondViewport:true});
  await writeFile(path.join(folder,name),Buffer.from(r.data,"base64"));
 };
 await command("Page.enable");await command("Runtime.enable");
 await command("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await command("Page.navigate",{url:"http://127.0.0.1:4192/"});
 await until("Boolean(document.querySelector('.lab-dev-switches'))","lab navigation");
 await goMaster();
 await until("Boolean(document.querySelector('.lab-master-cover-modes'))","MASTER cover switch");
 const order=await expr("(()=>{const s=document.querySelector('.lab-master-sidebar-nav').textContent;return s.indexOf('PORTADAS')<s.indexOf('REGLAS');})()");
 assert.ok(order,"PORTADAS should be above REGLAS");
 await click("document.querySelector('.lab-master-cover-modes button:nth-child(2)')");
 assert.equal(await expr("document.querySelector('.lab-master-cover-modes button:nth-child(2)').getAttribute('aria-pressed')"),"true");
 await goGallery();
 await until("document.querySelector('.studio-candidate.is-gallery .studio-candidate-canvas')?.dataset.engineReady==='true'","Gallery Studio WebGL ready");
 assert.equal(await expr("document.querySelector('.studio-candidate.is-gallery .studio-candidate-canvas').dataset.viewportHeight"),"600","Gallery glass must use original 600px optics");
 await expr("document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:24,clientY:8,bubbles:true}))");
 await until("document.querySelector('.lab-gallery-top-stack')?.dataset.tagsOpen==='true'","tag bar reveal");
 await sleep(360);
 const tagLayout=await expr(`(()=>{
   const surface=document.querySelector('.lab-gallery-tag-surface');
   const bar=document.querySelector('.lab-gallery-tag-bar');
   const toolbar=document.querySelector('.studio-candidate.is-gallery .studio-candidate-toolbar');
   const a=surface.getBoundingClientRect(),b=toolbar.getBoundingClientRect();
   return {surfaceTop:a.top,surfaceBottom:a.bottom,toolbarTop:b.top,
     contentWidth:bar.scrollWidth,viewportWidth:bar.clientWidth,barHeight:bar.clientHeight,
     surfaceBackground:getComputedStyle(surface).backgroundColor};
 })()`);
 assert.ok(Math.abs(tagLayout.surfaceTop-24)<=2,"Inset bar must use the approved 24px token");
 assert.ok(tagLayout.toolbarTop>=tagLayout.surfaceBottom+7,"Toolbar uses the 8px spacing token");
 assert.ok(tagLayout.contentWidth>tagLayout.viewportWidth*2,"Long horizontal tag navigation not overflowing");
 assert.equal(tagLayout.surfaceBackground,"rgb(12, 12, 12)","Tag strip must be solid black, not translucent");
 assert.ok(tagLayout.barHeight<=52,"Tag strip should remain compact");
 assert.ok(await expr("(()=>{const nav=document.querySelector('.lab-gallery-tag-surface').getBoundingClientRect();return nav.left>16&&nav.right<innerWidth-16;})()"),"Tag strip is centered within Gallery, not full bleed");
 assert.ok(tagLayout.barHeight<80,"Tag navigation must remain a single row");
 assert.ok(await expr("(()=>{const a=document.querySelector('.lab-gallery-tag-all').getBoundingClientRect(),b=document.querySelector('.lab-gallery-tag-wrap').getBoundingClientRect();return b.left-a.right<20;})()"),"Compact tag spacing");
 const scrollResult=await expr(`(()=>{
   const bar=document.querySelector('.lab-gallery-tag-bar');
   bar.dispatchEvent(new WheelEvent('wheel',{deltaY:210,bubbles:true,cancelable:true}));
   return {left:bar.scrollLeft,edge:bar.className};
 })()`);
 assert.ok(scrollResult.left>0,"Vertical wheel must drive the horizontal scroller");
 const edgeWheel=await expr(`(()=>{
   const el=document.querySelector('.lab-gallery-tag-bar');el.scrollLeft=el.scrollWidth;
   const before=window.scrollY;
   const accepted=el.dispatchEvent(new WheelEvent('wheel',{deltaY:800,bubbles:true,cancelable:true}));
   return {accepted,before,after:window.scrollY};
 })()`);
 assert.equal(edgeWheel.accepted,false,"Wheel must be consumed at the horizontal end");
 assert.equal(edgeWheel.after,edgeWheel.before,"Wheel must not bleed into vertical scrolling");
 await expr("document.querySelector('.lab-gallery-tag-bar').scrollLeft=0");
 // Far-right selected tag should reorder immediately after All, without losing All.
 await expr("document.querySelector('.lab-gallery-tag-bar').scrollLeft=1200");
 const preservedScroll=await expr("document.querySelector('.lab-gallery-tag-bar').scrollLeft");
 await click("document.querySelector('.lab-gallery-tag[aria-label^=\"BoomBap:\"]')");
 assert.ok(await expr("document.querySelector('.lab-gallery-tag-track').children[1]?.textContent==='BoomBap'"),"Selected tag must move after All");
 assert.ok(Math.abs(await expr("document.querySelector('.lab-gallery-tag-bar').scrollLeft")-preservedScroll)<=2,"Far tag must move without moving the viewport");
 await click("document.querySelector('.lab-gallery-tag-all')");
 const tiles=await expr("[...document.querySelectorAll('.lab-beat-tile')].map(t=>({name:t.querySelector('.lab-beat-tile__title').textContent,tags:[...t.querySelectorAll('.lab-beat-tile__tag')].map(x=>x.textContent),cover:t.querySelector('.lab-artwork img').src}))");
 assert.equal(tiles.length,24);
 assert.equal(new Set(tiles.map(t=>t.name)).size,24);
 assert.ok(tiles.every(t=>/^[a-z]+$/i.test(t.name)));
 assert.ok(tiles.every(t=>t.tags.length>=3&&t.tags.length<=6));
 assert.ok([4,5].every(n=>tiles.some(t=>t.tags.length===n)));
 assert.equal(new Set(tiles.map(t=>t.cover)).size,24);
 assert.ok(tiles.every(t=>/\/real-covers\/cover-\d{2}\.(jpg|avif)/.test(t.cover)));
 assert.equal(await expr("document.querySelectorAll('.lab-tag-color-trigger').length"),0);
 await until("[...document.querySelectorAll('.lab-beat-tile .lab-artwork img')].every(i=>i.complete&&i.naturalWidth>0)","real cover image loads");
 await screenshot("gallery-24-real.png");
 // Right-click on a tag opens its color editor without a visible three-dot
 // control. Both the top filter and every beat using the tag must update.
 await expr(`(()=>{
   const chip=document.querySelector('.lab-gallery-tag-bar button[aria-label^="Ambient:"]');
   return chip.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,button:2}));
 })()`);
 await until("Boolean(document.querySelector('.lab-tag-color-popover'))","tag color palette");
 assert.equal(await expr("document.querySelectorAll('.lab-tag-color-trigger').length"),0);
 await click("document.querySelector('.lab-tag-color-swatches button[aria-label=\"Purple\"]')");
 assert.equal(await expr("getComputedStyle(document.querySelector('.lab-gallery-tag-bar button[aria-label^=\"Ambient:\"]')).getPropertyValue('--lab-tag-color').trim()"),"#AF52DE");
 assert.ok(await expr("[...document.querySelectorAll('.lab-beat-tile__tag')].filter(e=>e.textContent==='Ambient').every(e=>getComputedStyle(e).color==='rgb(175, 82, 222)')"));
 assert.equal(await expr("document.querySelectorAll('.lab-tag-color-popover').length"),0);

 const ambient="document.querySelector('.lab-gallery-tag-bar button[aria-label^=\"Ambient:\"]')";
 const beforeWidth=await expr(ambient+".offsetWidth");
 const nextOffsetBefore=await expr("document.querySelector('.lab-gallery-tag-bar button[aria-label^=\"Trap:\"]').parentElement.offsetLeft");
 await click(ambient);
 assert.equal(await expr(ambient+".offsetWidth"),beforeWidth,"Bold included tag must retain its hitbox width");
 assert.equal(await expr("document.querySelector('.lab-gallery-tag-bar button[aria-label^=\"Trap:\"]').parentElement.offsetLeft"),nextOffsetBefore,"Selection weight must not push adjacent tags");
 const count=await expr("document.querySelectorAll('.lab-beat-tile').length");
 assert.ok(count>0&&count<24,"Ambient inclusion should filter");
 await click(ambient);
 assert.equal(await expr("document.querySelectorAll('.lab-beat-tile').length"),24,"Plain click must toggle inclusion off, not cycle to exclusion");
 await expr('(()=>{const el='+ambient+';el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,altKey:true}));return true;})()');
 assert.ok(await expr("[...document.querySelectorAll('.lab-beat-tile')].every(t=>![...t.querySelectorAll('.lab-beat-tile__tag')].some(e=>e.textContent==='Ambient'))"),"Alt+click must exclude Ambient across multi-tag beats");
 assert.ok(await expr("(()=>{const c=getComputedStyle("+ambient+").color;return c!==\"rgb(255, 255, 255)\"&&c!==\"rgb(244, 244, 244)\";})()"),"Excluded colored tag must keep its tint instead of turning white");
 await expr('(()=>{const el='+ambient+';el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,altKey:true}));return true;})()');
 assert.equal(await expr("document.querySelectorAll('.lab-beat-tile').length"),24,"Second Alt+click clears exclusion");
 await expr("document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:24,clientY:8,bubbles:true}))");
 await click(ambient);
 await expr("document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:720,clientY:460,bubbles:true}))");
 await sleep(1200);
 assert.equal(await expr("document.querySelector('.lab-gallery-top-stack').dataset.tagsOpen"),"true","Active filters must keep the bar open");
 await click(ambient);
 await until("document.querySelector('.lab-gallery-top-stack').dataset.tagsOpen==='false'","bar hides after clearing final filter");
 await goMaster();
 await until("Boolean(document.querySelector('.lab-master-cover-modes'))","MASTER revisit");
 await click("document.querySelector('.lab-master-tag-modes button:nth-child(2)')");
 assert.equal(await expr("document.querySelector('.lab-master-tag-modes button:nth-child(2)').getAttribute('aria-pressed')"),"true");
 await click("document.querySelector('.lab-master-cover-modes button:nth-child(1)')");
 await goGallery();
 await until("document.querySelectorAll('.lab-beat-tile .lab-artwork img').length===24","generated covers");
 assert.equal(await expr("document.querySelector('.lab-gallery-top-stack').dataset.tagVariant"),"playbar");
 assert.ok(await expr("Boolean(document.querySelector('.lab-gallery-playbar-frame .lab-playbar-seek--preview'))"),"Gallery reuses MASTER Player");
 await expr("document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:24,clientY:8,bubbles:true}))");
 await until("document.querySelector('.lab-gallery-top-stack').dataset.tagsOpen==='true'","material reveal");
 await sleep(350);
 assert.equal(await expr("getComputedStyle(document.querySelector('.lab-gallery-tag-surface')).backgroundColor"),"rgba(20, 20, 20, 0.75)");
 const generated=await expr("[...document.querySelectorAll('.lab-beat-tile .lab-artwork img')].map(i=>i.src)");
 assert.ok(generated.every(x=>x.startsWith("data:image/")),"Generated mode should use local bg-v1");
 assert.equal(new Set(generated).size,24);
 await screenshot("gallery-24-generated.png");
 // Desktop hide and reveal: the toolbar must return to the same top margin.
 await expr("document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:720,clientY:460,bubbles:true}))");
 await until("document.querySelector('.lab-gallery-top-stack')?.dataset.tagsOpen==='false'","tag bar auto-hide after delay");
 await sleep(340);
 const collapsed=await expr("document.querySelector('.studio-candidate.is-gallery .studio-candidate-toolbar').getBoundingClientRect().top");
 assert.ok(collapsed>=12&&collapsed<50,"Collapsed Toolbar should return to its top margin");
 await expr("window.scrollTo(0,480)");
 await sleep(120);
 assert.ok(await expr("document.querySelector('.lab-gallery-top-stack').getBoundingClientRect().top>=0"),"Tag Bar remains viewport-ready for hover");
 assert.ok(await expr("(()=>{const y=document.querySelector('.studio-candidate.is-gallery .studio-candidate-toolbar').getBoundingClientRect().top;return y>=12&&y<=50;})()"),"Studio Toolbar must stay floating");
 await expr("window.scrollTo(0,0)");
 assert.ok(await expr("document.querySelector('.lab-gallery-item').getBoundingClientRect().top<120"),"Gallery covers must begin after only the toolbar, without reserving the hidden tag strip");
 // Small screens keep a 600px optical viewport and do not overlap the tags.
 await command("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await expr("document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:8,clientY:6,bubbles:true}))");
 await until("document.querySelector('.lab-gallery-top-stack')?.dataset.tagsOpen==='true'","mobile bar visible");
 await sleep(350);
 const readMobile=()=>expr(`(()=>{
   const nav=document.querySelector('.lab-gallery-tag-surface').getBoundingClientRect();
   const toolbar=document.querySelector('.studio-candidate.is-gallery .studio-candidate-toolbar').getBoundingClientRect();
   const glass=document.querySelector('.studio-candidate.is-gallery .studio-candidate-canvas');
   const scroller=document.querySelector('.lab-gallery-tag-bar');
   return {gap:toolbar.top-nav.bottom,navWidth:nav.width,screenWidth:innerWidth,
     sceneHeight:glass.height,scrollable:scroller.scrollWidth>scroller.clientWidth};
 })()`);
 let mobile=await readMobile();
 // On CI SwiftShader, WebGL work can delay CSS frames. Wait until the
 // interruptible grid transition has actually reached its final spacing.
 for(let i=0;i<24&&mobile.gap<10;i++){
   await sleep(120);
   mobile=await readMobile();
 }
 console.log("Mobile Gallery layout:",mobile);
 assert.ok(mobile.gap>=7,"Mobile toolbar must remain below the tag bar: "+JSON.stringify(mobile));
 assert.ok(mobile.navWidth<mobile.screenWidth,"Mobile strip retains inset margins");
 assert.equal(mobile.sceneHeight,600,"Mobile glass must preserve the 600px Studio scale");
 assert.ok(mobile.scrollable,"Mobile horizontal tag scroll must remain usable");
 await screenshot("gallery-mobile-tags.png");
 // Hover from a deeply scrolled Gallery must still reveal the inset bar.
 await expr("window.scrollTo(0,480)");
 await expr("document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:280,clientY:8,bubbles:true}))");
 await until("document.querySelector('.lab-gallery-top-stack').dataset.tagsOpen==='true'","deep-scroll reveal");
 await sleep(300);
 assert.ok(await expr("document.querySelector('.lab-gallery-top-stack').getBoundingClientRect().top>=0"),"Tags reappear at viewport top");
 assert.ok(await expr("document.querySelector('.lab-gallery-tag-cue')===null"),"Hint only appears before the first reveal");
 await screenshot("gallery-inset-deep-scroll.png");
 await expr("window.scrollTo(0,0)");
 console.log("Gallery verified: inset hover on deep scroll, beat-aligned Studio, one-shot hint and horizontal scroll.");
}finally{
 ws?.close();vite.kill("SIGTERM");browser.kill("SIGTERM");
 await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
