import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Beat } from "../../types";
import { dismissBeatGalerStartupLoader } from "./startupLoader";

type RevealSettings = {
  telegram_cloud_connected?: boolean;
};

type UseLibraryRevealOptions = {
  initialCachedBeats: Beat[];
  filteredBeats: Beat[];
  loading: boolean;
  settings: RevealSettings | null;
  cloudSessionVerified: boolean;
  connectionState: string;
  ensureArtworkReady: (beat: Beat, allowNetwork: boolean) => Promise<boolean>;
  startupCookingResolvedRef: MutableRefObject<boolean>;
  startupPipelineStartedRef: MutableRefObject<boolean>;
  nativeParallelism: number;
};

export function useLibraryReveal({
  initialCachedBeats,
  filteredBeats,
  loading,
  settings,
  cloudSessionVerified,
  connectionState,
  ensureArtworkReady,
  startupCookingResolvedRef,
  startupPipelineStartedRef,
  nativeParallelism,
}: UseLibraryRevealOptions) {
  const [startupCookingGate, setStartupCookingGate] = useState(() => initialCachedBeats.length === 0);
  const [revealedBeatIds, setRevealedBeatIds] = useState<Set<string>>(() => new Set(
    initialCachedBeats
      .filter(beat => Boolean(beat.image_preview_base64 || beat.image_base64))
      .map(beat => beat.id)
  ));
  const progressiveRevealRunRef = useRef(0);
  const filteredBeatIdsKey = filteredBeats.map(beat => beat.id).join("|");

  const revealBeat = useCallback((beatId: string) => {
    setRevealedBeatIds(current => {
      if (current.has(beatId)) return current;
      const next = new Set(current);
      next.add(beatId);
      return next;
    });
  }, []);

  // Instant paint is presentation-only: use local artwork/cache and never wait for audio.
  useEffect(() => {
    if (filteredBeats.length === 0) return;
    let cancelled = false;
    const queue = filteredBeats.filter(beat => !revealedBeatIds.has(beat.id));

    void Promise.all(queue.map(async beat => {
      const ready = await ensureArtworkReady(beat, false);
      if (!cancelled && ready) revealBeat(beat.id);
    })).then(() => {
      if (!cancelled) {
        setStartupCookingGate(false);
        dismissBeatGalerStartupLoader();
      }
    });

    return () => { cancelled = true; };
    // revealedBeatIds intentionally stays out of deps: one cache sweep per library shape.
  }, [filteredBeatIdsKey, ensureArtworkReady, revealBeat]);

  // Authority pass: title + artwork reveal a card. Audio remains a later viewport warmup.
  useEffect(() => {
    if (loading || settings === null) return;

    if (connectionState === "checking") {
      if (filteredBeats.length === 0) setStartupCookingGate(true);
      return;
    }

    if (connectionState !== "online" || !settings.telegram_cloud_connected) {
      setRevealedBeatIds(new Set(filteredBeats.map(beat => beat.id)));
      startupCookingResolvedRef.current = true;
      startupPipelineStartedRef.current = false;
      setStartupCookingGate(false);
      dismissBeatGalerStartupLoader();
      return;
    }

    if (!cloudSessionVerified) {
      setStartupCookingGate(filteredBeats.length === 0);
      return;
    }

    startupCookingResolvedRef.current = true;
    startupPipelineStartedRef.current = false;
    setStartupCookingGate(false);
    dismissBeatGalerStartupLoader();

    if (filteredBeats.length === 0) return;

    const runId = ++progressiveRevealRunRef.current;
    const queue = filteredBeats.filter(beat =>
      !beat.image_base64 && !beat.image_preview_base64
    );
    let cursor = 0;
    const workerCount = Math.min(nativeParallelism, queue.length);

    const worker = async () => {
      while (cursor < queue.length) {
        const index = cursor++;
        const beat = queue[index];
        if (!beat || progressiveRevealRunRef.current !== runId) return;

        let ready = false;
        for (let attempt = 0; attempt < 4 && !ready; attempt += 1) {
          ready = await ensureArtworkReady(beat, true);
          if (ready || progressiveRevealRunRef.current !== runId) break;
          const delay = [350, 900, 1800, 3200][attempt] ?? 3200;
          await new Promise(resolve => window.setTimeout(resolve, delay));
        }

        if (progressiveRevealRunRef.current !== runId) return;
        if (ready) revealBeat(beat.id);
      }
    };

    void Promise.all(Array.from({ length: workerCount }, () => worker()));

    return () => {
      if (progressiveRevealRunRef.current === runId) progressiveRevealRunRef.current += 1;
    };
    // revealedBeatIds intentionally stays out of deps so each reveal does not restart workers.
  }, [
    loading, settings, cloudSessionVerified, connectionState, filteredBeatIdsKey,
    ensureArtworkReady, revealBeat, nativeParallelism,
  ]);

  return {
    startupCookingGate,
    setStartupCookingGate,
    revealedBeatIds,
    setRevealedBeatIds,
    progressiveRevealRunRef,
  };
}
