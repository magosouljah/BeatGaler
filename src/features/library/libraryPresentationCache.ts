import type { Beat } from "../../types";
import { startupCacheContext } from "../perf/directStartupDiagnostics";
import { playTrace } from "../playback/playTrace";
import { getActiveWebAccountId } from "../auth/activeWebAccount";
import { traceCacheOwner } from "../auth/cacheOwnerTrace";
import type { SortKey } from "./components/SortMenu";

const LIBRARY_CACHE_KEY = "beatvault:library:v1";
const WEB_LIBRARY_CACHE_PREFIX = "beatvault:library:v2:";
const SORT_CACHE_KEY = "beatvault:sort:v2";

function isWeb(): boolean {
  return typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__;
}

function cacheOwner(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = (value as Record<string, unknown>).owner_user_id;
  return typeof owner === "string" && owner.trim() ? owner : null;
}

function libraryCacheKey(accountId = getActiveWebAccountId()): string | null {
  if (isWeb()) {
    return accountId ? `${WEB_LIBRARY_CACHE_PREFIX}${encodeURIComponent(accountId)}` : null;
  }
  return LIBRARY_CACHE_KEY;
}

export function loadCachedBeats(accountId?: string | null): Beat[] | null {
  try {
    const confirmedUserId = getActiveWebAccountId();
    if (isWeb() && (!confirmedUserId || (accountId !== undefined && accountId !== confirmedUserId))) {
      traceCacheOwner("CACHE_OWNER_REJECT", "library", null, confirmedUserId, "identity_unconfirmed_or_changed");
      return null;
    }
    const key = libraryCacheKey(accountId);
    if (!key) return null;
    playTrace("CACHE_READ_START");
    const raw = localStorage.getItem(key);
    if (!raw) {
      if (isWeb()) traceCacheOwner("CACHE_OWNER_READ", "library", null, confirmedUserId, "missing");
      playTrace("CACHE_READ_READY", { result: "miss" });
      playTrace("LIBRARY_CACHE_READ", { library_cache: "miss", ...startupCacheContext("miss") });
      return null;
    }
    const parsed = JSON.parse(raw);
    const ownerUserId = cacheOwner(parsed);
    if (isWeb()) traceCacheOwner("CACHE_OWNER_READ", "library", ownerUserId, confirmedUserId);
    const beats = isWeb()
      ? ownerUserId === confirmedUserId && parsed.version === 2 && Array.isArray(parsed.beats) ? parsed.beats as Beat[] : null
      : Array.isArray(parsed) ? parsed as Beat[] : null;
    if (isWeb()) traceCacheOwner(
      beats ? "CACHE_OWNER_ACCEPT" : "CACHE_OWNER_REJECT",
      "library",
      ownerUserId,
      confirmedUserId,
      beats ? undefined : ownerUserId === null ? "unowned" : "owner_mismatch_or_invalid",
    );
    const result = beats ? "hit" : isWeb() && ownerUserId !== confirmedUserId ? "miss" : "invalid";
    playTrace("CACHE_READ_READY", { result, count: beats?.length || 0 });
    playTrace("LIBRARY_CACHE_READ", {
      library_cache: result,
      ...startupCacheContext(result),
      cached_card_count: beats?.length || 0,
    });
    return beats;
  } catch {
    if (isWeb()) traceCacheOwner("CACHE_OWNER_REJECT", "library", null, getActiveWebAccountId(), "unavailable_or_invalid");
    playTrace("CACHE_READ_READY", { result: "unavailable_or_invalid" });
    playTrace("LIBRARY_CACHE_READ", { library_cache: "unavailable_or_invalid", ...startupCacheContext("unavailable_or_invalid") });
    return null;
  }
}

export function saveCachedBeats(beats: Beat[], accountId?: string | null): void {
  try {
    const confirmedUserId = getActiveWebAccountId();
    if (isWeb() && (!confirmedUserId || (accountId !== undefined && accountId !== confirmedUserId))) return;
    const key = libraryCacheKey(accountId);
    if (!key) return;
    // Never serialize full-resolution artwork into localStorage on every edit.
    // The cache only exists for instant paint; SQLite/Telegram remain source of truth.
    const lightweight = beats.map(beat => ({
      ...beat,
      image_base64: null,
      // Artwork bytes live in Cache Storage as bounded thumbnails; keep the manifest metadata-only.
      image_preview_base64: null,
      other_files: [],
    }));
    localStorage.setItem(key, JSON.stringify(isWeb()
      ? { version: 2, owner_user_id: confirmedUserId, beats: lightweight }
      : lightweight));
  } catch {
    // quota or disabled — ignore
  }
}

export function clearCachedBeats(accountId?: string | null): void {
  try {
    const key = libraryCacheKey(accountId);
    if (key) localStorage.removeItem(key);
  } catch {}
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
