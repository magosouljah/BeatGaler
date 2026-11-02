import {useCallback,useEffect,useRef,useState} from "react";
import type {KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent} from "react";
import {MultiPassRenderer} from "./engines/studio/GLUtils";
import vertex from "./engines/studio/vertex.glsl?raw";
import bg from "./engines/studio/fragment-bg.glsl?raw";
import blurV from "./engines/studio/fragment-bg-vblur.glsl?raw";
import blurH from "./engines/studio/fragment-bg-hblur.glsl?raw";
import main from "./engines/studio/fragment-main.glsl?raw";
import math from "./engines/studio/lib/math.glsl?raw";
import color from "./engines/studio/lib/color.glsl?raw";
import shape from "./studio-toolbar-shape.glsl?raw";
import presetText from "./studio-toolbar-44.json?raw";
import "./studio-toolbar.css";

type Kind="search"|"sort"|"profile"|"close";
type Menu="sort"|"profile"|null;
type Theme="dark"|"light";
type Spring={x:number,v:number,target:number};
const makeSpring=(x:number):Spring=>({x,v:0,target:x});
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const preset=JSON.parse(presetText).controls as {
  refThickness:number;refDistance:number;refFactor:number;refDispersion:number;
  refFresnelRange:number;refFresnelHardness:number;refFresnelFactor:number;
  glareRange:number;glareHardness:number;glareFactor:number;glareConvergence:number;
  glareOppositeFactor:number;glareAngle:number;blurRadius:number;blurEdge:boolean;
  tint:{r:number;g:number;b:number;a:number};shadowExpand:number;
  shadowFactor:number;shadowPosition:{x:number;y:number};step:number;
};
const options=["Manual","Name","BPM","Stars","Date"] as const;
function integrate(s:Spring,dt:number,frequency:number,damping:number){
  const omega=2*Math.PI*frequency;
  // Substep the oscillator to keep velocity continuous on rapid reversal.
  const steps=Math.max(1,Math.ceil(dt/.008)),step=dt/steps;
  for(let i=0;i<steps;i++){
    s.v+=(omega*omega*(s.target-s.x)-2*damping*omega*s.v)*step;
    s.x+=s.v*step;
  }
  if(Math.abs(s.x-s.target)<.0004&&Math.abs(s.v)<.012){s.x=s.target;s.v=0;}
}
const moving=(s:Spring)=>Math.abs(s.x-s.target)>.0005||Math.abs(s.v)>.012;
function include(source:string){
  return source.replace(/^#include ['"]\.\/lib\/(sdf|math|color)\.glsl['"]\s*$/gm,
    (_all:string,name:string)=>name==="sdf"?shape:name==="math"?math:color);
}
// Studio's custom Fresnel range may legitimately be 0; the denominator must
// be guarded in this derived shader. The preset remains byte-for-byte separate.
const opticalShader=include(main)
  .replace(/500\.0\s*\/\s*u_refFresnelRange/g,"500.0 / max(u_refFresnelRange, 0.001)")
  .replace("fragColor = outColor;",
    "if (merged < 0.0) { float pressure = nearestPress(gl_FragCoord.xy/u_dpr);"+
    "outColor.rgb = mix(outColor.rgb, vec3(1.0), .43*pressure); }"+
    "fragColor = outColor;");
