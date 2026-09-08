import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Beat } from "../../types";
import type { AudioState } from "../../hooks/useAudio";
import { platform } from "../../platform";
import { appAlert } from "../../lib/dialog";
import { sanitizeUserVisibleText } from "../../lib/userVisibleError";
import { downloadCookingDiagnosticEvent, getDownloadCookingStatus, isTauriAvailable, prepareBeatForPlayback, warmBeatForPlayback } from "../../lib/tauri";
import { createBeatRuntimeState, type BeatRuntimeEvent, type BeatRuntimeState } from "../state/beatRuntimeState";
import { isBeatPlaybackBlocked } from "./playbackReadiness";
import { playTrace } from "./playTrace";

type TransitionRuntime = (beatId: string, event: BeatRuntimeEvent, beatHint?: Beat) => void;

export type PlaybackControllerOptions = {
  audio: AudioState;
  play: (beatId: string, paths: string[]) => void;
  beatsLatestRef: MutableRefObject<Beat[]>;
  beatRuntimeStatesRef: MutableRefObject<Record<string, BeatRuntimeState>>;
  transitionRuntime: TransitionRuntime;
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  cloudSessionVerified: boolean;
  connectionState: "checking" | "online" | "poor" | "offline";
  isBeatCloudUpdateBusy: (beatId: string) => boolean;
};

