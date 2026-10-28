import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { clamp, DEFAULT_SPRING, integrateGravity, inertialProjection, springStep, vectorForce } from "./physics";
import type { SpringAxis, Vec2 } from "./physics";
type Mode = "spring" | "repel" | "attract" | "inertia" | "gravity";
export const MOTION_MODES: { id: Mode; label: string; detail: string }[] = [
  { id: "spring", label: "Spring", detail: "Interruptible, velocity-aware return" },
  { id: "repel", label: "Repulsion", detail: "Distance-based spatial force" },
  { id: "attract", label: "Attraction", detail: "Soft magnetic cursor tracking" },
  { id: "inertia", label: "Inertia", detail: "Release-velocity projection" },
  { id: "gravity", label: "Gravity", detail: "Floor collision and damped bounce" },
];
export function MotionPlayground({ initial = "spring" }: { initial?: Mode }) {
  const [mode,setMode]=useState<Mode>(initial);
  const [stiffness,setStiffness]=useState(180);
  const [damping,setDamping]=useState(23);
  const [force,setForce]=useState(230);
  const [radius,setRadius]=useState(190);
  const [bounce,setBounce]=useState(.62);
  const [paused,setPaused]=useState(false);
  const [tick,setTick]=useState(0);
  const surface=useRef<HTMLDivElement>(null);
  const ball=useRef<HTMLDivElement>(null);
  const data=useRef<{x:SpringAxis;y:SpringAxis;target:Vec2;pointer:Vec2|null;drag:number|null;lastX:number;lastY:number;lastTime:number;velocity:Vec2;size:Vec2;origin:Vec2;started:boolean}>({
    x:{value:0,velocity:0},y:{value:0,velocity:0},target:{x:0,y:0},pointer:null,drag:null,lastX:0,lastY:0,lastTime:0,velocity:{x:0,y:0},size:{x:500,y:280},origin:{x:250,y:140},started:false
  });
  const reset=()=>{const d=data.current;d.x={value:d.origin.x,velocity:0};d.y={value:d.origin.y,velocity:0};d.target={...d.origin};d.pointer=null;d.drag=null;setTick(v=>v+1)};
  useEffect(()=>{const root=surface.current;if(!root)return;const resize=()=>{const rect=root.getBoundingClientRect();const d=data.current;d.size={x:rect.width,y:rect.height};d.origin={x:rect.width/2,y:rect.height/2};if(!d.started){d.x.value=d.origin.x;d.y.value=d.origin.y;d.target={...d.origin};d.started=true;}};resize();const observer=new ResizeObserver(resize);observer.observe(root);return()=>observer.disconnect()},[]);
  useEffect(()=>{
    const root=surface.current;const node=ball.current;if(!root||!node)return;
    const media=window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame=0;let previous=0;let reduced=media.matches;
    const draw=()=>{const d=data.current;node.style.transform=`translate3d(${d.x.value-30}px,${d.y.value-30}px,0)`;};
    const step=(time:number)=>{
      const d=data.current;const dt=Math.min((time-(previous||time))/1000,1/30);previous=time;
      if(!paused&&!reduced&&d.drag===null){
        let target={...d.origin};
        if(mode==="attract"||mode==="repel"){
          const center=d.pointer ?? d.origin;
          const sample={x:d.origin.x,y:d.origin.y};
          const f=vectorForce(sample,center,radius,force,mode==="attract"?"attract":"repel");
          target={x:sample.x+f.x,y:sample.y+f.y};
        } else if(mode==="inertia")target=d.target;
        if(mode==="gravity"){
          const value=integrateGravity({x:d.x.value,y:d.y.value},{x:d.x.velocity,y:d.y.velocity},dt,800,d.size.y-34,bounce);
          d.x={value:value.position.x,velocity:value.velocity.x};d.y={value:value.position.y,velocity:value.velocity.y};
        }else {
          const config={...DEFAULT_SPRING,stiffness,damping};
          d.x=springStep(d.x,target.x,dt,config);d.y=springStep(d.y,target.y,dt,config);
        }
      } else if(reduced&&d.drag===null){d.x.value=d.origin.x;d.y.value=d.origin.y;}
      draw();frame=requestAnimationFrame(step);
    };
    const change=()=>{reduced=media.matches;previous=0;if(reduced)reset()};
    media.addEventListener("change",change);frame=requestAnimationFrame(step);
    return()=>{cancelAnimationFrame(frame);media.removeEventListener("change",change)};
  },[mode,stiffness,damping,force,radius,bounce,paused,tick]);
  const point=(event:ReactPointerEvent<HTMLDivElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top}};
  const down=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.target!==ball.current)return;
    const p=point(event),d=data.current;d.drag=event.pointerId;d.lastX=p.x;d.lastY=p.y;d.lastTime=event.timeStamp;d.velocity={x:0,y:0};event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const p=point(event),d=data.current;d.pointer=p;
    if(d.drag!==event.pointerId)return;
    const dt=Math.max(.001,(event.timeStamp-d.lastTime)/1000);
    d.velocity={x:clamp((p.x-d.lastX)/dt,-1800,1800),y:clamp((p.y-d.lastY)/dt,-1800,1800)};
    d.x.value=clamp(d.x.value+p.x-d.lastX,30,d.size.x-30);
    d.y.value=clamp(d.y.value+p.y-d.lastY,30,d.size.y-30);
    d.x.velocity=d.velocity.x;d.y.velocity=d.velocity.y;d.lastX=p.x;d.lastY=p.y;d.lastTime=event.timeStamp;
  };
  const up=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const d=data.current;if(d.drag!==event.pointerId)return;
    d.drag=null;
    if(mode==="inertia"){d.target={x:clamp(inertialProjection(d.x.value,d.velocity.x),30,d.size.x-30),y:clamp(inertialProjection(d.y.value,d.velocity.y),30,d.size.y-30)}}
    else if(mode==="gravity"){d.y.velocity=Math.min(200,d.velocity.y);d.x.velocity=d.velocity.x;}
    try{event.currentTarget.releasePointerCapture(event.pointerId)}catch{/* capture already released */}
  };
  return <div className="ds-motion">
    <div className="ds-motion-modes" role="group" aria-label="Physics behavior">
      {MOTION_MODES.map(item=><button type="button" key={item.id} aria-pressed={mode===item.id} onClick={()=>{setMode(item.id);reset()}}>{item.label}</button>)}
    </div>
    <div className="ds-motion-stage" ref={surface} onPointerDown={down} onPointerMove={move} onPointerLeave={()=>{data.current.pointer=null}} onPointerUp={up} onPointerCancel={up}>
      <div className="ds-motion-crosshair" aria-hidden="true"/><div className="ds-motion-ball" ref={ball} role="slider" tabIndex={0} aria-label="Physics object. Drag or use arrow keys." aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100*data.current.x.value/Math.max(1,data.current.size.x))} onKeyDown={event=>{
        const d=data.current;const step=event.shiftKey?30:10;
        if(event.key==="ArrowRight"){d.x.value+=step;event.preventDefault()}
        if(event.key==="ArrowLeft"){d.x.value-=step;event.preventDefault()}
        if(event.key==="ArrowDown"){d.y.value+=step;event.preventDefault()}
        if(event.key==="ArrowUp"){d.y.value-=step;event.preventDefault()}
        d.x.value=clamp(d.x.value,30,d.size.x-30);d.y.value=clamp(d.y.value,30,d.size.y-30);d.target={...d.origin};
      }}>◉</div>
      <span className="ds-motion-stage-label">DRAG THE OBJECT · MOVE POINTER · ARROW KEYS</span>
    </div>
    <p className="ds-motion-caption">{MOTION_MODES.find(item=>item.id===mode)?.detail}. No fixed keyframes; motion is integrated frame by frame.</p>
    <div className="ds-motion-controls">
      {([["Stiffness",stiffness,setStiffness,50,450,10],["Damping",damping,setDamping,2,70,1],["Force",force,setForce,20,500,10],["Reach",radius,setRadius,80,350,10],["Bounce",Math.round(bounce*100),(n:number)=>setBounce(n/100),0,100,5]] as const).map(([label,value,change,min,max,step])=>
      <label key={label} className="ds-range-label"><span>{label}<strong>{value}</strong></span><input type="range" min={min} max={max} step={step} value={value} onChange={event=>change(Number(event.target.value))} /></label>)}
    </div>
    <div className="ds-motion-actions"><button type="button" onClick={reset}>Reset object</button><button type="button" aria-pressed={paused} onClick={()=>setPaused(v=>!v)}>{paused?"Resume":"Pause"}</button></div>
    <p className="ds-motion-code"><code>springStep · vectorForce · inertialProjection · integrateGravity</code> · <code>motion/physics.ts</code></p>
  </div>;
}
