import {useEffect,useRef,useState} from "react";
import {MultiPassRenderer} from "./engines/studio/GLUtils";
import vertex from "./engines/studio/vertex.glsl?raw";
import bg from "./engines/studio/fragment-bg.glsl?raw";
import blurV from "./engines/studio/fragment-bg-vblur.glsl?raw";
import blurH from "./engines/studio/fragment-bg-hblur.glsl?raw";
import main from "./engines/studio/fragment-main.glsl?raw";
import sdf from "./engines/studio/lib/sdf.glsl?raw";
import math from "./engines/studio/lib/math.glsl?raw";
import color from "./engines/studio/lib/color.glsl?raw";
import presetText from "./studio-toolbar-44-original.json?raw";
import "./studio-exact-44.css";

// IMPORTANT: This diagnostic renders ONE static Studio shape, using Studio's
// ORIGINAL sdf.glsl, main fragment, background, blur shaders and GL renderer.
// Render on a 600 × 600px square, not the previous 780 × 280px viewport:
// the upstream normal amplitude depends on u_resolution.y.
// No toolbar SDF, no 43% white press mix, no animation or CSS filter.
// The upstream App converts shapeRadius (%) to pixels; the JSON stores 100,
// but the actual u_shapeRadius for a 44px circle is 22px.
const preset=JSON.parse(presetText).controls as {
  shapeWidth:number;shapeHeight:number;shapeRadius:number;shapeRoundness:number;
  showShape1:boolean;mergeRate:number;glareAngle:number;bgType:number;
  refThickness:number;refDistance:number;refFactor:number;refDispersion:number;
  refFresnelRange:number;refFresnelHardness:number;refFresnelFactor:number;
  glareRange:number;glareHardness:number;glareFactor:number;glareConvergence:number;
  glareOppositeFactor:number;blurRadius:number;blurEdge:boolean;
  tint:{r:number;g:number;b:number;a:number};
  shadowExpand:number;shadowFactor:number;shadowPosition:{x:number;y:number};
  step:number;
};

const EXPANSION=/^#include ['"]\.\/lib\/(sdf|math|color)\.glsl['"]\s*$/gm;
const include=(source:string)=>source.replace(EXPANSION,(_match:string,lib:string)=>
  lib==="sdf"?sdf:lib==="math"?math:color);

// Exact upstream helper from src/utils/index.ts (radius is an integer).
function computeGaussianKernelByRadius(radius:number){
  const sigma=radius/3.0,weights:number[]=[];
  let sum=0;
  for(let i=0;i<=radius;i++){
    const weight=Math.exp(-0.5*(i*i)/(sigma*sigma));
    weights.push(weight);
    sum+=i===0?weight:weight*2;
  }
  return weights.map(w=>w/sum);
}
const weights=computeGaussianKernelByRadius(preset.blurRadius);

function paintScene(ctx:CanvasRenderingContext2D,w:number,h:number,backgroundColor:string){
  // Flat RGB background: no image or decorative scene is required.
  // bgType 11 in Studio is the custom-texture slot; a solid-color canvas
  // is an exact texture representation of the selected color.
  ctx.fillStyle=backgroundColor;
  ctx.fillRect(0,0,w,h);
}
const presetShapeRadius=()=>Math.min(preset.shapeWidth,preset.shapeHeight)/2*preset.shapeRadius/100;

