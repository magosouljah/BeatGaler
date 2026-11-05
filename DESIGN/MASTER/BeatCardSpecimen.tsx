import { useState } from "react";
import type { CoverMode } from "../shared/coverSources";
import { DEMO_BEATS } from "../shared/data";
import { LabBeatTile } from "../shared/components";
import { BeatTagPeekLayer, useBeatTagPeek } from "../shared/BeatTagPeek";

const example = DEMO_BEATS[0];
const exampleColors: Record<string, string> = {
  Ambient: "#929292", Dark: "#929292", Melodic: "#e56b70",
  Spacey: "#6c8ee8", Trap: "#6c8ee8",
};

/** The approved BeatCard A, alone at real size. No unused variants. */
export default function BeatCardSpecimen({ coverMode }: { coverMode: CoverMode }) {
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState("");
  const peek = useBeatTagPeek();
  return (
    <div className="lab-master-beatcard-comparison" aria-label="BeatCard definitiva, tags adicionales tras 800 milisegundos">
      <div className="lab-master-beatcard-variants"
        onPointerOver={peek.onPointerOver} onPointerOut={peek.onPointerOut} onPointerDown={peek.onPointerDown}
        onFocusCapture={peek.onFocusCapture} onBlurCapture={peek.onBlurCapture}>
        <div className="lab-master-beatcard-variant">
          <LabBeatTile beat={example} coverMode={coverMode}
            tagColors={exampleColors} selected={playing} onPlay={() => setPlaying(p => !p)}
            onMore={() => setMessage("El menú de acciones se diseñará por separado.")}/>
        </div>
      </div>
      <BeatTagPeekLayer peek={peek.peek}/>
      {message && <button type="button" className="lab-master-beatcard-feedback" onClick={() => setMessage("")}>{message} ×</button>}
    </div>
  );
}
