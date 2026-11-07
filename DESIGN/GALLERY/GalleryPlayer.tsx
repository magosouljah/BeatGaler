import { useEffect, useMemo, useState } from "react";
import Player from "../MASTER/Player";
import { SAMPLE_BEATS } from "../MASTER/fixtures";
import type { Beat } from "../MASTER/fixtures";
import { DEMO_BEATS } from "../shared/data";
import type { DemoBeat } from "../shared/data";
import type { CoverMode } from "../shared/coverSources";

export default function GalleryPlayer({ beat, playing, onToggle, onPlayBeat, coverMode }: {
  beat: DemoBeat; playing: boolean; onToggle: () => void;
  onPlayBeat: (beat: DemoBeat) => void; coverMode: CoverMode;
}) {
  const beats = useMemo<Beat[]>(() => SAMPLE_BEATS.map(item => ({ ...item, coverMode })), [coverMode]);
  const current = beats.find(item => item.id === beat.id) ?? beats[0];
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(.65);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("off");
  const [queueIds, setQueueIds] = useState<string[]>([DEMO_BEATS[1].id, DEMO_BEATS[2].id]);
  const [showQueue, setShowQueue] = useState(false);
  const [notice, setNotice] = useState("");
  const queue = beats.filter(item => queueIds.includes(item.id));
  const selected = DEMO_BEATS.findIndex(item => item.id === beat.id);
  useEffect(() => setProgress(0), [beat.id]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setProgress(p => Math.min(1, p + .25 / current.duration)), 250);
    return () => window.clearInterval(timer);
  }, [playing, current.duration]);
  useEffect(() => {
    if (!playing || progress < 1) return;
    if (repeatMode === "one") setProgress(0);
    else if (selected + 1 >= DEMO_BEATS.length && repeatMode === "off") onToggle();
    else onPlayBeat(DEMO_BEATS[(selected + 1) % DEMO_BEATS.length]);
  }, [progress, playing, repeatMode, selected, onToggle, onPlayBeat]);
  const choose = (offset: number) => onPlayBeat(DEMO_BEATS[(selected + offset + DEMO_BEATS.length) % DEMO_BEATS.length]);
  const queueBeat = (item: Beat) => {
    setQueueIds(ids => ids.includes(item.id) ? ids : [...ids, item.id]);
    setNotice("Added to preview queue: " + item.name);
  };
  return <div className="lab-gallery-playbar-frame" aria-label="Gallery Playbar">
    <Player preview beat={current} playing={playing} progress={progress} duration={current.duration} volume={volume}
      queue={queue} currentIndex={queue.findIndex(item => item.id === current.id)}
      showQueue={showQueue} canShowQueue={queue.length > 0}
      shuffleEnabled={shuffleEnabled} repeatMode={repeatMode}
      onToggle={() => { if (progress >= 1) setProgress(0); onToggle(); }}
      onSeek={setProgress} onPrev={() => choose(-1)}
      onNext={() => {
        if (shuffleEnabled) onPlayBeat(DEMO_BEATS[Math.floor(Math.random() * DEMO_BEATS.length)]);
        else choose(1);
      }}
      onVolumeChange={setVolume}
      onToggleShuffle={() => setShuffleEnabled(value => !value)}
      onCycleRepeat={() => setRepeatMode(value => value === "off" ? "all" : value === "all" ? "one" : "off")}
      onToggleQueue={() => setShowQueue(value => !value)}
      onPlayQueueIndex={index => {
        const next = DEMO_BEATS.find(item => item.id === queue[index]?.id);
        if (next) onPlayBeat(next);
        setShowQueue(false);
      }}
      canAddBeat onAddBeat={() => queueBeat(current)} onAddToQueue={queueBeat}
      onDetail={item => setNotice("Preview details: " + item.name)}
      onEdit={item => setNotice("Preview edit: " + item.name)}
      onDelete={() => setNotice("DESIGN does not delete beats.")}
    />
    {notice && <div className="lab-gallery-player-notice" role="status">
      {notice}<button type="button" aria-label="Dismiss Playbar notice" onClick={() => setNotice("")}>×</button>
    </div>}
  </div>;
}
