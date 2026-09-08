import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { Beat } from "../../types";
import { platform } from "../../platform";
import { cacheArtworkThumbnail, readCachedArtworkThumbnail } from "./artworkThumbnailCache";
import { decodeArtworkDataUrl } from "./decodeArtworkDataUrl";

type ArtworkHydrationOptions = {
  setBeats: Dispatch<SetStateAction<Beat[]>>;
  onNetworkHydrated?: (next: Beat[], beatId: string) => void;
};

export type ArtworkHydration = {
  ensureArtworkReady: (beat: Beat, allowNetwork?: boolean) => Promise<boolean>;
  clearArtworkHydration: () => void;
  invalidateArtworkHydration: (beatId: string) => void;
};

export function useArtworkHydration({ setBeats, onNetworkHydrated }: ArtworkHydrationOptions): ArtworkHydration {
  const loadPromisesRef = useRef<Map<string, Promise<boolean>>>(new Map());

  const clearArtworkHydration = useCallback(() => {
    loadPromisesRef.current.clear();
  }, []);

  const invalidateArtworkHydration = useCallback((beatId: string) => {
    loadPromisesRef.current.delete(beatId);
    loadPromisesRef.current.delete(`${beatId}:cache`);
  }, []);

  const ensureArtworkReady = useCallback((beat: Beat, allowNetwork = true): Promise<boolean> => {
    const promiseKey = allowNetwork ? beat.id : `${beat.id}:cache`;
    const existingPromise = loadPromisesRef.current.get(promiseKey);
    if (existingPromise) return existingPromise;

    const promise = (async () => {
      const existing = beat.image_preview_base64 || beat.image_base64;
      if (existing) {
        const decoded = await decodeArtworkDataUrl(existing);
        if (decoded) void cacheArtworkThumbnail(beat, existing).catch(() => {});
        return decoded;
      }

      const cachedArtwork = await readCachedArtworkThumbnail(beat).catch(() => null);
      if (cachedArtwork) {
        const decoded = await decodeArtworkDataUrl(cachedArtwork);
        if (decoded) {
          setBeats(current => current.map(item => item.id === beat.id
            ? { ...item, image_base64: cachedArtwork, image_preview_base64: null }
            : item));
          return true;
        }
      }

      const hasArtworkReference = Boolean(beat.assets?.artwork?.object_id);
      if (!allowNetwork) return !hasArtworkReference;

      try {
        const artwork = await platform.media.loadArtwork(beat);
        if (!artwork) return true;
        const presentationArtwork = await cacheArtworkThumbnail(beat, artwork).catch(() => artwork);
        const decoded = await decodeArtworkDataUrl(presentationArtwork);
        if (!decoded) return false;
        setBeats(current => {
          const next = current.map(item => item.id === beat.id
            ? { ...item, image_base64: presentationArtwork, image_preview_base64: null }
            : item);
          onNetworkHydrated?.(next, beat.id);
          return next;
        });
        return true;
      } catch (error) {
        console.warn(`Artwork warm failed for ${beat.name}:`, error);
        return false;
      }
    })();

    loadPromisesRef.current.set(promiseKey, promise);
    void promise.then(ok => {
      if (!ok) loadPromisesRef.current.delete(promiseKey);
    });
    return promise;
  }, [onNetworkHydrated, setBeats]);

  return { ensureArtworkReady, clearArtworkHydration, invalidateArtworkHydration };
}
