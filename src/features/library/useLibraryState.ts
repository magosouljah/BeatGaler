import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Beat } from "../../types";
import { readActiveCloudUploads } from "../cloud/interruptedUploadJournal";
import { loadCachedBeats, saveCachedBeats } from "./libraryPresentationCache";

export type LibraryState = {
  beats: Beat[];
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  beatsLatestRef: MutableRefObject<Beat[]>;
  startupCachedBeatsRef: MutableRefObject<Beat[] | null>;
  initialLoading: boolean;
};

export function useLibraryState(): LibraryState {
  // Browser/localStorage library data is an instant-paint presentation cache.
  // It may render before cloud authority resolves, but remains read-only until
  // verification and is never allowed to overwrite the authoritative library.
  const startupCachedBeatsRef = useRef<Beat[] | null>(null);
  if (startupCachedBeatsRef.current === null) {
    const cached = loadCachedBeats() ?? [];
    const interruptedIds = new Set(readActiveCloudUploads().map(item => item.beatId));
    startupCachedBeatsRef.current = interruptedIds.size > 0
      ? cached.filter(beat => !interruptedIds.has(beat.id))
      : cached;
  }

  const [beats, setBeats] = useState<Beat[]>(() => startupCachedBeatsRef.current ?? []);

  // Preserve the old startup behavior exactly: App used a second cache read to
  // decide whether the loading state starts visible. Keep that read one-time.
  const initialLoadingRef = useRef<boolean | null>(null);
  if (initialLoadingRef.current === null) {
    initialLoadingRef.current = loadCachedBeats() === null;
  }

  // This ref intentionally starts empty. App preserves the existing update
  // moments: some operations publish to it synchronously inside setBeats, while
  // the normal render path updates it in the existing [beats] effect.
  const beatsLatestRef = useRef<Beat[]>([]);

  return {
    beats,
    setBeats,
    beatsLatestRef,
    startupCachedBeatsRef,
    initialLoading: initialLoadingRef.current,
  };
}

export function useLibraryPresentationCache(
  beats: Beat[],
  cloudSessionVerified: boolean,
  cloudPresentationBlocked: boolean,
): void {
  const cacheSaveTimerRef = useRef<number | null>(null);

  // localStorage is synchronous and blocks the UI thread. Debounce it and store
  // a lightweight version without full artwork instead of serializing megabytes
  // of base64 on every small metadata change.
  useEffect(() => {
    if (cacheSaveTimerRef.current) window.clearTimeout(cacheSaveTimerRef.current);

    // Hiding the cloud library while disconnected is a view decision, not a
    // destructive cache mutation. Preserve the last verified instant-paint cache.
    if (!cloudSessionVerified || cloudPresentationBlocked) return;

    cacheSaveTimerRef.current = window.setTimeout(() => {
      cacheSaveTimerRef.current = null;
      saveCachedBeats(beats);
    }, 1500);

    return () => {
      if (cacheSaveTimerRef.current) {
        window.clearTimeout(cacheSaveTimerRef.current);
        cacheSaveTimerRef.current = null;
      }
    };
  }, [beats, cloudPresentationBlocked, cloudSessionVerified]);
}