export function usePlaybackController({
  audio,
  play,
  beatsLatestRef,
  beatRuntimeStatesRef,
  transitionRuntime,
  setBeats,
  cloudSessionVerified,
  connectionState,
  isBeatCloudUpdateBusy,
}: PlaybackControllerOptions) {
  const cookingPlaybackUrlRef = useRef<Map<string, { telegramFileId: string; url: string }>>(new Map());
  const cookingWarmPromisesRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const playbackCacheEpochRef = useRef(0);

  const clearPlaybackPreparation = useCallback(() => {
    playbackCacheEpochRef.current += 1;
    cookingPlaybackUrlRef.current.clear();
    cookingWarmPromisesRef.current.clear();
  }, []);

  const invalidatePlaybackPreparation = useCallback((beatId: string) => {
    cookingPlaybackUrlRef.current.delete(beatId);
    cookingWarmPromisesRef.current.delete(beatId);
  }, []);

  useEffect(() => {
    window.addEventListener("beatgaler:playback-cache-cleared", clearPlaybackPreparation);
    return () => window.removeEventListener("beatgaler:playback-cache-cleared", clearPlaybackPreparation);
  }, [clearPlaybackPreparation]);

  useEffect(() => {
    const onAudioPlaying = (event: Event) => {
      const beatId = (event as CustomEvent<{ beatId?: string | null }>).detail?.beatId ?? null;
      if (!beatId) return;
      const runtime = beatRuntimeStatesRef.current[beatId];
      if (runtime?.playback_state === "playback_preparing") transitionRuntime(beatId, { type: "PLAYBACK_PLAYING" });
    };
    const onAudioIdle = (event: Event) => {
      const beatId = (event as CustomEvent<{ beatId?: string | null }>).detail?.beatId ?? null;
      if (!beatId) return;
      const runtime = beatRuntimeStatesRef.current[beatId];
      if (runtime && runtime.playback_state !== "idle") transitionRuntime(beatId, { type: "PLAYBACK_IDLE" });
    };
    const onAudioUnavailable = (event: Event) => {
      const beatId = (event as CustomEvent<{ beatId?: string | null }>).detail?.beatId ?? null;
      if (beatId) {
        const runtime = beatRuntimeStatesRef.current[beatId];
        if (runtime?.playback_state === "playback_preparing" || runtime?.playback_state === "playing") {
          transitionRuntime(beatId, { type: "PLAYBACK_FAILED", code: "AUDIO_SOURCE_UNAVAILABLE", message: "Cloud audio unavailable. The MASTER file could not be loaded from cloud storage.", retryable: true });
        }
      }
      void appAlert({ title: "Beat unavailable", message: "Cloud audio unavailable. The MASTER file could not be loaded from cloud storage.", danger: true });
    };
    window.addEventListener("beatgaler:audio-playing", onAudioPlaying);
    window.addEventListener("beatgaler:audio-idle", onAudioIdle);
    window.addEventListener("beatgaler:audio-unavailable", onAudioUnavailable);
    return () => {
      window.removeEventListener("beatgaler:audio-playing", onAudioPlaying);
      window.removeEventListener("beatgaler:audio-idle", onAudioIdle);
      window.removeEventListener("beatgaler:audio-unavailable", onAudioUnavailable);
    };
  }, [beatRuntimeStatesRef, transitionRuntime]);

  const previousAudioBeatIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousAudioBeatIdRef.current;
    if (previous && previous !== audio.playingId) transitionRuntime(previous, { type: "PLAYBACK_IDLE" });
    previousAudioBeatIdRef.current = audio.playingId;
  }, [audio.playingId, transitionRuntime]);

  const previousEndedSeqRef = useRef(audio.endedSeq);
  useEffect(() => {
    if (audio.endedSeq === previousEndedSeqRef.current) return;
    previousEndedSeqRef.current = audio.endedSeq;
    if (audio.playingId) transitionRuntime(audio.playingId, { type: "PLAYBACK_IDLE" });
  }, [audio.endedSeq, audio.playingId, transitionRuntime]);

  const ensureWarmPlaybackUrl = useCallback((beat: Beat): Promise<string | null> => {
    if (!beat.telegram_file_id) return Promise.resolve(null);
    const cacheEpoch = playbackCacheEpochRef.current;
    const existing = cookingPlaybackUrlRef.current.get(beat.id);
    if (existing?.telegramFileId === beat.telegram_file_id) return Promise.resolve(existing.url);
    const inFlight = cookingWarmPromisesRef.current.get(beat.id);
    if (inFlight) return inFlight;

    const fileId = beat.telegram_file_id;
    if (beat.offline_available) {
      const promise = prepareBeatForPlayback(beat).then(ready => {
        if (!ready.playback_path || playbackCacheEpochRef.current !== cacheEpoch) return null;
        cookingPlaybackUrlRef.current.set(beat.id, { telegramFileId: fileId, url: ready.playback_path });
        return ready.playback_path;
      }).catch(error => {
        console.warn("Offline playback preparation failed:", error);
        return null;
      }).finally(() => cookingWarmPromisesRef.current.delete(beat.id));
      cookingWarmPromisesRef.current.set(beat.id, promise);
      return promise;
    }

    const promise = warmBeatForPlayback(beat).then(prewarmUrl => {
      if (!prewarmUrl || playbackCacheEpochRef.current !== cacheEpoch) return null;
      const url = prewarmUrl.replace(/[?&]prewarm=1(?:&|$)/, "").replace(/[?&]$/, "");
      cookingPlaybackUrlRef.current.set(beat.id, { telegramFileId: fileId, url });
      return url;
    }).catch(error => {
      console.debug("Download Cooking warm skipped:", error);
      return null;
    }).finally(() => cookingWarmPromisesRef.current.delete(beat.id));
    cookingWarmPromisesRef.current.set(beat.id, promise);
    return promise;
  }, []);

  const waitForCookingReady = useCallback(async (beat: Beat, timeoutMs = 12000): Promise<boolean> => {
    if (beat.offline_available || !beat.telegram_file_id) return true;
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      try {
        const status = await getDownloadCookingStatus();
        const entry = status.entries.find(item => item.beat_id === beat.id);
        const urlReady = cookingPlaybackUrlRef.current.get(beat.id)?.telegramFileId === beat.telegram_file_id;
        if (entry && !entry.failed && urlReady && (entry.complete || entry.downloaded_bytes >= status.ready_bytes)) return true;
        if (entry?.failed) return false;
      } catch {}
      await new Promise(resolve => window.setTimeout(resolve, 90));
    }
    return false;
  }, []);

  const waitForUploadedBeatPlaybackReady = useCallback(async (beat: Beat, timeoutMs = 15000): Promise<boolean> => {
    if (!beat.telegram_file_id) return false;
    const started = performance.now();
    void downloadCookingDiagnosticEvent("UPLOAD_PLAYBACK_GATE_BEGIN", beat.id, beat.name, "").catch(() => {});
    while (performance.now() - started < timeoutMs) {
      try {
        const prewarmUrl = await warmBeatForPlayback(beat);
        if (prewarmUrl) {
          const url = prewarmUrl.replace(/[?&]prewarm=1(?:&|$)/, "").replace(/[?&]$/, "");
          cookingPlaybackUrlRef.current.set(beat.id, { telegramFileId: beat.telegram_file_id, url });
        }
        if (await waitForCookingReady(beat, 1400)) {
          void downloadCookingDiagnosticEvent("UPLOAD_PLAYBACK_GATE_READY", beat.id, beat.name, `wait_ms=${(performance.now() - started).toFixed(1)}`).catch(() => {});
          return true;
        }
      } catch (error) {
        console.debug(`Post-upload playback warm retry for ${beat.name}:`, error);
      }
      await new Promise(resolve => window.setTimeout(resolve, 180));
    }
    void downloadCookingDiagnosticEvent("UPLOAD_PLAYBACK_GATE_TIMEOUT", beat.id, beat.name, `wait_ms=${(performance.now() - started).toFixed(1)}`).catch(() => {});
    return false;
  }, [waitForCookingReady]);

  const handleWarm = useCallback((beat: Beat) => {
    if (!platform.capabilities.playbackCache || !cloudSessionVerified || connectionState !== "online") return;
    void ensureWarmPlaybackUrl(beat);
  }, [cloudSessionVerified, connectionState, ensureWarmPlaybackUrl]);

  const handlePlay = useCallback(async (inputBeat: Beat) => {
    const latestBeat = beatsLatestRef.current.find(item => item.id === inputBeat.id) ?? inputBeat;
    playTrace("APP_HANDLE_PLAY_ENTER", { beat_id: inputBeat.id, render_status: inputBeat.cloud_status || null, latest_status: latestBeat.cloud_status || null, slot_busy: isBeatCloudUpdateBusy(inputBeat.id) });
    if (isBeatCloudUpdateBusy(inputBeat.id) || isBeatPlaybackBlocked(inputBeat) || isBeatPlaybackBlocked(latestBeat)) {
      const blocked = isBeatPlaybackBlocked(latestBeat) ? latestBeat : inputBeat;
      const reason = isBeatCloudUpdateBusy(inputBeat.id) ? "SLOT_UPDATE" : String(blocked.cloud_status || "");
      playTrace("APP_HANDLE_PLAY_BLOCKED", { beat_id: blocked.id, reason });
      void downloadCookingDiagnosticEvent("PLAY_BLOCKED_LOADING", blocked.id, blocked.name, reason).catch(() => {});
      return;
    }
    const beat = latestBeat;

    if (!isTauriAvailable) {
      try {
        if (audio.playingId && audio.playingId !== beat.id) platform.media.releasePlayback(audio.playingId);
        playTrace("APP_PREPARE_BEGIN", { beat_id: beat.id });
        const prepared = await platform.media.preparePlayback(beat);
        playTrace("APP_PREPARE_READY", { beat_id: beat.id, url_scheme: String(prepared.url || "").split(":")[0] || null });
        void prepared.completed.catch(error => { console.warn(`[web/playback] stream failed beat_id=${beat.id}`, error); platform.media.releasePlayback(beat.id); });
        playTrace("APP_AUDIO_PLAY_CALL", { beat_id: beat.id });
        play(beat.id, [prepared.url]);
      } catch (error) {
        playTrace("APP_PREPARE_ERROR", { beat_id: beat.id, error_name: error instanceof Error ? error.name : "unknown" });
        platform.media.releasePlayback(beat.id);
        await appAlert({ title: "Beat unavailable", message: sanitizeUserVisibleText(error instanceof Error ? error.message : String(error), "Cloud audio unavailable."), danger: true });
      }
      return;
    }

    const runtime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
    const syncStillBlocksPlayback = runtime.sync_state === "pending_upload" || runtime.sync_state === "deleting" || (runtime.sync_state === "uploading" && !beat.telegram_file_id);
    if (syncStillBlocksPlayback || runtime.playback_state === "playback_preparing") {
      void downloadCookingDiagnosticEvent("PLAY_BLOCKED_RUNTIME_STATE", beat.id, beat.name, `${runtime.sync_state}/${runtime.playback_state}/master=${beat.telegram_file_id ? 1 : 0}`).catch(() => {});
      return;
    }

    const startingPlaybackSession = audio.playingId !== beat.id || runtime.playback_state === "idle" || runtime.playback_state === "error";
    if (startingPlaybackSession) {
      if (audio.playingId && audio.playingId !== beat.id) transitionRuntime(audio.playingId, { type: "PLAYBACK_IDLE" });
      transitionRuntime(beat.id, { type: "PLAYBACK_PREPARING" }, beat);
    }

    const clickedAt = performance.now();
    void downloadCookingDiagnosticEvent("PLAY_CLICK", beat.id, beat.name, "").catch(() => {});
    if (beat.telegram_file_id) {
      const cooked = cookingPlaybackUrlRef.current.get(beat.id);
      if (cooked && cooked.telegramFileId === beat.telegram_file_id) {
        void downloadCookingDiagnosticEvent("PLAY_FAST_PATH", beat.id, beat.name, `prepare_ms=${(performance.now() - clickedAt).toFixed(1)}`).catch(() => {});
        play(beat.id, [cooked.url]);
        return;
      }
    }

    const playbackNeedsCloudDownload = Boolean(beat.telegram_file_id && !beat.offline_available);
    let playbackOwnsDownloadState = false;
    if (playbackNeedsCloudDownload) {
      const downloadRuntime = beatRuntimeStatesRef.current[beat.id] ?? createBeatRuntimeState(beat);
      if (downloadRuntime.download_state !== "downloading") {
        transitionRuntime(beat.id, { type: "DOWNLOAD_STARTED" }, beat);
        playbackOwnsDownloadState = true;
      }
    }

    try {
      const ready = await prepareBeatForPlayback(beat);
      void downloadCookingDiagnosticEvent("PLAY_PREPARED", beat.id, beat.name, `prepare_ms=${(performance.now() - clickedAt).toFixed(1)}`).catch(() => {});
      if (ready.telegram_file_id && ready.playback_path) cookingPlaybackUrlRef.current.set(ready.id, { telegramFileId: ready.telegram_file_id, url: ready.playback_path });
      if (ready.cloud_status !== beat.cloud_status) setBeats(bs => bs.map(b => b.id === ready.id ? { ...b, cloud_status: ready.cloud_status } : b));
      const playbackSources = ready.telegram_file_id ? [ready.playback_path] : [ready.playback_path, ready.mp3_path, ready.wav_path ?? ""];
      if (playbackOwnsDownloadState) transitionRuntime(beat.id, { type: "DOWNLOAD_SUCCEEDED" }, ready);
      play(ready.id, playbackSources);
    } catch (error: unknown) {
      const message = sanitizeUserVisibleText(error instanceof Error ? error.message : String(error), "Cloud audio unavailable.");
      if (playbackOwnsDownloadState) transitionRuntime(beat.id, { type: "DOWNLOAD_FAILED", code: "PLAYBACK_DOWNLOAD_FAILED", message, retryable: true }, beat);
      if (startingPlaybackSession) transitionRuntime(beat.id, { type: "PLAYBACK_FAILED", code: "PLAYBACK_PREPARE_FAILED", message, retryable: true }, beat);
      await appAlert({ title: "Beat unavailable", message, danger: true });
    }
  }, [audio.playingId, beatRuntimeStatesRef, beatsLatestRef, isBeatCloudUpdateBusy, play, setBeats, transitionRuntime]);

  return { clearPlaybackPreparation, ensureWarmPlaybackUrl, handlePlay, handleWarm, invalidatePlaybackPreparation, waitForUploadedBeatPlaybackReady };
}
