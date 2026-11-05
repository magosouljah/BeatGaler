import { useState } from "react";
import type { CoverMode } from "../shared/coverSources";
import { DEMO_BEATS } from "../shared/data";
import { LabBeatTile } from "../shared/components";
import { BeatTagPeekLayer, useBeatTagPeek } from "../shared/BeatTagPeek";

const demo = DEMO_BEATS[0];
// Same beat and colors in all three specimens, so only the reveal differs.
const demoColors: Record<string,string> = {
  Ambient:"#929292", Dark:"#929292", Melodic:"#e56b70",
  Spacey:"#6c8ee8", Trap:"#6c8ee8"
};
const variants = [
  { mode: "quiet-line", label: "A · Línea discreta" },
  { mode: "cover-overlay", label: "B · Sobre portada" },
  { mode: "edge-rail", label: "C · Extensión lateral" },
] as const;

export default function BeatCardComparison({ coverMode }: { coverMode: CoverMode }) {
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const peek = useBeatTagPeek();
  return (
    <div className="lab-master-beatcard-comparison" aria-label="Tres propuestas de BeatCard, revelar tags tras 800 milisegundos">
      <div className="lab-master-beatcard-variants"
        onPointerOver={peek.onPointerOver} onPointerOut={peek.onPointerOut}
        onFocusCapture={peek.onFocusCapture} onBlurCapture={peek.onBlurCapture}>
        {variants.map((variant,index) => (
          <div key={variant.mode} className="lab-master-beatcard-variant">
            <span className="lab-master-beatcard-label">{variant.label}</span>
            <LabBeatTile beat={demo} coverMode={coverMode}
              tagColors={demoColors} peekMode={variant.mode}
              selected={playingIndex===index}
              onPlay={() => setPlayingIndex(current => current===index ? null : index)}
              onMore={() => setMessage("El menú de acciones se diseñará por separado.")}/>
          </div>
        ))}
      </div>
      <BeatTagPeekLayer peek={peek.peek}/>
      {message && <button type="button" className="lab-master-beatcard-feedback" onClick={() => setMessage("")}>{message} ×</button>}
    </div>
  );
}