function gaussianWeights(radius:number){
  const sigma=Math.max(.001,radius/3);
  const a=Array.from({length:radius+1},(_,i)=>Math.exp(-.5*i*i/(sigma*sigma)));
  const sum=a.reduce((t,v,i)=>t+v*(i===0?1:2),0);
  return a.map(x=>x/sum);
}
const blurWeights=gaussianWeights(preset.blurRadius);
function paintBackground(canvas:HTMLCanvasElement,theme:Theme,w:number,h:number,dpr:number){
  const ctx=canvas.getContext("2d");if(!ctx)return;
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const width=w/dpr,height=h/dpr;
  ctx.fillStyle=theme==="dark"?"#26262b":"#e7e7e9";
  ctx.fillRect(0,0,width,height);
  // Plain page surface, intentionally not an asset attached to the glass.
  ctx.fillStyle=theme==="dark"?"#303037":"#d5d5d9";
  ctx.fillRect(0,height*.62,width,height*.38);
  ctx.fillStyle=theme==="dark"?"#383840":"#c9c9ce";
  ctx.fillRect(0,height*.62,width,1);
  ctx.fillStyle=theme==="dark"?"#65656c":"#9b9ba3";
  ctx.font="500 13px system-ui,sans-serif";
  ctx.fillText("BEATGALER",24,height-20);
}
function Glyph({kind}:{kind:Kind}){
  const p={viewBox:"0 0 24 24",width:19,height:19,fill:"none",
    stroke:"currentColor",strokeWidth:1.85,strokeLinecap:"round" as const,
    strokeLinejoin:"round" as const,"aria-hidden":true as const};
  switch(kind){
    case "search":return <svg {...p}><circle cx="10.7" cy="10.7" r="6.4"/><path d="m15.4 15.4 5.2 5.2"/></svg>;
    case "sort":return <svg {...p}><path d="M3.6 6h16.8M3.6 12h11.6M3.6 18h6.4"/></svg>;
    case "profile":return <svg {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="9.1" r="2.6"/><path d="M6.7 18.1c.4-2.8 2.4-4.3 5.3-4.3s4.9 1.5 5.3 4.3"/></svg>;
    case "close":return <svg {...p}><path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/></svg>;
  }
}

export default function StudioToolbarCandidate(){
  const stage=useRef<HTMLDivElement>(null);
  const display=useRef<HTMLCanvasElement>(null);
  const controls=useRef<(HTMLDivElement|null)[]>([]);
  const toolbar=useRef<HTMLDivElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const pressSprings=useRef(Array.from({length:4},()=>makeSpring(0)));
  const morphSprings=useRef({search:makeSpring(44),select:makeSpring(78)});
  const animate=useRef<()=>void>(()=>{});
  const searchOpenRef=useRef(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const [search,setSearch]=useState("");
  const [selecting,setSelecting]=useState(false);
  const [menu,setMenu]=useState<Menu>(null);
  const [sort,setSort]=useState<(typeof options)[number]>("Manual");
  const [theme,setTheme]=useState<Theme>("dark");
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  searchOpenRef.current=searchOpen;

  const press=useCallback((index:number,down:boolean)=>{
    pressSprings.current[index].target=down?1:0;animate.current();
  },[]);
  const handlers=(index:number)=>({
    onPointerDown:(e:ReactPointerEvent<HTMLButtonElement>)=>{
      if(e.button!==0)return;
      e.currentTarget.setPointerCapture(e.pointerId);
      press(index,true);
    },
    onPointerUp:(e:ReactPointerEvent<HTMLButtonElement>)=>{
      press(index,false);
      if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onPointerCancel:()=>press(index,false),
    onKeyDown:(e:ReactKeyboardEvent<HTMLButtonElement>)=>{
      if(!e.repeat&&(e.key==="Enter"||e.key===" "))press(index,true);
    },
    onKeyUp:()=>press(index,false),
    onBlur:()=>press(index,false)
  });

  useEffect(()=>{
    const query=window.matchMedia("(prefers-reduced-motion: reduce)");
    const update=()=>animate.current();
    query.addEventListener("change",update);
    return()=>query.removeEventListener("change",update);
  },[]);
  useEffect(()=>{
    if(searchOpen)input.current?.focus({preventScroll:true});
    morphSprings.current.search.target=searchOpen
      ?Math.min(278,Math.max(170,(stage.current?.clientWidth||700)-190)):44;
    animate.current();
  },[searchOpen]);
  useEffect(()=>{morphSprings.current.select.target=selecting?44:78;animate.current();},[selecting]);
  useEffect(()=>{
    const outside=(e:PointerEvent)=>{if(!toolbar.current?.contains(e.target as Node)){setMenu(null);setSearchOpen(false);}};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"){setMenu(null);setSearchOpen(false);}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[]);

  useEffect(()=>{
    const host=stage.current,canvas=display.current;
    if(!host||!canvas)return;
    let gl:WebGL2RenderingContext|null=null;
    let renderer:MultiPassRenderer|undefined,texture:WebGLTexture|null=null;
    let frame=0,disposed=false,last=0,needsBackground=true;
    let sceneTheme:Theme="dark";
    const source=document.createElement("canvas");
    try{
      canvas.width=2;canvas.height=2;
      gl=canvas.getContext("webgl2",{alpha:false,antialias:false});
      if(!gl)throw Error("WebGL2 no disponible");
      renderer=new MultiPassRenderer(canvas,[
        {name:"bgPass",shader:{vertex,fragment:include(bg)}},
        {name:"vBlurPass",shader:{vertex,fragment:blurV},inputs:{u_prevPassTexture:"bgPass"}},
        {name:"hBlurPass",shader:{vertex,fragment:blurH},inputs:{u_prevPassTexture:"vBlurPass"}},
        {name:"mainPass",shader:{vertex,fragment:opticalShader},
          inputs:{u_blurredBg:"hBlurPass",u_bg:"bgPass"},outputToScreen:true}
      ]);
      texture=gl.createTexture();
      if(!texture)throw Error("Error al crear textura");
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,1);
      canvas.dataset.engineReady="true";
    }catch(e){
      const msg=e instanceof Error?e.message:String(e);
      setError(msg);canvas.dataset.engineReady="error";
      renderer?.dispose();if(gl&&texture)gl.deleteTexture(texture);
      return;
    }
    const tick=(now:number)=>{
      frame=0;
      if(disposed||!gl||!texture||!renderer)return;
      const dt=last?Math.min(.04,(now-last)/1000):.016;last=now;
      const reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      for(const s of pressSprings.current){
        if(reduce){s.x=s.target;s.v=0;}
        else integrate(s,dt,s.target>s.x?7.0:6.0,.56);
      }
      const motion=morphSprings.current;
      for(const s of [motion.search,motion.select]){
        if(reduce){s.x=s.target;s.v=0;}
        else integrate(s,dt,4.9,.79);
      }
      if(controls.current[0])controls.current[0]!.style.width=Math.max(44,motion.search.x)+"px";
      if(controls.current[2])controls.current[2]!.style.width=Math.max(44,motion.select.x)+"px";
      const stageRect=host.getBoundingClientRect();
      const dpr=Math.min(2,window.devicePixelRatio||1);
      const w=Math.max(2,Math.round(stageRect.width*dpr));
      const h=Math.max(2,Math.round(stageRect.height*dpr));
      if(w!==canvas.width||h!==canvas.height){
        canvas.width=w;canvas.height=h;renderer.resize(w,h);needsBackground=true;
      }
      if(needsBackground){
        paintBackground(source,sceneTheme,w,h,dpr);
        gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
        needsBackground=false;
      }
      const shapes:number[]=[],waves:number[]=[],pressures:number[]=[];
      for(let i=0;i<4;i++){
        const rect=controls.current[i]?.getBoundingClientRect();
        if(!rect){shapes.push(-500,-500,1,1);waves.push(0,0);pressures.push(0);continue;}
        shapes.push(rect.left-stageRect.left+rect.width*.5,
          stageRect.bottom-rect.top-rect.height*.5,rect.width,rect.height);
        const morphSpeed=i===0?motion.search.v:i===2?motion.select.v:0;
        waves.push(reduce?0:clamp(morphSpeed*.0035,-2.6,2.6),
          reduce?0:clamp(pressSprings.current[i].v*.18,-1.8,1.8));
        pressures.push(pressSprings.current[i].x);
      }
      gl.viewport(0,0,w,h);
      renderer.setUniforms({
        u_resolution:[w,h],u_dpr:dpr,u_lenses:shapes,u_waves:waves,
        u_presses:pressures,u_blurWeights:blurWeights,u_blurRadius:preset.blurRadius,
        u_shapeWidth:44,u_shapeHeight:44,u_shapeRadius:22,u_shapeRoundness:2,
        u_mergeRate:0,u_showShape1:0,u_mouse:[0,0],u_mouseSpring:[0,0],
        u_glareAngle:preset.glareAngle*Math.PI/180
      });
      renderer.render({
        bgPass:{u_bgType:11,u_bgTexture:texture,u_bgTextureReady:1,
          u_bgTextureRatio:w/h,u_shadowExpand:preset.shadowExpand,
          u_shadowFactor:preset.shadowFactor/100,
          u_shadowPosition:[preset.shadowPosition.x,preset.shadowPosition.y]},
        mainPass:{u_tint:[preset.tint.r/255,preset.tint.g/255,preset.tint.b/255,preset.tint.a],
          u_refThickness:preset.refThickness,u_refDistance:preset.refDistance,
          u_refFactor:preset.refFactor,u_refDispersion:preset.refDispersion,
          u_refFresnelRange:preset.refFresnelRange,
          u_refFresnelHardness:preset.refFresnelHardness/100,
          u_refFresnelFactor:preset.refFresnelFactor/100,
          u_glareRange:preset.glareRange,u_glareHardness:preset.glareHardness/100,
          u_glareFactor:preset.glareFactor/100,u_glareConvergence:preset.glareConvergence/100,
          u_glareOppositeFactor:preset.glareOppositeFactor/100,
          u_blurEdge:preset.blurEdge?1:0,STEP:preset.step}
      });
      if([...pressSprings.current,motion.search,motion.select].some(moving))
        frame=requestAnimationFrame(tick);
    };
    animate.current=()=>{if(!frame)frame=requestAnimationFrame(tick);};
    const observer=new ResizeObserver(()=>{
      if(searchOpenRef.current)morphSprings.current.search.target=Math.min(278,Math.max(170,host.clientWidth-190));
      needsBackground=true;animate.current();
    });
    observer.observe(host);
    const themeListener=(e:Event)=>{
      const next=(e as CustomEvent<Theme>).detail;
      if(next!==sceneTheme){sceneTheme=next;needsBackground=true;animate.current();}
    };
    host.addEventListener("studio-theme",themeListener);
    animate.current();
    return()=>{
      disposed=true;cancelAnimationFrame(frame);observer.disconnect();
      host.removeEventListener("studio-theme",themeListener);
      animate.current=()=>{};renderer?.dispose();
      if(gl&&texture)gl.deleteTexture(texture);
    };
  },[]);
  useEffect(()=>{stage.current?.dispatchEvent(new CustomEvent("studio-theme",{detail:theme}));},[theme]);

  return <div className="studio-candidate" data-studio-candidate>
    <div className="studio-candidate-controls">
      <span>LIQUID GLASS STUDIO · 44 PX</span>
      <div className="studio-candidate-theme" role="group" aria-label="Fondo de prueba">
        <button type="button" aria-pressed={theme==="dark"} onClick={()=>setTheme("dark")}>Oscuro</button>
        <button type="button" aria-pressed={theme==="light"} onClick={()=>setTheme("light")}>Claro</button>
      </div>
    </div>
    <div ref={stage} className={"studio-candidate-stage is-"+theme} data-glass-engine={error?"fallback":"studio"}>
      <canvas ref={display} className="studio-candidate-canvas" aria-label="Studio WebGL2 lenses"/>
      <div ref={toolbar} className="studio-candidate-toolbar" role="group" aria-label="Toolbar Studio">
        <div className="studio-candidate-search-slot">
          <div ref={node=>{controls.current[0]=node;}}
            className={"studio-lens studio-search"+(searchOpen?" is-open":"")}>
            <input ref={input} type="search" aria-label="Search beats" placeholder="Search beats"
              tabIndex={searchOpen?0:-1} value={search} onChange={e=>setSearch(e.target.value)}/>
            <button type="button" aria-label={searchOpen?"Close search":"Search beats"}
              aria-expanded={searchOpen}
              onClick={()=>{setMenu(null);setSearchOpen(v=>!v);}}
              {...handlers(0)}><Glyph kind="search"/></button>
          </div>
        </div>
        <div ref={node=>{controls.current[1]=node;}} className="studio-lens">
          <button type="button" aria-label="Sort beats" aria-haspopup="menu" aria-expanded={menu==="sort"}
            onClick={()=>{setSearchOpen(false);setMenu(v=>v==="sort"?null:"sort");}}
            {...handlers(1)}><Glyph kind="sort"/></button>
        </div>
        <div ref={node=>{controls.current[2]=node;}}
          className={"studio-lens studio-select"+(selecting?" is-selecting":"")}>
          <button type="button" aria-pressed={selecting}
            aria-label={selecting?"Cancel selection":"Select beats"}
            onClick={()=>{setSearchOpen(false);setMenu(null);setSelecting(v=>!v);}}
            {...handlers(2)}>
            <span className="studio-select-label">Select</span>
            <span className="studio-select-x"><Glyph kind="close"/></span>
          </button>
        </div>
        <div ref={node=>{controls.current[3]=node;}} className="studio-lens">
          <button type="button" aria-label="Profile" aria-haspopup="menu" aria-expanded={menu==="profile"}
            onClick={()=>{setSearchOpen(false);setMenu(v=>v==="profile"?null:"profile");}}
            {...handlers(3)}><Glyph kind="profile"/></button>
        </div>
        {menu&&<div className="studio-candidate-menu" role="menu" aria-label={menu==="sort"?"Sort beats":"Profile"}>
          {menu==="sort"
            ? options.map(option=><button key={option} type="button" role="menuitemradio"
                aria-checked={sort===option} onClick={()=>{setSort(option);setMenu(null);}}>
                {option}{sort===option?" ✓":""}</button>)
            : <><strong>Demo User</strong>{["Settings","Log out"].map(action=>
                <button key={action} type="button" role="menuitem" onClick={()=>{
                  setMessage(action+" · demo");setMenu(null);
                }}>{action}</button>)}</>}
        </div>}
      </div>
      {error&&<div className="studio-candidate-error" role="status">Studio: {error}. Se muestra fallback.</div>}
      {message&&<div className="studio-candidate-message" role="status">{message}</div>}
    </div>
    <p className="studio-candidate-hint">Mantén pulsado cualquier botón y suéltalo para probar el rebote. Search y Select tienen otro resorte más sutil; prueba invertir el morph antes de que termine.</p>
  </div>;
}
