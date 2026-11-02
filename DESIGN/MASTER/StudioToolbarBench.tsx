import {useEffect, useRef, useState} from "react";
import type {ReactNode, PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent} from "react";
import {MultiPassRenderer} from "./engines/studio/GLUtils";
import presetRaw from "./studio-preset-2026-11-02.json?raw";
import vertex from "./engines/studio/vertex.glsl?raw";
import bg from "./engines/studio/fragment-bg.glsl?raw";
import blurV from "./engines/studio/fragment-bg-vblur.glsl?raw";
import blurH from "./engines/studio/fragment-bg-hblur.glsl?raw";
import main from "./engines/studio/fragment-main.glsl?raw";
import sdf from "./engines/studio/lib/sdf.glsl?raw";
import math from "./engines/studio/lib/math.glsl?raw";
import color from "./engines/studio/lib/color.glsl?raw";
import "./studio-toolbar-bench.css";

/**
 * Isolated research specimen: original iyinchao GLSL + original four-pass renderer.
 * Optical preset is imported unchanged. Geometry and transient press experiments
 * are explicitly separated from the saved preset; none are approved product values.
 * No Gallery/ToolbarV1/ToolbarV2/src imports or calls.
 */
const cfg = JSON.parse(presetRaw).controls as {
  refThickness:number; refDistance:number; refFactor:number; refDispersion:number;
  refFresnelRange:number; refFresnelHardness:number; refFresnelFactor:number;
  glareRange:number; glareHardness:number; glareFactor:number;
  glareConvergence:number; glareOppositeFactor:number; glareAngle:number;
  blurRadius:number; blurEdge:boolean; tint:{r:number;g:number;b:number;a:number};
  shadowExpand:number; shadowFactor:number; shadowPosition:{x:number;y:number};
  shapeRoundness:number; mergeRate:number; showShape1:boolean; step:number;
};
type Variant = "original" | "geometry" | "depth" | "curvature";
type Backdrop = "art" | "dark" | "split";
type Kind = "search" | "sort" | "select" | "profile";
const variants: {key:Variant;label:string;detail:string}[] = [
  {key:"original",label:"A · Original",detail:"Sin modificación de pulsación: referencia estática"},
  {key:"geometry",label:"B · Geometría",detail:"Compresión SDF mínima; óptica del preset intacta"},
  {key:"depth",label:"C · Distancia",detail:"Geometría + desplazamiento refractivo y sombra transitorios"},
  {key:"curvature",label:"D · Curvatura",detail:"Geometría + perfil refractivo y sombra transitorios"}
];
function includeShaders(source:string) {
  return source.replace(/^#include ['"]\.\/lib\/(sdf|math|color)\.glsl['"]\s*$/gm,
    (_whole,name:string)=>({sdf,math,color}[name as "sdf"|"math"|"color"]));
}
function gaussian(radius:number) {
  const sigma=radius/3;
  const weights=Array.from({length:radius+1},(_,i)=>Math.exp(-.5*i*i/(sigma*sigma)));
  const sum=weights.reduce((total,w,i)=>total+(i?2:1)*w,0);
  return weights.map(w=>w/sum);
}
const weights=gaussian(cfg.blurRadius);

