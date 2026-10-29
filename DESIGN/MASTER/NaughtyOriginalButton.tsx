import {useEffect,useRef,useState} from "react";
// Official source copied unchanged into engines/naughtyduk/.
// @ts-ignore Upstream distributable is JS without a declaration file.
import liquidGL from "./engines/naughtyduk/liquidGL.js";

export default function NaughtyOriginalButton() {
  const root=useRef<HTMLDivElement>(null);
  const [status,setStatus]=useState<"loading"|"ready"|"error">("loading");
  useEffect(()=>{
    let destroyed=false;
    let lens:{destroy?:()=>void}|null=null;
    try{
      // Original library API, no replica shader and no custom mouse response.
      const instance=liquidGL({
        target:"#lab-original-liquidgl",
        content:"#lab-original-liquidgl > span",
        snapshot:"body",
        engine:"webgl2",
        resolution:1,
        refraction:.01,
        bevelDepth:.08,
        bevelWidth:.15,
        frost:0,
        specular:true,
        shadow:true,
        draggable:false,
        tilt:false,
        interaction:"none",
        on:{init:()=>{if(!destroyed)setStatus("ready")}}
      });
      lens=instance as {destroy?:()=>void};
      // Some versions initialise synchronously without a callback.
      requestAnimationFrame(()=>{if(!destroyed&&lens)setStatus("ready")});
    }catch(e){setStatus("error");console.error("Original NaughtyDuk liquidGL:",e)}
    return()=>{destroyed=true;lens?.destroy?.()};
  },[]);
  return <>
    <div ref={root} id="lab-original-liquidgl" className="glass-comparison-naughty-target"
      role="button" tabIndex={0} aria-label="Select, original liquidGL"
      data-engine-status={status}>
      <span>Select</span>
    </div>
    {status==="error"&&<span className="glass-comparison-engine-error">No se pudo iniciar liquidGL.</span>}
  </>;
}
