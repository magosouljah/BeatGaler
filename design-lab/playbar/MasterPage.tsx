import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoverMode } from "../coverSources";
import Player from "./Player";
import { SAMPLE_BEATS } from "./fixtures";
import type { Beat } from "./fixtures";
import "./master.css";

export default function MasterPage({ coverMode, setCoverMode }: {
  coverMode: CoverMode;
  setCoverMode: (mode: CoverMode) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0.32);
  const [volume, setVolume] = useState(0.65);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("off");
  const [queueIds, setQueueIds] = useState<string[]>([SAMPLE_BEATS[1].id, SAMPLE_BEATS[2].id]);
  const [showQueue, setShowQueue] = useState(false);
  const [message, setMessage] = useState("");
  const beats = useMemo<Beat[]>(() => SAMPLE_BEATS.map(b => ({ ...b, coverMode })), [coverMode]);
  const beat = beats[selected];
  const queue = beats.filter(b => queueIds.includes(b.id));
  const choose = useCallback((index: number) => { setSelected((index + SAMPLE_BEATS.length) % SAMPLE_BEATS.length); setProgress(0); }, []);
  const next = useCallback(() => {
    if (shuffleEnabled) choose(Math.floor(Math.random() * SAMPLE_BEATS.length));
    else if (selected + 1 >= SAMPLE_BEATS.length && repeatMode === "off") { setPlaying(false); setProgress(1); }
    else choose(selected + 1);
  }, [choose, selected, shuffleEnabled, repeatMode]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setProgress(p => Math.min(1, p + 0.25 / beat.duration));
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing, beat.duration]);
  useEffect(() => {
    if (!playing || progress < 1) return;
    if (repeatMode === "one") setProgress(0);
    else next();
  }, [progress, playing, repeatMode, next]);
  const queueBeat = (item: Beat) => {
    setQueueIds(ids => ids.includes(item.id) ? ids : [...ids, item.id]);
    setMessage(`Añadido a la cola de prueba: ${item.name}`);
  };
  return (
    <main className="lab-master-document">
      <h1>MASTER</h1>
      <p>Componentes de BeatGaler, uno por uno. Solo se documenta lo que ya estamos trabajando.</p>
      <hr />
      <h2>01. Playbar</h2>
      <p><strong>Origen:</strong> <code>src/components/Player.tsx</code> (producción v0.9.0-beta.2).</p>
      <p><strong>Estado:</strong> componente original copiado para revisión. Iconos, tamaño, distribución, scrubber, cola y volumen vertical preservados. Sin audio real ni conexión a servicios.</p>
      <p>La Playbar aparece abajo, igual que en BeatGaler. Prueba sus botones, abre el volumen o arrastra el progreso.</p>
      <p className="lab-master-simple-options">
        Portadas de prueba:{" "}
        <label><input type="radio" name="master-cover-mode" checked={coverMode === "generated"} onChange={() => setCoverMode("generated")} /> Generated</label>
        <label><input type="radio" name="master-cover-mode" checked={coverMode === "real"} onChange={() => setCoverMode("real")} /> Real covers</label>
      </p>
      <p><small>Los botones funcionan con seis beats ficticios. No se reproduce audio ni se guardan cambios.</small></p>
      <p className="lab-master-message" role="status" aria-live="polite">{message}</p>
      <Player
        beat={beat} playing={playing} progress={progress} duration={beat.duration} volume={volume}
        queue={queue} currentIndex={queue.findIndex(b => b.id === beat.id)}
        showQueue={showQueue} canShowQueue={queue.length > 0} shuffleEnabled={shuffleEnabled} repeatMode={repeatMode}
        onToggle={() => { if (progress >= 1) setProgress(0); setPlaying(p => !p); }}
        onSeek={setProgress} onPrev={() => choose(selected - 1)} onNext={next} onVolumeChange={setVolume}
        onToggleShuffle={() => setShuffleEnabled(v => !v)}
        onCycleRepeat={() => setRepeatMode(v => v === "off" ? "all" : v === "all" ? "one" : "off")}
        onToggleQueue={() => setShowQueue(v => !v)}
        onPlayQueueIndex={i => { const at = beats.findIndex(b => b.id === queue[i]?.id); if (at >= 0) { choose(at); setPlaying(true); } setShowQueue(false); }}
        canAddBeat onAddBeat={() => queueBeat(beat)} onAddToQueue={queueBeat}
        onDetail={b => setMessage(`Detalle de prueba: ${b.name}`)}
        onEdit={b => setMessage(`Editar ${b.name}: todavía no se ha añadido este componente.`)}
        onDelete={() => setMessage("La biblioteca ficticia no elimina archivos.")}
      />
    </main>
  );
}
