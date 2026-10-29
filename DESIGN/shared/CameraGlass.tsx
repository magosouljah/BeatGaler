import { useState } from "react";
import GlassButton from "./GlassButton";

/** Original approved camera specimen. Its optical stack now lives in GlassButton. */
export default function CameraGlass({size=72}:{size?:number}) {
 const [pressed,setPressed]=useState(false);
 return <GlassButton size={size} pressed={pressed}
   aria-label={pressed?"Desactivar cámara de prueba":"Activar cámara de prueba"}
   aria-pressed={pressed} onClick={()=>setPressed(v=>!v)}>
   <svg className="camera-glass-symbol" aria-hidden="true" viewBox="0 0 68 54" fill="currentColor">
     <path fillRule="evenodd" d="M13 8.5h8.3l3.3-4.2A7 7 0 0 1 30.1 1h8.2a7 7 0 0 1 5.5 2.7l3.8 4.8H55c7.2 0 11 3.8 11 11v21c0 7.2-3.8 11-11 11H13c-7.2 0-11-3.8-11-11v-21c0-7.2 3.8-11 11-11Zm21 8.2a13.4 13.4 0 1 0 0 26.8 13.4 13.4 0 0 0 0-26.8Zm0 5.5a7.9 7.9 0 1 1 0 15.8 7.9 7.9 0 0 1 0-15.8Zm20.1-8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/>
   </svg>
 </GlassButton>;
}
