import { useCallback, useEffect, useRef, useState } from "react";
import type { Beat } from "../../types";

export type ImportReviewQueueState = {
  beats: Beat[];
  index: number;
  // Streaming discovery intentionally does not know N when Beat 1 appears.
  total: number | null;
  batchId: string | null;
  preparing: boolean;
};

export function reviewSourceKey(beat: Beat): string {
  return (beat.mp3_path || beat.wav_path || beat.playback_path || "")
    .replace(/\\/g, "/")
    .trim()
    .toLocaleLowerCase();
}

type StartReviewOptions = {
  total?: number | null;
  batchId?: string | null;
  preparing?: boolean;
};

export function useImportSession() {
  const [reviewQueue, setReviewQueue] = useState<ImportReviewQueueState | null>(null);
  // Background uploads can finish while Review is still open. Keep the
  // latest queue readable by the upload/staging bridge until later import
  // tasks can own that coordination directly.
  const reviewQueueLatestRef = useRef<ImportReviewQueueState | null>(null);
  const skippedReviewSourceKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    reviewQueueLatestRef.current = reviewQueue;
  }, [reviewQueue]);

  const startReview = useCallback((beats: Beat[], options: StartReviewOptions = {}) => {
    if (beats.length === 0) {
      setReviewQueue(null);
      return;
    }
    setReviewQueue({
      beats,
      index: 0,
      total: options.total === undefined ? beats.length : options.total,
      batchId: options.batchId ?? null,
      preparing: options.preparing ?? false,
    });
  }, []);

  return {
    reviewQueue,
    setReviewQueue,
    reviewQueueLatestRef,
    skippedReviewSourceKeysRef,
    startReview,
  };
}

export type ImportSession = ReturnType<typeof useImportSession>;
