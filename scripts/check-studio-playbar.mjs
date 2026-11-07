// Run against Vite: PLAYBAR_TEST_URL=http://127.0.0.1:4186 node scripts/check-studio-playbar.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const base = process.env.PLAYBAR_TEST_URL || 'http://127.0.0.1:4186';
const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const profile = await mkdtemp(path.join(tmpdir(), 'bg-playbar-'));
const browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-debugging-port=9238', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
try {
  let tab;
  for (let i = 0; i < 60; i++) {
    try { tab = (await (await fetch('http://127.0.0.1:9238/json')).json()).find(t => t.type === 'page'); } catch {}
    if (tab) break;
    await sleep(200);
  }
  assert.ok(tab, 'Chrome unavailable');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  const pending = new Map(); let id = 0;
  ws.addEventListener('message', e => {
    const r = JSON.parse(e.data), p = pending.get(r.id);
    if (p) { pending.delete(r.id); r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result); }
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, {resolve, reject}); ws.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const viewport = width => call('Emulation.setDeviceMetricsOverride', {width, height:900, deviceScaleFactor:1, mobile:false});
  const measure = () => evaluate(`(() => {
    const rect = s => {const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    return {bar:rect('.bg-playbar'), cover:rect('.bg-playbar-cover-slot > div'), text:rect('.bg-playbar-text-content'),
      track:rect('.bg-playbar-seek > div'), metadata:rect('.bg-playbar-text-content > div:nth-child(2)'), layout:document.querySelector('.bg-playbar').dataset.layout};
  })()`);
  await call('Page.enable'); await viewport(1440);
  await call('Page.navigate', {url:base+'/tests/visual/gallery.html?noWebgl=1'});
  for (let i=0;i<100;i++) {if(await evaluate('Boolean(document.querySelector(".bg-playbar"))')) break; await sleep(100);}
  assert.ok(await evaluate('Boolean(document.querySelector(".bg-playbar"))'), 'Player did not mount');
  await sleep(250);
  const wide = await measure();
  assert.equal(wide.layout,'wide'); assert.equal(wide.bar.height,68);
  assert.equal(wide.cover.width,48); assert.ok(Math.abs(wide.text.left-wide.cover.right-12)<1);
  assert.ok(wide.track.top-wide.metadata.bottom>=10);
  const results={wide};
  for (const width of [760,1440]) {
    await evaluate(`window.__frames=[]; window.__record=true; (function record(){const c=document.querySelector('.bg-playbar-cover-slot > div').getBoundingClientRect(),t=document.querySelector('.bg-playbar-text-content').getBoundingClientRect();window.__frames.push({gap:t.left-c.right,width:c.width});if(window.__record)requestAnimationFrame(record);})()`);
    await viewport(width); await sleep(350);
    const frames=await evaluate('window.__record=false;window.__frames');
    assert.ok(frames.length>=3);
    assert.ok(frames.every(f=>Math.abs(f.gap-12)<1.5),'Cover/text gap changed during morph');
    const m=await measure(); assert.equal(m.bar.height,68);
    assert.ok(Math.abs(m.cover.width-(width===760?36:48))<1);
    assert.ok(m.track.top-m.metadata.bottom>=10);
    if(width===760)assert.ok(Math.abs(m.track.left-m.cover.left)<1);
    results[width]=m;
  }
  // Stress reversing a transition and seek against the current rendered geometry.
  await viewport(760); await sleep(45); await viewport(1440); await sleep(45); await viewport(760); await sleep(250);
  let m=await measure(); assert.equal(m.layout,'narrow'); assert.ok(Math.abs(m.text.left-m.cover.right-12)<1);
  const x=m.track.left+m.track.width*.7,y=m.track.top+2;
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  await sleep(150);
  const fill=await evaluate(`parseFloat(document.querySelector('.bg-playbar-seek > div > div').style.width)`);
  assert.ok(Math.abs(fill-70)<1,'Real seek callback did not preserve ratio');
  await evaluate(`document.querySelector('button[title="Play"]').click()`);
  assert.ok(await evaluate(`Boolean(document.querySelector('button[title="Pause"]'))`),'Toggle disconnected');
  const oldName=await evaluate(`document.querySelector('.bg-playbar-text-content').textContent`);
  await evaluate(`document.querySelector('button[title="Next"]').click()`);
  assert.notEqual(await evaluate(`document.querySelector('.bg-playbar-text-content').textContent`),oldName,'Next disconnected');
  await viewport(360); await sleep(250); m=await measure();
  assert.equal(m.layout,'micro'); assert.equal(m.bar.height,68);
  assert.ok(m.track.width>0); assert.ok(m.bar.left>=0&&m.bar.right<=360);
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.bg-playbar-cover-slot > div')).transitionDuration`),'0s');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.bg-playbar-text-content')).transitionDuration`),'0s');
  console.log(JSON.stringify({passed:true,checks:['68px height','48/36px cover','12px gap through both transitions','reverse mid-morph','seek callback','play toggle','next','micro','reduced motion'],results}));
} finally {
  ws?.close(); browser.kill();
  await new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once('exit',resolve));
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
}