// Same 2D image is shown behind the controls and uploaded as the WebGL
// background. This demonstrates pixel alignment; it is NOT live DOM capture.
function paintBackground(canvas:HTMLCanvasElement,theme:Backdrop,offset:number) {
  const box=canvas.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  const width=Math.max(1,Math.round(box.width*dpr)),height=Math.max(1,Math.round(box.height*dpr));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const ctx=canvas.getContext("2d");
  if(!ctx)return;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=box.width,h=box.height;
  ctx.clearRect(0,0,w,h);
  const grad=ctx.createLinearGradient(0,0,w,h);
  if(theme==="dark"){grad.addColorStop(0,"#101116");grad.addColorStop(.6,"#363342");grad.addColorStop(1,"#080b13");}
  else if(theme==="split"){grad.addColorStop(0,"#ef9cbd");grad.addColorStop(.48,"#ef9cbd");grad.addColorStop(.48,"#11121c");grad.addColorStop(1,"#11121c");}
  else {grad.addColorStop(0,"#2c183e");grad.addColorStop(.48,"#e88db8");grad.addColorStop(.68,"#3e3b88");grad.addColorStop(1,"#171523");}
  ctx.fillStyle=grad;ctx.fillRect(0,0,w,h);
  ctx.save();
  ctx.translate(offset,0);
  ctx.fillStyle=theme==="dark"?"#59536e":"#d75085";
  ctx.fillRect(-500,100,w+1200,24);
  ctx.font="900 93px system-ui";ctx.fillStyle=theme==="dark"?"#bbb1d0":"#fff0e5";
  ctx.fillText("BEATGALER",28,181);
  ctx.font="700 43px system-ui";ctx.fillStyle="#e5cbff";ctx.fillText("0123456",w*.49,85);
  ctx.strokeStyle="rgba(255,255,255,.28)";ctx.lineWidth=1;
  for(let x=-700;x<w+700;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  ctx.restore();
}
function Glyph({kind}:{kind:Kind|"close"}) {
  const props={viewBox:"0 0 24 24",width:19,height:19,fill:"none",stroke:"currentColor",strokeWidth:1.85,
    strokeLinecap:"round" as const,strokeLinejoin:"round" as const,"aria-hidden":true as const};
  if(kind==="search")return <svg {...props}><circle cx="10.5" cy="10.5" r="6.3"/><path d="m15 15 5 5"/></svg>;
  if(kind==="sort")return <svg {...props}><path d="M3 6h18M3 12h12M3 18h7"/></svg>;
  if(kind==="profile")return <svg {...props}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="2.7"/><path d="M6.5 18c.5-2.8 2.5-4.2 5.5-4.2s5 1.4 5.5 4.2"/></svg>;
  return <svg {...props}><path d="M6 6 18 18M18 6 6 18"/></svg>;
}

type ChipProps={
  kind:Kind;variant:Variant;shape1:boolean;revision:number;
  stageRef:React.RefObject<HTMLDivElement>;backgroundRef:React.RefObject<HTMLCanvasElement>;
  expanded:boolean;children:ReactNode;
};
function GlassChip({kind,variant,shape1,revision,stageRef,backgroundRef,expanded,children}:ChipProps) {
  const host=useRef<HTMLDivElement>(null);
  const canvas=useRef<HTMLCanvasElement>(null);
  const [down,setDown]=useState(false);
  const [error,setError]=useState("");
  const animate=useRef<()=>void>(()=>{});
  const live=useRef({p:0,v:0,target:0,last:0});
  const latest=useRef({variant,shape1,expanded});
  latest.current={variant,shape1,expanded};
  live.current.target=down?1:0;

  useEffect(()=>{
    const el=canvas.current,anchor=host.current,backdrop=backgroundRef.current,stage=stageRef.current;
    if(!el||!anchor||!backdrop||!stage)return;
    let renderer:MultiPassRenderer|undefined,texture:WebGLTexture|null=null,frame=0,until=0,disposed=false;
    let gl:WebGL2RenderingContext|null=null;
    const source=document.createElement("canvas"),ctx=source.getContext("2d");
    const dpr=window.devicePixelRatio||1;
    try{
      if(!ctx)throw Error("Canvas2D no disponible");
      const rect=el.getBoundingClientRect();
      el.width=Math.round(rect.width*dpr);el.height=Math.round(rect.height*dpr);
      gl=el.getContext("webgl2",{alpha:false});
      if(!gl)throw Error("WebGL2 no disponible");
      renderer=new MultiPassRenderer(el,[
        {name:"bgPass",shader:{vertex,fragment:includeShaders(bg)}},
        {name:"vBlurPass",shader:{vertex,fragment:blurV},inputs:{u_prevPassTexture:"bgPass"}},
        {name:"hBlurPass",shader:{vertex,fragment:blurH},inputs:{u_prevPassTexture:"vBlurPass"}},
        {name:"mainPass",shader:{vertex,fragment:includeShaders(main)},
          inputs:{u_blurredBg:"hBlurPass",u_bg:"bgPass"},outputToScreen:true}
      ]);
      texture=gl.createTexture();
      if(!texture)throw Error("No se pudo crear textura");
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,1);
      source.width=el.width;source.height=el.height;
      el.dataset.engineReady="true";
    }catch(e){
      const msg=e instanceof Error?e.message:String(e);
      setError(msg);el.dataset.engineReady="error";
      renderer?.dispose();if(texture&&gl)gl.deleteTexture(texture);
      return;
    }
    const draw=(time:number)=>{
      if(disposed||!renderer||!gl||!texture||!ctx)return;
      const data=live.current;
      const dt=data.last?Math.min(.04,(time-data.last)/1000):.016;
      data.last=time;
      // Critical damping. 180ms is an existing lab motion token, not an
      // optical preset parameter. These are *experimental* comparison curves.
      const omega=4/.18;
      const acceleration=omega*omega*(data.target-data.p)-2*omega*data.v;
      data.v+=acceleration*dt;data.p+=data.v*dt;
      if(Math.abs(data.p-data.target)<.0002&&Math.abs(data.v)<.004){
        data.p=data.target;data.v=0;
      }
      const a=anchor.getBoundingClientRect(),b=el.getBoundingClientRect(),s=stage.getBoundingClientRect();
      if(a.width===0||b.width===0)return;
      ctx.clearRect(0,0,source.width,source.height);
      // Both canvases have the same DPR; sample the *exact* pixel region
      // underlying this control, including while its width is morphing.
      ctx.drawImage(backdrop,Math.round((s.left-b.left)*dpr),Math.round((s.top-b.top)*dpr));
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      const mode=latest.current.variant;
      const p=mode==="original"?0:data.p;
      // Deliberately labelled exploratory amplitudes; never persisted to preset.
      const scale=1-.025*p;
      const distance=cfg.refDistance*(mode==="depth"?(1-.25*p):mode==="curvature"?(1-.12*p):1);
      const thickness=cfg.refThickness*(mode==="curvature"?(1-.18*p):1);
      const shadow=cfg.shadowFactor*(mode==="depth"?(1-.4*p):mode==="curvature"?(1-.25*p):1);
      const cx=(a.left+a.width/2-b.left)*dpr;
      const cy=(b.bottom-a.top-a.height/2)*dpr;
      renderer.setUniforms({
        u_resolution:[el.width,el.height],u_dpr:dpr,u_mouse:[cx,cy],u_mouseSpring:[cx,cy],
        u_blurWeights:weights,u_blurRadius:cfg.blurRadius,
        u_shapeWidth:a.width*scale,u_shapeHeight:a.height*scale,
        u_shapeRadius:Math.min(a.width,a.height)*scale/2,
        u_shapeRoundness:cfg.shapeRoundness,u_mergeRate:cfg.mergeRate,
        u_glareAngle:cfg.glareAngle*Math.PI/180,
        u_showShape1:latest.current.shape1?1:0
      });
      renderer.render({
        bgPass:{u_bgType:11,u_bgTexture:texture,u_bgTextureReady:1,u_bgTextureRatio:el.width/el.height,
          u_shadowExpand:cfg.shadowExpand,u_shadowFactor:shadow/100,
          u_shadowPosition:[-cfg.shadowPosition.x,-cfg.shadowPosition.y]},
        mainPass:{
          u_tint:[cfg.tint.r/255,cfg.tint.g/255,cfg.tint.b/255,cfg.tint.a],
          u_refThickness:thickness,u_refDistance:distance,u_refFactor:cfg.refFactor,
          u_refDispersion:cfg.refDispersion,u_refFresnelRange:cfg.refFresnelRange,
          u_refFresnelHardness:cfg.refFresnelHardness/100,
          u_refFresnelFactor:cfg.refFresnelFactor/100,
          u_glareRange:cfg.glareRange,u_glareHardness:cfg.glareHardness/100,
          u_glareConvergence:cfg.glareConvergence/100,
          u_glareOppositeFactor:cfg.glareOppositeFactor/100,
          u_glareFactor:cfg.glareFactor/100,
          u_blurEdge:cfg.blurEdge?1:0,STEP:cfg.step
        }
      });
    };
    const tick=(time:number)=>{
      frame=0;draw(time);
      const data=live.current;
      if(time<until||Math.abs(data.p-data.target)>.0002||Math.abs(data.v)>.004){
        frame=requestAnimationFrame(tick);
      }
    };
    animate.current=()=>{
      if(disposed)return;
      until=performance.now()+380; // covers 180ms width transition + spring settling
      if(!frame)frame=requestAnimationFrame(tick);
    };
    animate.current();
    return()=>{
      disposed=true;
      cancelAnimationFrame(frame);
      animate.current=()=>{};
      if(gl&&texture)gl.deleteTexture(texture);
      renderer?.dispose();
    };
  },[stageRef,backgroundRef]);
  useEffect(()=>{animate.current();},[down,expanded,variant,shape1,revision]);
  const start=(e:ReactPointerEvent<HTMLDivElement>)=>{if(e.button===0)setDown(true);};
  const end=()=>setDown(false);
  const keyDown=(e:ReactKeyboardEvent<HTMLDivElement>)=>{
    if(e.target instanceof HTMLButtonElement&&(e.key==="Enter"||e.key===" "))setDown(true);
  };
  return <div ref={host} className={"sg-chip sg-"+kind+(expanded?" is-expanded":"")}
    data-variant={variant} data-pressed={down}
    onPointerDownCapture={start} onPointerUpCapture={end} onPointerCancelCapture={end}
    onPointerLeave={end} onKeyDownCapture={keyDown} onKeyUpCapture={end}>
    <div className="sg-optical-clip" aria-hidden="true"><canvas ref={canvas} className="sg-chip-canvas"/></div>
    <div className="sg-chip-content">{children}</div>
    {error&&<span className="sg-error">{error}</span>}
  </div>;
}
export default function StudioToolbarBench() {
  const stageRef=useRef<HTMLDivElement>(null),backgroundRef=useRef<HTMLCanvasElement>(null);
  const drag=useRef<{start:number;at:number}|null>(null);
  const [variant,setVariant]=useState<Variant>("original");
  const [theme,setTheme]=useState<Backdrop>("art");
  const [shape1,setShape1]=useState(false);
  const [offset,setOffset]=useState(0),[revision,setRevision]=useState(0);
  const [size,setSize]=useState(0);
  const [searchOpen,setSearchOpen]=useState(false),[search,setSearch]=useState("");
  const [selecting,setSelecting]=useState(false);
  const [menu,setMenu]=useState<"sort"|"profile"|null>(null);
  const [sort,setSort]=useState("Manual");
  useEffect(()=>{
    const root=stageRef.current;if(!root)return;
    const observer=new ResizeObserver(()=>setSize(v=>v+1));observer.observe(root);
    return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    const c=backgroundRef.current;if(!c)return;
    paintBackground(c,theme,offset);setRevision(v=>v+1);
  },[theme,offset,size]);
  useEffect(()=>{
    const esc=(e:KeyboardEvent)=>{if(e.key==="Escape"){setMenu(null);setSearchOpen(false);}};
    document.addEventListener("keydown",esc);
    return()=>document.removeEventListener("keydown",esc);
  },[]);
  const stageInput={variant,shape1,revision,stageRef,backgroundRef};
  return <div className="sg-bench" data-studio-toolbar-bench>
    <h2>Liquid Glass Studio · pruebas aisladas</h2>
    <p className="sg-caption">Preset original guardado sin cambios. A–D modifican únicamente la respuesta temporal al presionar. Cambia entre pruebas y mantén pulsado cada botón.</p>
    <div className="sg-variants" role="group" aria-label="Comparar respuestas de pulsación">
      {variants.map(item=><button key={item.key} type="button" aria-pressed={variant===item.key}
        onClick={()=>setVariant(item.key)}>{item.label}</button>)}
    </div>
    <p className="sg-detail">{variants.find(item=>item.key===variant)?.detail}</p>
    <div className="sg-settings">
      <label>Fondo <select value={theme} onChange={e=>setTheme(e.target.value as Backdrop)}>
        <option value="art">Color y tipografía</option>
        <option value="dark">Oscuro</option>
        <option value="split">Claro / oscuro</option>
      </select></label>
      <label className="sg-checkbox"><input type="checkbox" checked={shape1} onChange={e=>setShape1(e.target.checked)}/>
        Mostrar círculo extra del JSON</label>
    </div>
    <p className="sg-note">El JSON tiene showShape1=true (un círculo adicional de radio 100): para estas superficies de 44px empieza desactivado como <strong>adaptación geométrica explícita</strong>. Actívalo para comprobar el artefacto original. Los parámetros ópticos permanecen idénticos.</p>
    <div ref={stageRef} className="sg-stage" onWheel={e=>{if(e.ctrlKey)return;e.preventDefault();setOffset(v=>Math.max(-250,Math.min(250,v-e.deltaY*.6)));}}
      onPointerDown={e=>{
        if(e.button!==0||(e.target instanceof Element&&e.target.closest("button,input,select")))return;
        drag.current={start:e.clientX,at:offset};e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e=>{if(drag.current)setOffset(Math.max(-250,Math.min(250,drag.current.at+e.clientX-drag.current.start)));}}
      onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
      onPointerCancel={()=>{drag.current=null;}}>
      <canvas ref={backgroundRef} className="sg-background" aria-hidden="true"/>
      <div className={"sg-toolbar"+(searchOpen?" has-search":"")} role="group" aria-label="Toolbar experimental">
        <div className="sg-search-slot">
          <GlassChip kind="search" expanded={searchOpen} {...stageInput}>
            <input className="sg-search-field" type="search" placeholder="Search beats" aria-label="Search beats"
              tabIndex={searchOpen?0:-1} value={search} onChange={e=>setSearch(e.target.value)}/>
            <button type="button" className="sg-search-trigger" aria-label={searchOpen?"Close search":"Search beats"}
              aria-expanded={searchOpen} onClick={()=>{setMenu(null);setSearchOpen(v=>!v);}}>
              <Glyph kind="search"/>
            </button>
          </GlassChip>
        </div>
        <GlassChip kind="sort" expanded={false} {...stageInput}>
          <button type="button" aria-expanded={menu==="sort"} aria-haspopup="menu" aria-label="Sorting"
            onClick={()=>{setSearchOpen(false);setMenu(v=>v==="sort"?null:"sort");}}><Glyph kind="sort"/></button>
        </GlassChip>
        <GlassChip kind="select" expanded={!selecting} {...stageInput}>
          <button type="button" aria-pressed={selecting} aria-label={selecting?"Cancel selection":"Select beats"}
            onClick={()=>{setMenu(null);setSearchOpen(false);setSelecting(v=>!v);}}>
            <span className={"sg-select-label"+(selecting?" is-hidden":"")}>Select</span>
            <span className={"sg-select-cross"+(!selecting?" is-hidden":"")}><Glyph kind="close"/></span>
          </button>
        </GlassChip>
        <GlassChip kind="profile" expanded={false} {...stageInput}>
          <button type="button" aria-expanded={menu==="profile"} aria-haspopup="menu" aria-label="Profile"
            onClick={()=>{setSearchOpen(false);setMenu(v=>v==="profile"?null:"profile");}}><Glyph kind="profile"/></button>
        </GlassChip>
        {menu&&<div className="sg-popover" role="menu" aria-label={menu==="sort"?"Sorting":"Profile"}>
          {menu==="sort" ? ["Manual","Name","BPM","Stars","Date"].map(x=><button type="button" role="menuitemradio" aria-checked={sort===x}
            key={x} onClick={()=>{setSort(x);setMenu(null);}}>{x}{sort===x?" ✓":""}</button>)
            : <><strong>Demo User</strong><button type="button" role="menuitem" onClick={()=>setMenu(null)}>Settings</button><button type="button" role="menuitem" onClick={()=>setMenu(null)}>Log out</button></>}
        </div>}
      </div>
    </div>
    <p className="sg-caption">Arrastra el fondo o usa la rueda del mouse. Prueba Search y Select durante la transición; vuelve a pulsar antes de que termine. La demo refracta un fondo Canvas sincronizado, no el DOM de Gallery.</p>
    <p className="sg-note">Amplitudes transitorias experimentales: geometría −2.5%; distancia −25% (C) o −12% (D); espesor −18% (D); sombra −40% (C) o −25% (D). No son valores aprobados. Solo 1 variante activa; 4 contextos WebGL2 independientes. Sin shaders modificados ni efectos de presión permanentes.</p>
  </div>;
}
