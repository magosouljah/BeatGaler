import { useRef, useState, useEffect, useCallback } from "react";
import { filePathToUrl } from "../lib/tauri";

export interface AudioState {
  playingId: string | null;
  isPlaying: boolean;
  progress: number;
  duration: number;
  volume: number;
  endedSeq: number;
}

export function useAudio() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<AudioState>({
    playingId: null,
    isPlaying: false,
    progress: 0,
    duration: 0,
    volume: 0.75,
    endedSeq: 0,
  });

  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.volume = 0.75;
    }
    return audioRef.current;
  }, []);

  useEffect(() => {
    const audio = getAudio();

    const onTimeUpdate = () => {
      if (audio.duration > 0) {
        setState((s) => ({ ...s, progress: audio.currentTime / audio.duration }));
      }
    };
    const onLoadedMeta = () => setState((s) => ({ ...s, duration: audio.duration }));
    const onEnded = () => setState((s) => ({ ...s, isPlaying: false, progress: 0, endedSeq: s.endedSeq + 1 }));
    const onPlay = () => setState((s) => ({ ...s, isPlaying: true }));
    const onPause = () => setState((s) => ({ ...s, isPlaying: false }));

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMeta);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMeta);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, []);

  const play = useCallback((beatId: string, mp3Path: string) => {
    const audio = getAudio();
    if (state.playingId === beatId) {
      audio.paused ? audio.play().catch(console.error) : audio.pause();
      return;
    }
    audio.pause();
    audio.src = filePathToUrl(mp3Path);
    audio.currentTime = 0;
    setState((s) => ({ ...s, playingId: beatId, progress: 0, duration: 0 }));
    audio.play().catch(console.error);
  }, [state.playingId, getAudio]);

  const togglePause = useCallback(() => {
    const audio = getAudio();
    audio.paused ? audio.play().catch(console.error) : audio.pause();
  }, [getAudio]);

  const seek = useCallback((ratio: number) => {
    const audio = getAudio();
    if (audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
      setState((s) => ({ ...s, progress: ratio }));
    }
  }, [getAudio]);

  const setVolume = useCallback((volume: number) => {
    const audio = getAudio();
    const next = Math.max(0, Math.min(1, volume));
    audio.volume = next;
    setState((s) => ({ ...s, volume: next }));
  }, [getAudio]);

  /** Fully releases the file handle — MUST call before renaming on Windows */
  const releaseFile = useCallback(() => {
    const audio = getAudio();
    audio.pause();
    audio.removeAttribute("src");
    audio.load(); // this forces the browser to release the file handle
    setState((s) => ({ ...s, playingId: null, isPlaying: false, progress: 0, duration: 0 }));
  }, [getAudio]);

  return { state, play, togglePause, seek, setVolume, releaseFile };
}
