import { useEffect, useRef, useState } from "react";
import { mountOriginalArchisEngine } from "./ArchisOriginalEngine";
import "./archis-original.css";

// Optical functions, SVG filter stack and initial settings are upstream's.
// This React wrapper supplies only the original Button preset and a backdrop
// selector so the material can be evaluated before considering Toolbar V2.
const BACKDROPS = [
  { label: "Gris", background: "#303034" },
  { label: "Negro", background: "#050506" },
  { label: "Rosa / negro", background: "linear-gradient(#ef91bc 50%,#09090d 50%)" },
  { label: "Refracción", background: "linear-gradient(#ef91bc 38%,#09090d 38%)" },
  { label: "Rosa", background: "#ef91bc" }
] as const;

export default function ArchisOriginalSpecimen() {
  const [background, setBackground] = useState(2);
  const [selected, setSelected] = useState(false);
  const glass = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!glass.current) return;
    const rebuild = mountOriginalArchisEngine();
    const observer = new ResizeObserver(rebuild);
    observer.observe(glass.current);
    return () => observer.disconnect();
  }, []);

  return <div className="archis-original-experiment" data-archis-original-experiment>
    <div className="archis-original-stage" data-archis-original-stage
      style={{ "--archis-original-background": BACKDROPS[background].background } as React.CSSProperties}>
      <div className="archis-original-behind" aria-hidden="true">BeatGaler</div>
      <button ref={glass} id="glass" className="glassDiv" type="button"
        aria-label="Select — original Archis Vaze liquid glass"
        aria-pressed={selected} onClick={() => setSelected(v => !v)}>
        <span>{selected ? "Selected" : "Select"}</span>
      </button>
    </div>

    <div className="archis-original-options" role="group" aria-label="Fondos de prueba del cristal original">
      {BACKDROPS.map((item, i) => <button key={item.label} type="button"
        aria-pressed={background === i} onClick={() => setBackground(i)}>
        {item.label}
      </button>)}
    </div>
    <p className="archis-original-caption">Motor SVG original · preset Button 140 × 52 · sin reacción artificial al mouse</p>

    {/* Original control values, unchanged; only hidden because this is a single specimen. */}
    <div hidden aria-hidden="true">
      <select id="surface-fn" defaultValue="convex_squircle"><option value="convex_squircle">Convex Squircle</option></select>
      <input id="glass-thickness" type="hidden" value="80" readOnly/>
      <input id="bezel-width" type="hidden" value="60" readOnly/>
      <input id="refractive-index" type="hidden" value="3.0" readOnly/>
      <input id="scale-ratio" type="hidden" value="1.0" readOnly/>
      <input id="blur-amount" type="hidden" value="0.3" readOnly/>
      <input id="specular-opacity" type="hidden" value="0.5" readOnly/>
      <input id="specular-saturation" type="hidden" value="4" readOnly/>
      <input id="border-radius" type="hidden" value="26" readOnly/>
    </div>
    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"
      style={{ position:"absolute",overflow:"hidden" }} colorInterpolationFilters="sRGB"
      aria-hidden="true" focusable="false">
      <defs id="svg-defs"/>
    </svg>
  </div>;
}
