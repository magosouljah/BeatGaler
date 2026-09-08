import type { Beat } from "../../types";
import { startupCacheContext } from "../perf/directStartupDiagnostics";
import { playTrace } from "../playback/playTrace";
import type { SortKey } from "./components/SortMenu";

const LIBRARY_CACHE_KEY = "beatvault:library:v1";
const SORT_CACHE_KEY = "beatvault:sort:v2";

export function loadCachedBeats(): Beat[] | null {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY);
    if (!raw) {
      playTrace("LIBRARY_CACHE_READ", { library_cache: "miss", ...startupCacheContext("miss") });
      return null;
    }
    const parsed = JSON.parse(raw);
    playTrace("LIBRARY_CACHE_READ", {
      library_cache: Array.isArray(parsed) ? "hit" : "invalid",
      ...startupCacheContext(Array.isArray(parsed) ? "hit" : "invalid"),
      cached_card_count: Array.isArray(parsed) ? parsed.length : 0,
    });
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    playTrace("LIBRARY_CACHE_READ", { library_cache: "unavailable_or_invalid", ...startupCacheContext("unavailable_or_invalid") });
    return null;
  }
}

export function saveCachedBeats(beats: Beat[]): void {
  try {
    // Never serialize full-resolution artwork into localStorage on every edit.
    // The cache only exists for instant paint; SQLite/Telegram remain source of truth.
    const lightweight = beats.map(beat => ({
      ...beat,
      image_base64: null,
      // Artwork bytes live in Cache Storage as bounded thumbnails; keep the manifest metadata-only.
      image_preview_base64: null,
      other_files: [],
    }));
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(lightweight));
  } catch {
    // quota or disabled — ignore
  }
}

export function clearCachedBeats(): void {
  try { localStorage.removeItem(LIBRARY_CACHE_KEY); } catch {}
}

export function loadCachedSort(): SortKey {
  try {
    const raw = localStorage.getItem(SORT_CACHE_KEY);
    return raw === "name" || raw === "bpm" || raw === "rating" || raw === "manual" ? raw : "rating";
  } catch {
    return "rating";
  }
}

export function saveCachedSort(sortBy: SortKey): void {
  try { localStorage.setItem(SORT_CACHE_KEY, sortBy); } catch { /* quota or disabled — ignore */ }
}

export function preserveLoadedArtwork(incoming: Beat[], current: Beat[]): Beat[] {
  const previous = new Map(current.map(beat => [beat.id, beat]));
  return incoming.map(beat => {
    const old = previous.get(beat.id);
    if (!old) return beat;
    if (beat.image_base64 || beat.image_preview_base64) return beat;
    const artwork = old.image_preview_base64 || old.image_base64;
    return artwork
      ? { ...beat, image_base64: old.image_base64 ?? null, image_preview_base64: old.image_preview_base64 ?? null }
      : beat;
  });
}

// Clear upload preview cache when library reload is requested via UI reload button
// (This keeps reload button behavior explicit: refresh disk scan + clear derived previews)
export function clearUploadPreviewCache(): void {
  try { localStorage.removeItem("beatvault:upload-cache:v1"); } catch {}
}
