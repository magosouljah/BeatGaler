import {test} from "node:test";
import assert from "node:assert/strict";
import {makeSpring,advanceSpring,PRESS_GROW,PRESS_RELEASE,MORPH_SPRING} from "./MASTER/studio-toolbar-spring.ts";
function run(s,seconds,config,step=1/120){for(let t=0;t<seconds;t+=step)advanceSpring(s,Math.min(step,seconds-t),config);}
test("hold grows progressively without overshoot, remains fully expanded",()=>{
 const s=makeSpring(0);s.target=1;
 run(s,.08,PRESS_GROW);assert.ok(s.x>.20&&s.x<.65,"growth should not jump instantly");
 run(s,1.8,PRESS_GROW);assert.ok(Math.abs(s.x-1)<.002&&Math.abs(s.v)<.015);
});
test("release after a long hold under-shoots and returns to zero with bounce",()=>{
 const s=makeSpring(0);s.target=1;run(s,1.5,PRESS_GROW);
 s.target=0;const samples=[];
 for(let t=0;t<.9;t+=1/120){advanceSpring(s,1/120,PRESS_RELEASE);samples.push(s.x);}
 assert.ok(Math.min(...samples)<-.1,"full hold MUST show a visible elastic return");
 assert.ok(samples.some((v,i)=>i>40&&v>0),"return needs smaller counter-oscillation");
 assert.ok(Math.abs(s.x)<.01,"return should settle on original 44px size");
});
test("short click preserves velocity; morph retargets without discontinuity",()=>{
 const s=makeSpring(0);s.target=1;run(s,.07,PRESS_GROW);
 const last=s.x,velocity=s.v;s.target=0;
 assert.equal(s.x,last);assert.equal(s.v,velocity);
 advanceSpring(s,.016,PRESS_RELEASE);assert.ok(Number.isFinite(s.x));
 const m=makeSpring(44);m.target=200;run(m,.06,MORPH_SPRING);
 const before=m.x;m.target=44;assert.equal(m.x,before);
 run(m,1,MORPH_SPRING);assert.ok(Math.abs(m.x-44)<.05);
});
test("spring is independent of frame subdivision",()=>{
 const a=makeSpring(1),b=makeSpring(1);a.target=0;b.target=0;
 advanceSpring(a,.42,PRESS_RELEASE);run(b,.42,PRESS_RELEASE,1/120);
 assert.ok(Math.abs(a.x-b.x)<.00001);
 assert.ok(Math.abs(a.v-b.v)<.00001);
});
