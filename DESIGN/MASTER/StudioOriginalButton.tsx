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

// Studio's shaders, uniforms, four-pass rendering pipeline and renderer are
// upstream originals. Expanding the #include directives replaces only their
// Vite GLSL plugin, which is unnecessary in the BeatGaler lab.
function shader(s:string) {
  return s.replace(/^#include ['"]\.\/lib\/(sdf|math|color)\.glsl['"]\s*$/gm,
    (_,name:string)=>({sdf,math,color}[name as "sdf"|"math"|"color"]));
}
function textureBackdrop(ctx:CanvasRenderingContext2D,w:number,h:number,x:number,y:number) {
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle="#151621";ctx.fillRect(0,0,w,h);
  ctx.save();ctx.translate(x,y);
  ctx.fillStyle="#ea76ae";ctx.fillRect(-240,-150,780,150);
  ctx.fillStyle="#b84f8a";ctx.fillRect(-240,0,780,18);
  ctx.fillStyle="#704fdf";ctx.fillRect(-240,210,780,95);
  ctx.fillStyle="#f4e8d6";ctx.font="bold 70px system-ui";ctx.fillText("GLASS", -110,162);
  ctx.font="bold 40px system-ui";ctx.fillStyle="#e6a7cb";
  ctx.fillText("123456", -110,240);
  for(let col=-20;col<10;col++){
    ctx.strokeStyle="rgba(255,255,255,.21)";ctx.lineWidth=1;
    const pos=col*46;ctx.beginPath();ctx.moveTo(pos,-350);ctx.lineTo(pos,650);ctx.stroke();
  }
  ctx.restore();
}

export default function StudioOriginalButton({offset}:{offset:{x:number,y:number}}) {
  const ref=useRef<HTMLCanvasElement>(null);
  const update=useRef<(x:number,y:number)=>void>(()=>{});
  const [error,setError]=useState("");
  useEffect(()=>{
    const canvas=ref.current;if(!canvas)return;
    let renderer:MultiPassRenderer|undefined;
    let texture:WebGLTexture|null=null;
    let observer:ResizeObserver|undefined;
    try{
      canvas.width=Math.max(200,Math.round(canvas.getBoundingClientRect().width));
      canvas.height=Math.max(200,Math.round(canvas.getBoundingClientRect().height));
      const gl=canvas.getContext("webgl2",{alpha:false});
      if(!gl)throw Error("Este navegador no ofrece WebGL2");
      renderer=new MultiPassRenderer(canvas,[
        {name:"bgPass",shader:{vertex,fragment:shader(bg)}},
        {name:"vBlurPass",shader:{vertex,fragment:blurV},inputs:{u_prevPassTexture:"bgPass"}},
        {name:"hBlurPass",shader:{vertex,fragment:blurH},inputs:{u_prevPassTexture:"vBlurPass"}},
        {name:"mainPass",shader:{vertex,fragment:shader(main)},
          inputs:{u_blurredBg:"hBlurPass",u_bg:"bgPass"},outputToScreen:true}
      ]);
      texture=gl.createTexture();if(!texture)throw Error("No se pudo crear la textura");
      const surface=document.createElement("canvas");
      const cx=surface.getContext("2d");if(!cx)throw Error("Sin Canvas2D");
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,1);
      const weights=Array(201).fill(0);weights[0]=.5;weights[1]=.25;
      const draw=(dx:number,dy:number)=>{
        if(!renderer||!texture)return;
        const w=canvas.width,h=canvas.height;
        surface.width=w;surface.height=h;
        textureBackdrop(cx,w,h,dx,dy);
        gl.viewport(0,0,w,h);
        gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,surface);
        renderer.setUniforms({
          u_resolution:[w,h],u_dpr:1,u_blurWeights:weights,u_blurRadius:1,
          u_mouse:[w/2,h/2],u_mouseSpring:[w/2,h/2],
          u_shapeWidth:150,u_shapeHeight:54,u_shapeRadius:23,u_shapeRoundness:5,
          u_mergeRate:.05,u_glareAngle:-Math.PI/4,u_showShape1:0,
        });
        renderer.render({
          bgPass:{u_bgType:3,u_bgTexture:texture,u_bgTextureReady:1,u_bgTextureRatio:w/h,
            u_shadowExpand:25,u_shadowFactor:.15,u_shadowPosition:[0,0]},
          mainPass:{u_tint:[1,1,1,.06],u_refThickness:20,
            u_refDistance:.05,u_refFactor:1.4,u_refDispersion:7,
            u_refFresnelRange:30,u_refFresnelHardness:.2,u_refFresnelFactor:.2,
            u_glareRange:30,u_glareHardness:.2,u_glareConvergence:.5,
            u_glareOppositeFactor:.8,u_glareFactor:.9,u_blurEdge:1,STEP:9}
        });
      };
      update.current=draw;
      observer=new ResizeObserver(()=>{
        const rect=canvas.getBoundingClientRect();
        const w=Math.max(200,Math.round(rect.width)),h=Math.max(200,Math.round(rect.height));
        if(w===canvas.width&&h===canvas.height)return;
        canvas.width=w;canvas.height=h;renderer?.resize(w,h);draw(0,0);
      });
      observer.observe(canvas);draw(0,0);
      canvas.dataset.engineReady="true";
    }catch(e){const message=e instanceof Error?e.message:String(e);setError(message);canvas.dataset.engineReady="error";console.error("Studio original shader:",e)}
    return()=>{observer?.disconnect();update.current=()=>{};if(texture)canvas.getContext("webgl2")?.deleteTexture(texture);renderer?.dispose()};
  },[]);
  useEffect(()=>{update.current(offset.x,offset.y)},[offset.x,offset.y]);
  return <div className="glass-comparison-studio-render">
    <canvas ref={ref} className="glass-comparison-studio-canvas" aria-label="Liquid Glass Studio, WebGL2 shader"/>
    <span className="glass-comparison-studio-label" aria-hidden="true">Select</span>
    {error&&<p className="glass-comparison-engine-error">WebGL Studio: {error}</p>}
  </div>;
}
