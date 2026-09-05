import { useRef, useState, useEffect, useCallback } from "react";
import { platform } from "../platform";
import { playTrace } from "../features/playback/playTrace";
import { shouldAcceptWebPlaybackRequest } from "../features/playback/webPlaybackIntent";

let silentGestureUrl: string | null = null;

function getSilentGestureUrl(): string {
  if (silentGestureUrl) return silentGestureUrl;
  const sampleCount = 800;
  const bytes = new Uint8Array(44 + sampleCount);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + sampleCount, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  write(36, "data");
  view.setUint32(40, sampleCount, true);
  bytes.fill(128, 44);
  silentGestureUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  return silentGestureUrl;
}

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
  const waitingRef = useRef(false);
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
    const publishPlaybackState = () => {
      const beatId = currentBeatIdRef.current;
      if (!beatId) return;
      window.dispatchEvent(new CustomEvent("beatgaler:web-playback-state", {
        detail: {
          beatId,
          currentTime: Math.max(0, Number(audio.currentTime) || 0),
          playing: !audio.paused && !audio.ended,
          waiting: waitingRef.current,
        },
      }));
    };

    const onTimeUpdate = () => {
      if (audio.duration > 0) {
        setState((s) => ({ ...s, progress: audio.currentTime / audio.duration }));
      }
      publishPlaybackState();
    };
    const onLoadedMeta = () => setState((s) => ({ ...s, duration: audio.duration }));
    const onEnded = () => {
      const beatId = currentBeatIdRef.current;
      waitingRef.current = false;
      setState((s) => ({ ...s, isPlaying: false, progress: 0, endedSeq: s.endedSeq + 1 }));
      publishPlaybackState();
      if (beatId) window.dispatchEvent(new CustomEvent("beatgaler:audio-idle", { detail: { beatId } }));
    };
    const onPlay = () => {
      waitingRef.current = false;
      playTrace("AUDIO_EVENT_PLAY", { beat_id: currentBeatIdRef.current, ready_state: audio.readyState });
      setState((s) => ({ ...s, isPlaying: true }));
      publishPlaybackState();
    };
    const onPlaying = () => {
      const beatId = currentBeatIdRef.current;
      waitingRef.current = false;
      playTrace("AUDIO_EVENT_PLAYING", { beat_id: beatId, ready_state: audio.readyState, current_time: audio.currentTime });
      setState((s) => ({ ...s, isPlaying: true }));
      publishPlaybackState();
      if (beatId) window.dispatchEvent(new CustomEvent("beatgaler:audio-playing", { detail: { beatId } }));
      void platform.diagnostics.audioEvent("AUDIO_PLAYING", beatId, null, `readyState=${audio.readyState} currentTime=${audio.currentTime.toFixed(3)}`).catch(() => {});
    };
    const onWaiting = () => {
      waitingRef.current = true;
      playTrace("AUDIO_EVENT_WAITING", { beat_id: currentBeatIdRef.current, ready_state: audio.readyState, current_time: audio.currentTime });
      publishPlaybackState();
      void platform.diagnostics.audioEvent("AUDIO_WAITING", currentBeatIdRef.current, null, `readyState=${audio.readyState} currentTime=${audio.currentTime.toFixed(3)}`).catch(() => {});
    };
    const onCanPlay = () => {
      waitingRef.current = false;
      playTrace("AUDIO_EVENT_CANPLAY", { beat_id: currentBeatIdRef.current, ready_state: audio.readyState });
      publishPlaybackState();
      void platform.diagnostics.audioEvent("AUDIO_CANPLAY", currentBeatIdRef.current, null, `readyState=${audio.readyState}`).catch(() => {});
    };
    const onPause = () => {
      const beatId = currentBeatIdRef.current;
      waitingRef.current = false;
      setState((s) => ({ ...s, isPlaying: false }));
      publishPlaybackState();
      if (beatId) window.dispatchEvent(new CustomEvent("beatgaler:audio-idle", { detail: { beatId } }));
    };
    const onError = () => {
      waitingRef.current = false;
      playTrace("AUDIO_EVENT_ERROR", { beat_id: currentBeatIdRef.current, media_error: audio.error?.code || null, priming: primingRef.current });
      publishPlaybackState();
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
    waitingRef.current = false;
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

  const armPlaybackGesture = useCallback((): Promise<boolean> => {
    const audio = getAudio();
    const silentUrl = getSilentGestureUrl();
    primingRef.current = true;
    audio.pause();
    audio.preload = "auto";
    audio.loop = true;
    audio.muted = true;
    audio.src = silentUrl;
    audio.currentTime = 0;
    audio.load();
    const attempt = audio.play();
    return Promise.resolve(attempt).then(() => true, () => false).finally(() => {
      if (audio.src === silentUrl) audio.pause();
      audio.loop = false;
      audio.muted = false;
      primingRef.current = false;
    });
  }, [getAudio]);

  const play = useCallback((beatId: string, paths: string[]) => {
    const audio = getAudio();
    playTrace("AUDIO_PLAY_FUNCTION_ENTER", { beat_id: beatId, ready_state: audio.readyState, paused: audio.paused });
    const sources = Array.from(new Set(paths.filter(Boolean).map(path => platform.media.resolveUrl(path))));
    if (!shouldAcceptWebPlaybackRequest(beatId, sources)) {
      playTrace("AUDIO_SUPERSEDED_PLAY_IGNORED", { beat_id: beatId });
      return;
    }
    if (sources.length === 0) {
      console.error("No audio sources available for beat", beatId);
      return;
    }

    const samePendingSource = currentBeatIdRef.current === beatId && sourceUrlsRef.current[0] === sources[0];
    if (samePendingSource && audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA && !audio.error) {
      void platform.diagnostics.audioEvent("AUDIO_DUPLICATE_PLAY_IGNORED", beatId, null, `readyState=${audio.readyState}`).catch(() => {});
      return;
    }
    if (samePendingSource || state.playingId === beatId) {
      audio.paused ? audio.play().catch(console.error) : audio.pause();
      return;
    }

    const previousBeatId = currentBeatIdRef.current;
    audio.pause();
    currentBeatIdRef.current = beatId;
    errorNotifiedRef.current = false;
    primingRef.current = false;
    waitingRef.current = false;
    audio.muted = false;
    audio.loop = false;
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
    playTrace("AUDIO_SRC_SET", { beat_id: beatId, ready_state: audio.readyState, url_scheme: String(sources[0] || "").split(":")[0] || null });
    setState((s) => ({ ...s, playingId: beatId, progress: 0, duration: 0 }));
    playTrace("AUDIO_PLAY_PROMISE_BEGIN", { beat_id: beatId });
    audio.play().then(
      () => playTrace("AUDIO_PLAY_PROMISE_RESOLVED", { beat_id: beatId }),
      error => {
        playTrace("AUDIO_PLAY_PROMISE_REJECTED", { beat_id: beatId, error_name: error instanceof Error ? error.name : "unknown" });
        console.error(error);
      },
    );
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
      const beatId = currentBeatIdRef.current;
      if (beatId) {
        window.dispatchEvent(new CustomEvent("beatgaler:web-playback-state", {
          detail: { beatId, currentTime: audio.currentTime, playing: !audio.paused, waiting: waitingRef.current },
        }));
      }
    }
  }, [getAudio]);

  const setVolume = useCallback((volume: number) => {
    const audio = getAudio();
    const next = Math.max(0, Math.min(1, volume));
    audio.volume = next;
    setState((s) => ({ ...s, volume: next }));
  }, [getAudio]);

  const releaseFile = useCallback(() => {
    const audio = getAudio();
    const releasedBeatId = currentBeatIdRef.current;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    sourceUrlsRef.current = [];
    sourceIndexRef.current = 0;
    currentBeatIdRef.current = null;
    errorNotifiedRef.current = false;
    waitingRef.current = false;
    platform.media.releasePlayback(releasedBeatId);
    setState((s) => ({ ...s, playingId: null, isPlaying: false, progress: 0, duration: 0 }));
  }, [getAudio]);

  return { state, play, primeAudioEngine, armPlaybackGesture, togglePause, seek, setVolume, releaseFile };
}
