import { forwardRef, useId } from "react";
import type { CSSProperties, ButtonHTMLAttributes, ReactNode } from "react";
import "./camera-glass.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  as?: "button" | "div";
  size?: number;
  width?: number | string;
  active?: boolean;
  pressed?: boolean;
  children: ReactNode;
};

/** Approved CameraGlass optical stack. Same SVG contour and displacement,
 * shared by circular and capsule controls, without any additional surfaces. */
const GlassButton = forwardRef<HTMLButtonElement, Props>(function GlassButton({as="button",size=72,width,active=false,pressed=false,children,className="",style,...rest}, ref) {
  const uid=useId().replace(/:/g,"");
  const filterId=`camera-glass-optics-${uid}`;
  const topEdgeId=`camera-edge-upper-${uid}`;
  const bottomEdgeId=`camera-edge-lower-${uid}`;
  const softEdgeId=`camera-edge-soft-${uid}`;
  const softRightId=`camera-edge-soft-right-${uid}`;
  const Element=as;
  return <Element {...(rest as any)} ref={ref as any} className={`camera-glass glass-button${active?" is-pressed":""}${pressed?" is-pressed":""} ${className}`}
    style={{"--camera-size":`${size}px`,width:width ?? size,borderRadius:9999,...style} as CSSProperties}>
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
    <svg className="camera-glass-edge glass-button-edge-left" viewBox="0 0 112 112" aria-hidden="true" focusable="false" fill="none">
      <defs>
        <linearGradient id={topEdgeId} x1="4.5" y1="75" x2="79" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" stopOpacity="0"/>
          <stop offset=".20" stopColor="white" stopOpacity=".17"/>
          <stop offset=".56" stopColor="white" stopOpacity=".72"/>
          <stop offset=".82" stopColor="white" stopOpacity=".34"/>
          <stop offset="1" stopColor="white" stopOpacity="0"/>
        </linearGradient>
        <filter id={softEdgeId} x="-8%" y="-8%" width="116%" height="116%">
          <feGaussianBlur stdDeviation=".55"/>
        </filter>
      </defs>
      <path d="M 4.46 74.76 A 54.85 54.85 0 0 1 79.18 6.29" stroke={`url(#${topEdgeId})`} strokeWidth="1.7" filter={`url(#${softEdgeId})`}/>
      <path d="M 4.46 74.76 A 54.85 54.85 0 0 1 79.18 6.29" stroke={`url(#${topEdgeId})`} strokeWidth=".9"/>
    </svg>
    <svg className="camera-glass-edge glass-button-edge-right" viewBox="0 0 112 112" aria-hidden="true" focusable="false" fill="none">
      <defs>
        <linearGradient id={bottomEdgeId} x1="108" y1="39" x2="39" y2="107" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" stopOpacity="0"/>
          <stop offset=".43" stopColor="white" stopOpacity=".10"/>
          <stop offset=".74" stopColor="white" stopOpacity=".38"/>
          <stop offset="1" stopColor="white" stopOpacity="0"/>
        </linearGradient>
        <filter id={softRightId} x="-8%" y="-8%" width="116%" height="116%">
          <feGaussianBlur stdDeviation=".55"/>
        </filter>
      </defs>
      <path d="M 108.17 39.05 A 54.85 54.85 0 0 1 38.96 108.17" stroke={`url(#${bottomEdgeId})`} strokeWidth="1.4" filter={`url(#${softRightId})`}/>
      <path d="M 108.17 39.05 A 54.85 54.85 0 0 1 38.96 108.17" stroke={`url(#${bottomEdgeId})`} strokeWidth=".78"/>
    </svg>
    <span className="glass-button-content">{children}</span>
  </Element>;
});
export default GlassButton;
