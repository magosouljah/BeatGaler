import {useEffect,useRef,useState} from "react";
// Official runtime copied without modifications into engines/naughtyduk/.
// @ts-ignore Upstream distributable is JavaScript without TypeScript declarations.
import liquidGL from "./engines/naughtyduk/liquidGL.js";
type Engine={captureSnapshot?:()=>Promise<boolean>};
type Lens={destroy?:()=>void};

export default function NaughtyOriginalButton({offset}:{offset:{x:number;y:number}}) {
  const [status,setStatus]=useState<"loading"|"ready"|"error">("loading");
  const [selected,setSelected]=useState(false);
  const renderer=useRef<Engine|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const lastCapture=useRef(0);
  useEffect(()=>{
    let disposed=false;
    let lens:Lens|null=null;
    try{
      lens=liquidGL({
        target:"#lab-original-liquidgl",
        content:"#lab-original-liquidgl > span",
        snapshot:"#glass-comparison-naughty-stage",
        engine:"webgl2",resolution:2,refraction:.01,
        bevelDepth:.08,bevelWidth:.15,frost:0,specular:true,
        shadow:true,draggable:false,tilt:false,interaction:"none",
        on:{init:()=>{if(!disposed)setStatus("ready")}}
      }) as Lens;
      // This is NaughtyDuk's built-in dynamic DOM registration, not a new
      // optical implementation. Moving a CSS transform is not window scroll.
      liquidGL.registerDynamic("#glass-comparison-naughty-stage .glass-comparison-textured");
      renderer.current=(window as Window&{__liquidGLRenderer__?:Engine}).__liquidGLRenderer__||null;
      requestAnimationFrame(()=>{if(!disposed)setStatus("ready")});
    }catch(e){setStatus("error");console.error("NaughtyDuk liquidGL:",e)}
    return()=>{disposed=true;clearTimeout(timer.current);renderer.current=null;lens?.destroy?.()};
  },[]);
  useEffect(()=>{
    if(status!=="ready")return;
    // Refresh the original engine's DOM snapshot while scrolling/dragging.
    // Throttle captures; it will still update during interaction (~12fps).
    clearTimeout(timer.current);
    const delay=Math.max(0,82-(performance.now()-lastCapture.current));
    timer.current=setTimeout(()=>{
      lastCapture.current=performance.now();
      void renderer.current?.captureSnapshot?.();
    },delay);
    return()=>clearTimeout(timer.current);
  },[offset.x,offset.y,status]);
  const toggle=()=>setSelected(v=>!v);
  return <>
    <div id="lab-original-liquidgl" className="glass-comparison-naughty-target"
      role="button" tabIndex={0} aria-label="Select, original liquidGL"
      data-engine-status={status} aria-pressed={selected} onClick={toggle}
      onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();toggle()}}}>
      <span>{selected?"Selected":"Select"}</span>
    </div>
    {status==="error"&&<span className="glass-comparison-engine-error">No se pudo iniciar liquidGL.</span>}
  </>;
}
