import { useRef, useState, useEffect, useCallback } from "react";
import { platform } from "../platform";

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
  const sourceUrlsRef = useRef<string[]>([]);
  const sourceIndexRef = useRef(0);
  const currentBeatIdRef = useRef<string | null>(null);
  const errorNotifiedRef = useRef(false);
  const primingRef = useRef(false);
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
    const onEnded = () => {
      const beatId = currentBeatIdRef.current;
      setState((s) => ({ ...s, isPlaying: false, progress: 0, endedSeq: s.endedSeq + 1 }));
      if (beatId) window.dispatchEvent(new CustomEvent("beatgaler:audio-idle", { detail: { beatId } }));
    };
    const onPlay = () => setState((s) => ({ ...s, isPlaying: true }));
    const onPlaying = () => {
      const beatId = currentBeatIdRef.current;
      setState((s) => ({ ...s, isPlaying: true }));
      if (beatId) window.dispatchEvent(new CustomEvent("beatgaler:audio-playing", { detail: { beatId } }));
      void platform.diagnostics.audioEvent("AUDIO_PLAYING", beatId, null, `readyState=${audio.readyState} currentTime=${audio.currentTime.toFixed(3)}`).catch(() => {});
    };
    const onWaiting = () => {
      void platform.diagnostics.audioEvent("AUDIO_WAITING", currentBeatIdRef.current, null, `readyState=${audio.readyState} currentTime=${audio.currentTime.toFixed(3)}`).catch(() => {});
    };
    const onCanPlay = () => {
      void platform.diagnostics.audioEvent("AUDIO_CANPLAY", currentBeatIdRef.current, null, `readyState=${audio.readyState}`).catch(() => {});
    };
    const onPause = () => {
      const beatId = currentBeatIdRef.current;
      setState((s) => ({ ...s, isPlaying: false }));
      if (beatId) window.dispatchEvent(new CustomEvent("beatgaler:audio-idle", { detail: { beatId } }));
    };
    const onError = () => {
      if (primingRef.current) return;
      const nextIndex = sourceIndexRef.current + 1;
      if (nextIndex >= sourceUrlsRef.current.length) {
        const failedBeatId = currentBeatIdRef.current;
        console.error("Audio playback failed for all available sources.", sourceUrlsRef.current);
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        platform.media.releasePlayback(failedBeatId);
        sourceUrlsRef.current = [];
        sourceIndexRef.current = 0;
        setState((s) => ({ ...s, playingId: null, isPlaying: false, progress: 0, duration: 0 }));
        if (!errorNotifiedRef.current) {
          errorNotifiedRef.current = true;
          window.dispatchEvent(new CustomEvent("beatgaler:audio-unavailable", {
            detail: { beatId: currentBeatIdRef.current },
          }));
        }
        return;
      }
      sourceIndexRef.current = nextIndex;
      audio.src = sourceUrlsRef.current[nextIndex];
      audio.load();
      audio.play().catch(console.error);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMeta);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMeta);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
    };
  }, []);

  const primeAudioEngine = useCallback(async (path: string): Promise<boolean> => {
    const source = platform.media.resolveUrl(path);
    if (!source) return false;
    const audio = getAudio();
    if (audio.src === source && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return true;

    primingRef.current = true;
    audio.pause();
    audio.preload = "auto";
    audio.muted = true;
    currentBeatIdRef.current = null;
    void platform.diagnostics.audioEvent("AUDIO_ENGINE_PRIME_BEGIN", null, null, source).catch(() => {});

    return await new Promise<boolean>((resolve) => {
      const cleanup = () => {
        audio.removeEventListener("canplay", onReady);
        audio.removeEventListener("error", onPrimeError);
      };
      const onReady = () => {
        cleanup();
        primingRef.current = false;
        audio.muted = false;
        void platform.diagnostics.audioEvent("AUDIO_ENGINE_PRIME_READY", null, null, `readyState=${audio.readyState}`).catch(() => {});
        resolve(true);
      };
      const onPrimeError = () => {
        cleanup();
        primingRef.current = false;
        audio.muted = false;
        void platform.diagnostics.audioEvent("AUDIO_ENGINE_PRIME_ERROR", null, null, "").catch(() => {});
        resolve(false);
      };
      audio.addEventListener("canplay", onReady, { once: true });
      audio.addEventListener("error", onPrimeError, { once: true });
      audio.src = source;
      audio.currentTime = 0;
      audio.load();
    });
  }, [getAudio]);

  const play = useCallback((beatId: string, paths: string[]) => {
    const audio = getAudio();
    if (state.playingId === beatId) {
      audio.paused ? audio.play().catch(console.error) : audio.pause();
      return;
    }
    const sources = Array.from(new Set(paths.filter(Boolean).map(path => platform.media.resolveUrl(path))));
    if (sources.length === 0) {
      console.error("No audio sources available for beat", beatId);
      return;
    }
    const previousBeatId = currentBeatIdRef.current;
    audio.pause();
    currentBeatIdRef.current = beatId;
    errorNotifiedRef.current = false;
    primingRef.current = false;
    audio.muted = false;
    sourceUrlsRef.current = sources;
    sourceIndexRef.current = 0;
    const canReusePrimedSource = audio.src === sources[0] && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (!canReusePrimedSource) {
      audio.src = sources[0];
      audio.currentTime = 0;
      audio.load();
    } else {
      audio.currentTime = 0;
      void platform.diagnostics.audioEvent("AUDIO_PRIMED_SOURCE_REUSED", beatId, null, `readyState=${audio.readyState}`).catch(() => {});
    }
    if (previousBeatId && previousBeatId !== beatId) platform.media.releasePlayback(previousBeatId);
    void platform.diagnostics.audioEvent("AUDIO_SRC_SET", beatId, null, sources[0]).catch(() => {});
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
    const releasedBeatId = currentBeatIdRef.current;
    audio.pause();
    audio.removeAttribute("src");
    audio.load(); // this forces the browser to release the file handle
    sourceUrlsRef.current = [];
    sourceIndexRef.current = 0;
    currentBeatIdRef.current = null;
    errorNotifiedRef.current = false;
    platform.media.releasePlayback(releasedBeatId);
    setState((s) => ({ ...s, playingId: null, isPlaying: false, progress: 0, duration: 0 }));
  }, [getAudio]);

  return { state, play, primeAudioEngine, togglePause, seek, setVolume, releaseFile };
}
