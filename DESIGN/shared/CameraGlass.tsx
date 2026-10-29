import { useId, useState } from "react";
import "./camera-glass.css";

/**
 * Isolated material experiment. No production dependencies.
 * Very light SVG displacement is applied to the backdrop, NOT to the camera glyph.
 */
export default function CameraGlass({size=72}:{size?:number}) {
  const [pressed,setPressed]=useState(false);
  const uid=useId().replace(/:/g,"");
  const filterId=`camera-glass-optics-${uid}`;
  const topEdgeId=`camera-edge-upper-${uid}`;
  const bottomEdgeId=`camera-edge-lower-${uid}`;
  const softEdgeId=`camera-edge-soft-${uid}`;
  return <button type="button" className={`camera-glass${pressed?" is-pressed":""}`}
    style={{"--camera-size":`${size}px`} as React.CSSProperties}
    aria-label={pressed?"Desactivar cámara de prueba":"Activar cámara de prueba"}
    aria-pressed={pressed} onClick={()=>setPressed(v=>!v)}>
    <svg className="camera-glass-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id={filterId} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".018" numOctaves="1" seed="3" result="map"/>
          <feDisplacementMap in="SourceGraphic" in2="map" scale="1.5" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
    </svg>
    <span className="camera-glass-lens" aria-hidden="true" style={{"--camera-filter":`url(#${filterId})`} as React.CSSProperties}/>
    {/* One vector contour with localized light: a sharp core and a soft halo.
        The arcs fade to zero before they end; there is no 360° border. */}
    <svg className="camera-glass-edge" viewBox="0 0 112 112" aria-hidden="true" focusable="false" fill="none">
      <defs>
        <linearGradient id={topEdgeId} x1="4.5" y1="75" x2="79" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" stopOpacity="0"/>
          <stop offset=".20" stopColor="white" stopOpacity=".17"/>
          <stop offset=".56" stopColor="white" stopOpacity=".72"/>
          <stop offset=".82" stopColor="white" stopOpacity=".34"/>
          <stop offset="1" stopColor="white" stopOpacity="0"/>
        </linearGradient>
        <linearGradient id={bottomEdgeId} x1="108" y1="39" x2="39" y2="107" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" stopOpacity="0"/>
          <stop offset=".43" stopColor="white" stopOpacity=".10"/>
          <stop offset=".74" stopColor="white" stopOpacity=".38"/>
          <stop offset="1" stopColor="white" stopOpacity="0"/>
        </linearGradient>
        <filter id={softEdgeId} x="-8%" y="-8%" width="116%" height="116%">
          <feGaussianBlur stdDeviation=".55"/>
        </filter>
      </defs>
      <path d="M 4.46 74.76 A 54.85 54.85 0 0 1 79.18 6.29" stroke={`url(#${topEdgeId})`} strokeWidth="1.7" filter={`url(#${softEdgeId})`}/>
      <path d="M 4.46 74.76 A 54.85 54.85 0 0 1 79.18 6.29" stroke={`url(#${topEdgeId})`} strokeWidth=".9"/>
      <path d="M 108.17 39.05 A 54.85 54.85 0 0 1 38.96 108.17" stroke={`url(#${bottomEdgeId})`} strokeWidth="1.4" filter={`url(#${softEdgeId})`}/>
      <path d="M 108.17 39.05 A 54.85 54.85 0 0 1 38.96 108.17" stroke={`url(#${bottomEdgeId})`} strokeWidth=".78"/>
    </svg>
    <svg className="camera-glass-symbol" aria-hidden="true" viewBox="0 0 68 54" fill="currentColor">
      <path fillRule="evenodd" d="M13 8.5h8.3l3.3-4.2A7 7 0 0 1 30.1 1h8.2a7 7 0 0 1 5.5 2.7l3.8 4.8H55c7.2 0 11 3.8 11 11v21c0 7.2-3.8 11-11 11H13c-7.2 0-11-3.8-11-11v-21c0-7.2 3.8-11 11-11Zm21 8.2a13.4 13.4 0 1 0 0 26.8 13.4 13.4 0 0 0 0-26.8Zm0 5.5a7.9 7.9 0 1 1 0 15.8 7.9 7.9 0 0 1 0-15.8Zm20.1-8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/>
    </svg>
  </button>;
}