export default function StudioExact44(){
  const canvasRef=useRef<HTMLCanvasElement>(null);
  const colorRef=useRef("#26262b");
  const renderRef=useRef<()=>void>(()=>{});
  const [color,setColor]=useState("#26262b");
  const [error,setError]=useState("");
  const [ready,setReady]=useState(false);
  const changeColor=(value:string)=>{
    colorRef.current=value;setColor(value);renderRef.current();
  };
  useEffect(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    let gl:WebGL2RenderingContext|null=null;
    let renderer:MultiPassRenderer|undefined;
    let texture:WebGLTexture|null=null;
    let observer:ResizeObserver|undefined;
    let disposed=false;
    const backgroundCanvas=document.createElement("canvas");
    const ctx=backgroundCanvas.getContext("2d");
    if(!ctx){setError("Canvas2D no disponible");return;}
    try{
      canvas.width=2;canvas.height=2;
      gl=canvas.getContext("webgl2",{alpha:false,antialias:false});
      if(!gl)throw Error("WebGL2 no disponible");
      renderer=new MultiPassRenderer(canvas,[
        {name:"bgPass",shader:{vertex,fragment:include(bg)}},
        {name:"vBlurPass",shader:{vertex,fragment:blurV},inputs:{u_prevPassTexture:"bgPass"}},
        {name:"hBlurPass",shader:{vertex,fragment:blurH},inputs:{u_prevPassTexture:"vBlurPass"}},
        {name:"mainPass",shader:{vertex,fragment:include(main)},inputs:{
          u_blurredBg:"hBlurPass",u_bg:"bgPass"
        },outputToScreen:true}
      ]);
      texture=gl.createTexture();
      if(!texture)throw Error("No se pudo crear textura WebGL");
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,1);
      canvas.dataset.engineReady="true";
      setReady(true);
    }catch(e){
      setError(e instanceof Error?e.message:String(e));
      canvas.dataset.engineReady="error";
      renderer?.dispose();if(gl&&texture)gl.deleteTexture(texture);
      return;
    }
    const draw=()=>{
      if(disposed||!gl||!renderer||!texture)return;
      const rect=canvas.getBoundingClientRect();
      // Studio's default App canvasInfo.dpr is 1, not devicePixelRatio.
      const w=Math.max(2,Math.round(rect.width));
      const h=Math.max(2,Math.round(rect.height));
      if(canvas.width!==w||canvas.height!==h){
        canvas.width=w;canvas.height=h;renderer.resize(w,h);
      }
      if(backgroundCanvas.width!==w)backgroundCanvas.width=w;
      if(backgroundCanvas.height!==h)backgroundCanvas.height=h;
      paintScene(ctx,w,h,colorRef.current);
      gl.viewport(0,0,w,h);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,backgroundCanvas);
      renderer.setUniforms({
        u_resolution:[w,h],u_dpr:1,
        u_blurWeights:weights,u_blurRadius:preset.blurRadius,
        u_mouse:[w/2,h/2],u_mouseSpring:[w/2,h/2],
        u_shapeWidth:preset.shapeWidth,
        u_shapeHeight:preset.shapeHeight,
        u_shapeRadius:presetShapeRadius(),
        u_shapeRoundness:preset.shapeRoundness,
        u_mergeRate:preset.mergeRate,
        u_glareAngle:preset.glareAngle*Math.PI/180,
        u_showShape1:preset.showShape1?1:0
      });
      renderer.render({
        bgPass:{
          u_bgType:preset.bgType,
          u_bgTexture:texture,u_bgTextureReady:1,u_bgTextureRatio:w/h,
          u_shadowExpand:preset.shadowExpand,
          u_shadowFactor:preset.shadowFactor/100,
          u_shadowPosition:[-preset.shadowPosition.x,-preset.shadowPosition.y]
        },
        mainPass:{
          u_tint:[preset.tint.r/255,preset.tint.g/255,preset.tint.b/255,preset.tint.a],
          u_refThickness:preset.refThickness,
          u_refDistance:preset.refDistance,
          u_refFactor:preset.refFactor,
          u_refDispersion:preset.refDispersion,
          // ZERO is passed unchanged. Unlike the old Toolbar, this diagnostic
          // does not rewrite the shader to replace division by zero.
          u_refFresnelRange:preset.refFresnelRange,
          u_refFresnelHardness:preset.refFresnelHardness/100,
          u_refFresnelFactor:preset.refFresnelFactor/100,
          u_glareRange:preset.glareRange,
          u_glareHardness:preset.glareHardness/100,
          u_glareConvergence:preset.glareConvergence/100,
          u_glareOppositeFactor:preset.glareOppositeFactor/100,
          u_glareFactor:preset.glareFactor/100,
          u_blurEdge:preset.blurEdge?1:0,
          STEP:preset.step
        }
      });
      canvas.dataset.shapeRadiusPx=String(presetShapeRadius());
      canvas.dataset.backgroundColor=colorRef.current;
      canvas.dataset.surfaceSize=`${w}x${h}`;
      canvas.dataset.presetTimestamp="2026-11-02T23:59:40.405Z";
      canvas.dataset.shader="original";
    };
    renderRef.current=draw;
    observer=new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return()=>{
      disposed=true;observer?.disconnect();renderRef.current=()=>{};
      renderer?.dispose();if(gl&&texture)gl.deleteTexture(texture);
    };
  },[]);
  return <div className="studio-exact">
    <div className="studio-exact-controls">
      <span>STUDIO ORIGINAL · 44 × 44 · SIN ANIMACIÓN</span>
      <div className="studio-exact-options">
        <button type="button" onClick={()=>changeColor("#26262b")} aria-pressed={color==="#26262b"}>Oscuro</button>
        <button type="button" onClick={()=>changeColor("#e7e7e9")} aria-pressed={color==="#e7e7e9"}>Claro</button>
        <label className="studio-exact-color">
          <span>Color de fondo</span>
          <input type="color" value={color} aria-label="Color de fondo de Studio"
            onChange={e=>changeColor(e.currentTarget.value)}/>
          <code>{color.toUpperCase()}</code>
        </label>
      </div>
    </div>
    <div className="studio-exact-stage">
      <canvas ref={canvasRef} className="studio-exact-canvas" aria-label="Studio original WebGL2 44px estático"/>
      <span className={"studio-exact-icon "+(color==="#e7e7e9"?"is-dark":"")}
        aria-hidden="true">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none"
          stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9"/><circle cx="12" cy="9.1" r="2.6"/>
          <path d="M6.7 18.1c.4-2.8 2.4-4.3 5.3-4.3s4.9 1.5 5.3 4.3"/>
        </svg>
      </span>
      {error&&<p className="studio-exact-error" role="status">{error}</p>}
    </div>
    <p className="studio-exact-note">
      {ready?"Motor Studio original activo. ":""}
      El fondo es un color plano configurable, sin imágenes.
      Studio usa de forma predeterminada un lienzo de al menos 600 × 600 px;
      su cálculo de normales depende de la altura del lienzo.
      Selecciona el mismo color de fondo de Studio para compararlos.
    </p>
  </div>;
}
