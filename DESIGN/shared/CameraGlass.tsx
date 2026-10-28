import { useId, useState } from "react";
import "./camera-glass.css";

/**
 * Isolated material experiment. No production dependencies.
 * SVG displacement is applied to the backdrop, NOT to the camera glyph.
 */
export default function CameraGlass({size=72}:{size?:number}) {
  const [pressed,setPressed]=useState(false);
  const uid=useId().replace(/:/g,"");
  const filterId=`camera-glass-optics-${uid}`;
  return <button type="button" className={`camera-glass${pressed?" is-pressed":""}`}
    style={{"--camera-size":`${size}px`} as React.CSSProperties}
    aria-label={pressed?"Desactivar cámara de prueba":"Activar cámara de prueba"}
    aria-pressed={pressed} onClick={()=>setPressed(v=>!v)}>
    <svg className="camera-glass-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id={filterId} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".018" numOctaves="1" seed="3" result="map"/>
          <feDisplacementMap in="SourceGraphic" in2="map" scale="5" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
    </svg>
    <span className="camera-glass-lens" aria-hidden="true" style={{"--camera-filter":`url(#${filterId})`} as React.CSSProperties}/>
    <svg className="camera-glass-symbol" aria-hidden="true" viewBox="0 0 68 54" fill="currentColor">
      <path fillRule="evenodd" d="M13 8.5h8.3l3.3-4.2A7 7 0 0 1 30.1 1h8.2a7 7 0 0 1 5.5 2.7l3.8 4.8H55c7.2 0 11 3.8 11 11v21c0 7.2-3.8 11-11 11H13c-7.2 0-11-3.8-11-11v-21c0-7.2 3.8-11 11-11Zm21 8.2a13.4 13.4 0 1 0 0 26.8 13.4 13.4 0 0 0 0-26.8Zm0 5.5a7.9 7.9 0 1 1 0 15.8 7.9 7.9 0 0 1 0-15.8Zm20.1-8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/>
    </svg>
  </button>;
}
