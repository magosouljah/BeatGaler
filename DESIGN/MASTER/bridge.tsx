import { useMemo } from "react";
import { getCoverSrc } from "../coverSources";
import type { Beat } from "./fixtures";

// Adaptador local del Artwork de src/components/ui.tsx: mismas medidas y radios,
// con portadas ficticias del lab. Sin importaciones de servicios de producción.
export function Artwork({ beat, size = 160, playing = false }: { beat: Beat; size?: number; playing?: boolean }) {
  const cover = useMemo(() => getCoverSrc(beat.id, beat.coverMode, Math.max(0, Number(beat.id.slice(-2)) - 1)), [beat.id, beat.coverMode]);
  return (
    <div className="lab-playbar-artwork" style={{ width: size, height: size, borderRadius: 10, flexShrink: 0, position: "relative", overflow: "hidden", backgroundColor: "#0c0c0c", boxShadow: playing ? "0 0 0 2px rgba(255,255,255,0.15)" : "none" }}>
      {cover && <img src={cover} alt={beat.name} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
    </div>
  );
}
export function playerToggleTitle(playing: boolean): "Play" | "Pause" {
  return playing ? "Pause" : "Play";
}
export function playerMetaLabel(key: string, bpm: string): string {
  return `${key || "Unknown Key"} • ${bpm || "--"} BPM`;
}
