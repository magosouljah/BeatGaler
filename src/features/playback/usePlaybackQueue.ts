import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Beat } from "../../types";

type RepeatMode = "off" | "all" | "one";
type PlaybackQueueOptions = {
  beats: Beat[];
  displayedBeats: Beat[];
  playingId: string | null;
  progress: number;
  endedSeq: number;
  handlePlay: (beat: Beat) => void;
  seek: (progress: number) => void;
  releaseFile: () => void;
};

export function usePlaybackQueue({ beats, displayedBeats, playingId, progress, endedSeq, handlePlay, seek, releaseFile }: PlaybackQueueOptions) {
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("off");
  const [showQueue, setShowQueue] = useState(false);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const lastHandledEndedSeqRef = useRef(0);

  const closeQueue = useCallback(() => setShowQueue(false), []);
  const toggleQueue = useCallback(() => setShowQueue(value => !value), []);
  const toggleShuffle = useCallback(() => setShuffleEnabled(value => !value), []);
  const cycleRepeat = useCallback(() => setRepeatMode(mode => mode === "off" ? "all" : mode === "all" ? "one" : "off"), []);
  const addToQueue = useCallback((beat: Beat) => setQueueIds(ids => ids.includes(beat.id) ? ids : [...ids, beat.id]), []);

  useEffect(() => {
    const liveIds = new Set(beats.map(beat => beat.id));
    setQueueIds(ids => ids.filter(id => liveIds.has(id)));
    if (playingId && !liveIds.has(playingId)) releaseFile();
    if (beats.length === 0) setShowQueue(false);
  }, [beats, playingId, releaseFile]);

  const playbackQueue = useMemo(() => {
    if (!playingId) return displayedBeats;
    if (displayedBeats.some(beat => beat.id === playingId)) return displayedBeats;
    return beats;
  }, [playingId, displayedBeats, beats]);
  const currentQueueIndex = useMemo(() => playbackQueue.findIndex(beat => beat.id === playingId), [playbackQueue, playingId]);
  const playFromQueueIndex = useCallback((index: number) => {
    if (index < 0 || index >= playbackQueue.length) return;
    const target = playbackQueue[index];
    if (target) handlePlay(target);
  }, [playbackQueue, handlePlay]);

  const handleNext = useCallback((fromEnded = false) => {
    if (beats.length === 0) return;
    if (queueIds.length > 0) {
      const nextId = queueIds[0];
      const nextBeat = beats.find(beat => beat.id === nextId);
      setQueueIds(ids => ids.slice(1));
      if (nextBeat) { handlePlay(nextBeat); return; }
    }
    if (playbackQueue.length === 0) return;
    if (currentQueueIndex === -1) { playFromQueueIndex(0); return; }
    if (fromEnded && repeatMode === "one") { playFromQueueIndex(currentQueueIndex); return; }
    if (shuffleEnabled) {
      if (playbackQueue.length === 1) {
        if (!fromEnded || repeatMode !== "off") playFromQueueIndex(0);
        return;
      }
      let nextIndex = currentQueueIndex;
      while (nextIndex === currentQueueIndex) nextIndex = Math.floor(Math.random() * playbackQueue.length);
      playFromQueueIndex(nextIndex);
      return;
    }
    let nextIndex = currentQueueIndex + 1;
    if (nextIndex >= playbackQueue.length) {
      if (fromEnded && repeatMode === "off") return;
      nextIndex = 0;
    }
    playFromQueueIndex(nextIndex);
  }, [queueIds, beats, handlePlay, playbackQueue, currentQueueIndex, repeatMode, shuffleEnabled, playFromQueueIndex]);

  const handlePrev = useCallback(() => {
    if (beats.length === 0 || playbackQueue.length === 0) return;
    if (progress > 0.05) { seek(0); return; }
    if (shuffleEnabled && playbackQueue.length > 1) {
      let prevIndex = currentQueueIndex;
      while (prevIndex === currentQueueIndex) prevIndex = Math.floor(Math.random() * playbackQueue.length);
      playFromQueueIndex(prevIndex);
      return;
    }
    if (currentQueueIndex <= 0) { playFromQueueIndex(playbackQueue.length - 1); return; }
    playFromQueueIndex(currentQueueIndex - 1);
  }, [beats.length, playbackQueue, progress, seek, shuffleEnabled, currentQueueIndex, playFromQueueIndex]);

  useEffect(() => {
    if (endedSeq === 0 || endedSeq <= lastHandledEndedSeqRef.current) return;
    lastHandledEndedSeqRef.current = endedSeq;
    handleNext(true);
  }, [endedSeq, handleNext]);

  const queuedBeats = useMemo(() => {
    const map = new Map(beats.map(beat => [beat.id, beat] as const));
    return queueIds.map(id => map.get(id)).filter(Boolean) as Beat[];
  }, [queueIds, beats]);
  const playQueueIndex = useCallback((index: number) => {
    const target = queuedBeats[index];
    if (!target) return;
    handlePlay(target);
    setQueueIds(ids => ids.filter(id => id !== target.id));
  }, [queuedBeats, handlePlay]);

  return { shuffleEnabled, repeatMode, showQueue, queuedBeats, addToQueue, handleNext, handlePrev, closeQueue, toggleQueue, toggleShuffle, cycleRepeat, playQueueIndex };
}
