from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    text = read(path)
    start_index = text.find(start)
    if start_index < 0:
        raise RuntimeError(f"{path}: start marker not found: {start!r}")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise RuntimeError(f"{path}: end marker not found: {end!r}")
    write(path, text[:start_index] + replacement + text[end_index:])


# ---------------------------------------------------------------------------
# Persistent artwork thumbnail cache: presentation-only, <= 250 KB per cover.
# ---------------------------------------------------------------------------
artwork_cache = r'''import type { Beat } from "../../types";

export const MAX_ARTWORK_THUMBNAIL_BYTES = 250 * 1024;
const ARTWORK_CACHE_NAME = "beatgaler-artwork-thumbnails-v1";
const activeObjectUrls = new Map<string, string>();

type ArtworkIdentity = Pick<Beat, "id" | "assets">;

export function artworkThumbnailCacheKey(beat: ArtworkIdentity): string | null {
  const objectId = beat.assets?.artwork?.object_id?.trim();
  if (!objectId) return null;
  return `${beat.id}:${objectId}`;
}

function cacheSupported(): boolean {
  return typeof window !== "undefined" && typeof caches !== "undefined" && typeof URL?.createObjectURL === "function";
}

function requestForKey(key: string): Request {
  const url = new URL(`/__beatgaler-cache/artwork/${encodeURIComponent(key)}`, window.location.origin);
  return new Request(url.toString(), { method: "GET" });
}

function objectUrlFor(key: string, blob: Blob): string {
  const previous = activeObjectUrls.get(key);
  if (previous) URL.revokeObjectURL(previous);
  const next = URL.createObjectURL(blob);
  activeObjectUrls.set(key, next);
  return next;
}

async function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function compressArtwork(blob: Blob): Promise<Blob | null> {
  if (blob.size <= MAX_ARTWORK_THUMBNAIL_BYTES) return blob;
  if (typeof createImageBitmap !== "function") return null;

  const bitmap = await createImageBitmap(blob);
  try {
    const maxSourceEdge = Math.max(bitmap.width, bitmap.height, 1);
    const edges = [512, 448, 384, 320, 256];
    const qualities = [0.84, 0.72, 0.60, 0.48, 0.36];
    let smallest: Blob | null = null;

    for (const edge of edges) {
      const scale = Math.min(1, edge / maxSourceEdge);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) continue;
      context.drawImage(bitmap, 0, 0, width, height);

      for (const quality of qualities) {
        const candidate = await canvasBlob(canvas, "image/webp", quality)
          ?? await canvasBlob(canvas, "image/jpeg", quality);
        if (!candidate) continue;
        if (!smallest || candidate.size < smallest.size) smallest = candidate;
        if (candidate.size <= MAX_ARTWORK_THUMBNAIL_BYTES) return candidate;
      }
    }

    return smallest && smallest.size <= MAX_ARTWORK_THUMBNAIL_BYTES ? smallest : null;
  } finally {
    bitmap.close();
  }
}

export async function readCachedArtworkThumbnail(beat: ArtworkIdentity): Promise<string | null> {
  const key = artworkThumbnailCacheKey(beat);
  if (!key || !cacheSupported()) return null;

  const active = activeObjectUrls.get(key);
  if (active) return active;

  try {
    const cache = await caches.open(ARTWORK_CACHE_NAME);
    const response = await cache.match(requestForKey(key));
    if (!response) return null;
    const blob = await response.blob();
    if (blob.size <= 0 || blob.size > MAX_ARTWORK_THUMBNAIL_BYTES) {
      await cache.delete(requestForKey(key));
      return null;
    }
    return objectUrlFor(key, blob);
  } catch {
    return null;
  }
}

export async function cacheArtworkThumbnail(beat: ArtworkIdentity, source: string): Promise<string> {
  const key = artworkThumbnailCacheKey(beat);
  if (!key || !cacheSupported()) return source;

  try {
    const original = await fetch(source).then(response => response.blob());
    const thumbnail = await compressArtwork(original);
    if (!thumbnail || thumbnail.size > MAX_ARTWORK_THUMBNAIL_BYTES) return source;

    const cache = await caches.open(ARTWORK_CACHE_NAME);
    await cache.put(requestForKey(key), new Response(thumbnail, {
      headers: {
        "Content-Type": thumbnail.type || "image/jpeg",
        "Content-Length": String(thumbnail.size),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }));
    return objectUrlFor(key, thumbnail);
  } catch {
    return source;
  }
}
'''
(ROOT / "src/features/artwork/artworkThumbnailCache.ts").write_text(artwork_cache, encoding="utf-8")

# ---------------------------------------------------------------------------
# App: instant manifest paint, stable positions, artwork-only reveal.
# ---------------------------------------------------------------------------
replace_once(
    "src/App.tsx",
    'import { fetchInternetArtworkDataUrl } from "./features/artwork/internetArtwork";\n',
    'import { fetchInternetArtworkDataUrl } from "./features/artwork/internetArtwork";\n'
    'import { cacheArtworkThumbnail, readCachedArtworkThumbnail } from "./features/artwork/artworkThumbnailCache";\n',
)

replace_once(
    "src/App.tsx",
    '      // Keep the small preview when available so cards can still paint quickly.\n      image_preview_base64: beat.image_preview_base64 ?? null,\n',
    '      // Artwork bytes live in Cache Storage as bounded thumbnails; keep the manifest metadata-only.\n      image_preview_base64: null,\n',
)

replace_once("src/App.tsx", "const STARTUP_PRIORITY_BEATS = 6;\n\n", "")
app = read("src/App.tsx")
app, removed = re.subn(
    r'function GalleryStartupSkeleton\(\) \{.*?\n\}\n\nfunction BeatGalerApp\(\)',
    'function BeatGalerApp()',
    app,
    count=1,
    flags=re.S,
)
if removed != 1:
    raise RuntimeError(f"src/App.tsx: expected to remove one GalleryStartupSkeleton, removed {removed}")
write("src/App.tsx", app)

replace_once(
    "src/App.tsx",
    '  const [beats, setBeats] = useState<Beat[]>([]);\n',
    '  const [beats, setBeats] = useState<Beat[]>(() => startupCachedBeatsRef.current ?? []);\n',
)
replace_once(
    "src/App.tsx",
    '  const [startupCookingGate, setStartupCookingGate] = useState(true);\n  const [revealedBeatIds, setRevealedBeatIds] = useState<Set<string>>(() => new Set());\n',
    '  const [startupCookingGate, setStartupCookingGate] = useState(() => (startupCachedBeatsRef.current ?? []).length === 0);\n'
    '  const [revealedBeatIds, setRevealedBeatIds] = useState<Set<string>>(() => new Set(\n'
    '    (startupCachedBeatsRef.current ?? [])\n'
    '      .filter(beat => Boolean(beat.image_preview_base64 || beat.image_base64) || !beat.assets?.artwork?.object_id)\n'
    '      .map(beat => beat.id)\n'
    '  ));\n',
)
replace_once(
    "src/App.tsx",
    '  const { state: audio, play, primeAudioEngine, togglePause, seek, setVolume, releaseFile } = useAudio();\n',
    '  const { state: audio, play, togglePause, seek, setVolume, releaseFile } = useAudio();\n',
)

# Preserve cached presentation while authority verifies instead of hiding it again.
replace_once(
    "src/App.tsx",
    '        startupCookingResolvedRef.current = false;\n        startupPipelineStartedRef.current = false;\n        startupEnginePrimeReadyRef.current = false;\n        progressiveRevealRunRef.current += 1;\n        setRevealedBeatIds(new Set());\n        setStartupCookingGate(true);\n',
    '        startupCookingResolvedRef.current = false;\n        startupPipelineStartedRef.current = false;\n        startupEnginePrimeReadyRef.current = false;\n        progressiveRevealRunRef.current += 1;\n        setStartupCookingGate((startupCachedBeatsRef.current ?? []).length === 0);\n',
)
replace_once(
    "src/App.tsx",
    '      startupCookingResolvedRef.current = false;\n      startupPipelineStartedRef.current = false;\n      startupEnginePrimeReadyRef.current = false;\n      progressiveRevealRunRef.current += 1;\n      cookingWarmPromisesRef.current.clear();\n      cookingPlaybackUrlRef.current.clear();\n      artworkLoadPromisesRef.current.clear();\n      setRevealedBeatIds(new Set());\n      setStartupCookingGate(true);\n',
    '      startupCookingResolvedRef.current = false;\n      startupPipelineStartedRef.current = false;\n      startupEnginePrimeReadyRef.current = false;\n      progressiveRevealRunRef.current += 1;\n      cookingWarmPromisesRef.current.clear();\n      cookingPlaybackUrlRef.current.clear();\n      artworkLoadPromisesRef.current.clear();\n      setStartupCookingGate(false);\n',
)
replace_once(
    "src/App.tsx",
    '          startupCookingResolvedRef.current = false;\n          startupPipelineStartedRef.current = false;\n          startupEnginePrimeReadyRef.current = false;\n          artworkLoadPromisesRef.current.clear();\n          cookingWarmPromisesRef.current.clear();\n          cookingPlaybackUrlRef.current.clear();\n          progressiveRevealRunRef.current += 1;\n          setRevealedBeatIds(new Set());\n          setStartupCookingGate(true);\n          setCloudSessionVerified(false);\n          setBeats([]);\n',
    '          startupCookingResolvedRef.current = false;\n          startupPipelineStartedRef.current = false;\n          startupEnginePrimeReadyRef.current = false;\n          artworkLoadPromisesRef.current.clear();\n          cookingWarmPromisesRef.current.clear();\n          cookingPlaybackUrlRef.current.clear();\n          progressiveRevealRunRef.current += 1;\n          setStartupCookingGate(false);\n          setCloudSessionVerified(false);\n',
)

# Save only verified manifests; cached presentation itself must never become authority.
replace_once(
    "src/App.tsx",
    '    if (settings && !settings.telegram_cloud_connected) return;\n',
    '    if (!cloudSessionVerified || (settings && !settings.telegram_cloud_connected)) return;\n',
)
replace_once(
    "src/App.tsx",
    '  }, [beats, settings?.telegram_cloud_connected]);\n',
    '  }, [beats, settings?.telegram_cloud_connected, cloudSessionVerified]);\n',
)

# Artwork readiness now checks the bounded persistent thumbnail cache before network.
ensure_artwork = r'''  const ensureArtworkReady = useCallback((beat: Beat, allowNetwork = true): Promise<boolean> => {
    const promiseKey = allowNetwork ? beat.id : `${beat.id}:cache`;
    const existingPromise = artworkLoadPromisesRef.current.get(promiseKey);
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
        if (!artwork) return true; // This beat genuinely has no artwork; gradient fallback is ready.
        const presentationArtwork = await cacheArtworkThumbnail(beat, artwork).catch(() => artwork);
        const decoded = await decodeArtworkDataUrl(presentationArtwork);
        if (!decoded) return false;
        setBeats(current => {
          const next = current.map(item => item.id === beat.id
            ? { ...item, image_base64: presentationArtwork, image_preview_base64: null }
            : item);
          const hydrated = next.find(item => item.id === beat.id);
          if (hydrated && cloudMetaSnapshotRef.current) {
            cloudMetaSnapshotRef.current.set(beat.id, cloudBeatFingerprint(hydrated));
          }
          if (cloudLibrarySnapshotRef.current !== null) {
            cloudLibrarySnapshotRef.current = next
              .filter(item => !!item.telegram_file_id)
              .map(cloudBeatFingerprint)
              .join("\u001c");
          }
          return next;
        });
        return true;
      } catch (error) {
        console.warn(`Artwork warm failed for ${beat.name}:`, error);
        return false;
      }
    })();

    artworkLoadPromisesRef.current.set(promiseKey, promise);
    void promise.then(ok => { if (!ok) artworkLoadPromisesRef.current.delete(promiseKey); });
    return promise;
  }, []);

'''
replace_between(
    "src/App.tsx",
    '  const ensureArtworkReady = useCallback((beat: Beat): Promise<boolean> => {\n',
    '  const waitForCookingReady = useCallback',
    ensure_artwork,
)

# Replace collective six-card/audio gate + serial reveal with stable-slot artwork reveal.
reveal_block = r'''  const filteredBeatIdsKey = filteredBeats.map(beat => beat.id).join("|");
  const displayedBeats = filteredBeats.filter(beat => revealedBeatIds.has(beat.id));

  const revealBeat = useCallback((beatId: string) => {
    setRevealedBeatIds(current => {
      if (current.has(beatId)) return current;
      const next = new Set(current);
      next.add(beatId);
      return next;
    });
  }, []);

  // Instant-paint pass: use only local presentation cache while cloud authority
  // is still resolving. This never mutates the source of truth and never starts
  // an audio download. Every BeatCard is already mounted invisibly in its final
  // slot, so cards can appear independently without reflowing the grid.
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

  // Authority/reveal pass: title + artwork are enough to show a beat. Audio is
  // deliberately NOT part of this gate. Once a visible card enters the viewport,
  // BeatCard's existing IntersectionObserver calls onWarm and the progressive
  // audio/chunk path continues exactly as before.
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

    // Cached cards may stay visible while this is false, but confirmed-empty UI
    // remains forbidden until the authoritative INDEX resolves.
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
    const queue = filteredBeats.filter(beat => !revealedBeatIds.has(beat.id));
    let cursor = 0;
    const workerCount = Math.min(isTauriAvailable ? 6 : 3, queue.length);

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
    ensureArtworkReady, revealBeat,
  ]);


'''
replace_between(
    "src/App.tsx",
    '  const filteredBeatIdsKey = filteredBeats.map(beat => beat.id).join("|");\n',
    '  // The player/queue must never outlive the authoritative gallery.',
    reveal_block,
)

# Grid renders all known beats in their final slots. Hidden cards occupy exact geometry.
replace_once(
    "src/App.tsx",
    '        data-library-scroll="true"\n        style=',
    '        data-library-scroll="true"\n        aria-busy={startupCookingGate || (connectionState === "online" && !cloudSessionVerified)}\n        style=',
)
replace_once(
    "src/App.tsx",
    '        {((loading && !cloudSessionVerified) || (startupCookingGate && beats.length > 0) || (filteredBeats.length > 0 && displayedBeats.length === 0)) ? (\n          <GalleryStartupSkeleton />\n        ) : filteredBeats.length === 0 ? (\n',
    '        {filteredBeats.length === 0 ? (\n',
)
replace_once(
    "src/App.tsx",
    '''            {beats.length === 0 ? (\n              <div>\n                <div style={{ fontSize: 15, color: "#555", fontWeight: 500 }}>Empty Gallery</div>\n                <div style={{ marginTop: 7, fontSize: 12, color: "#2f2f2f" }}>\n                  {settings?.telegram_cloud_connected\n                    ? "Add a beat to start your library."\n                    : "BeatGaler Cloud is currently unavailable."}\n                </div>\n              </div>\n            ) : <div style={{ fontSize: 13 }}>No beats match your search</div>}\n''',
    '''            {beats.length === 0 ? (\n              cloudSessionVerified && connectionState === "online" ? (\n                <div>\n                  <div style={{ fontSize: 15, color: "#555", fontWeight: 500 }}>Empty Gallery</div>\n                  <div style={{ marginTop: 7, fontSize: 12, color: "#2f2f2f" }}>Add a beat to start your library.</div>\n                </div>\n              ) : connectionState === "offline" || connectionState === "poor" ? (\n                <div>\n                  <div style={{ fontSize: 15, color: "#555", fontWeight: 500 }}>No offline beats available</div>\n                  <div style={{ marginTop: 7, fontSize: 12, color: "#2f2f2f" }}>Reconnect to verify your Galer Cloud library.</div>\n                </div>\n              ) : (\n                <div aria-label="Loading beat library" style={{ minHeight: 1 }} />\n              )\n            ) : <div style={{ fontSize: 13 }}>No beats match your search</div>}\n''',
)
replace_once(
    "src/App.tsx",
    '<SortableContext items={displayedBeats.map((b) => b.id)} strategy={rectSortingStrategy}>',
    '<SortableContext items={filteredBeats.map((b) => b.id)} strategy={rectSortingStrategy}>',
)
replace_once(
    "src/App.tsx",
    '                {displayedBeats.map((beat, i) => (\n                  <BeatCard\n                    key={beat.id}\n                    beat={beat}\n',
    '                {filteredBeats.map((beat, i) => (\n                  <BeatCard\n                    key={beat.id}\n                    beat={beat}\n                    visible={revealedBeatIds.has(beat.id)}\n',
)
replace_once(
    "src/App.tsx",
    '                    onToggleSelect={(b, e) => handleToggleSelect(b, e, displayedBeats)}\n                    animDelay={i * 0.02}\n',
    '                    onToggleSelect={(b, e) => handleToggleSelect(b, e, filteredBeats)}\n                    animDelay={0}\n',
)

# ---------------------------------------------------------------------------
# BeatCard: hidden cards reserve exact layout but do zero warm/project work.
# ---------------------------------------------------------------------------
replace_once(
    "src/components/BeatCard.tsx",
    'interface Props {\n  beat: Beat;\n',
    'interface Props {\n  beat: Beat;\n  visible?: boolean;\n',
)
replace_once(
    "src/components/BeatCard.tsx",
    '  beat, cloudUploadErrorDetail, tagFrequency, showIncompleteWarnings, openableProject = false, playing, selected, selectedCount, selectMode,\n',
    '  beat, visible = true, cloudUploadErrorDetail, tagFrequency, showIncompleteWarnings, openableProject = false, playing, selected, selectedCount, selectMode,\n',
)
replace_once(
    "src/components/BeatCard.tsx",
    '  } = useSortable({ id: beat.id, disabled: !dragEnabled });\n',
    '  } = useSortable({ id: beat.id, disabled: !dragEnabled || !visible });\n',
)
replace_once(
    "src/components/BeatCard.tsx",
    '    if (!node || hasEnteredViewport) return;\n',
    '    if (!visible || !node || hasEnteredViewport) return;\n',
)
replace_once(
    "src/components/BeatCard.tsx",
    '  }, [hasEnteredViewport]);\n\n  useEffect(() => {\n    if (!hasEnteredViewport || !beat.telegram_file_id) return;\n',
    '  }, [visible, hasEnteredViewport]);\n\n  useEffect(() => {\n    if (!visible || !hasEnteredViewport || !beat.telegram_file_id) return;\n',
)
replace_once(
    "src/components/BeatCard.tsx",
    '  }, [hasEnteredViewport, beat.id, beat.telegram_file_id, onWarm]);\n\n  // PROJECT validation',
    '  }, [visible, hasEnteredViewport, beat.id, beat.telegram_file_id, onWarm]);\n\n  // PROJECT validation',
)
replace_once(
    "src/components/BeatCard.tsx",
    '    if (!hasEnteredViewport) return;\n    if (!canInspectNativeProject) {\n',
    '    if (!visible || !hasEnteredViewport) return;\n    if (!canInspectNativeProject) {\n',
)
replace_once(
    "src/components/BeatCard.tsx",
    '  }, [hasEnteredViewport, beat.id, beat.flp_path, beat.folder_path, beat.cloud_status, canInspectNativeProject]);\n',
    '  }, [visible, hasEnteredViewport, beat.id, beat.flp_path, beat.folder_path, beat.cloud_status, canInspectNativeProject]);\n',
)
replace_once(
    "src/components/BeatCard.tsx",
    '      data-beat-card-id={beat.id}\n',
    '      data-beat-slot-id={beat.id}\n      data-beat-card-id={visible ? beat.id : undefined}\n',
)
replace_once(
    "src/components/BeatCard.tsx",
    '        cursor: selectMode ? "pointer" : "default",\n        animation: "fadeUp 0.36s cubic-bezier(0.22, 1, 0.36, 1)",\n        animationDelay: `${animDelay}s`,\n        borderRadius: 12,\n',
    '        cursor: visible && selectMode ? "pointer" : "default",\n        visibility: visible ? "visible" : "hidden",\n        pointerEvents: visible ? "auto" : "none",\n        borderRadius: 12,\n',
)

# ---------------------------------------------------------------------------
# Concurrent authoritative requests share one in-flight read instead of queueing
# a duplicate reload immediately after startup.
# ---------------------------------------------------------------------------
replace_once(
    "src/lib/libraryStateManager.ts",
    '  private sequence = 0;\n  private lastVerified: Beat[] | null = null;\n',
    '  private sequence = 0;\n  private lastVerified: Beat[] | null = null;\n  private reloadInFlight: Promise<Beat[]> | null = null;\n',
)
replace_between(
    "src/lib/libraryStateManager.ts",
    '  async reloadAuthoritative(): Promise<Beat[]> {\n',
    '  async commitSnapshot',
    r'''  reloadAuthoritative(): Promise<Beat[]> {
    if (this.reloadInFlight) return this.reloadInFlight;

    const pending = this.exclusive("reload", async () => {
      await platform.library.restoreAuthoritative();
      const restored = await platform.library.load();
      this.lastVerified = restored.slice();
      return restored;
    });
    this.reloadInFlight = pending;
    void pending.finally(() => {
      if (this.reloadInFlight === pending) this.reloadInFlight = null;
    }).catch(() => {});
    return pending;
  }

''',
)

# ---------------------------------------------------------------------------
# Nginx must stream WASM with the correct MIME so instantiateStreaming stays fast.
# ---------------------------------------------------------------------------
replace_once(
    "deploy/web/beatgaler.com.conf",
    '''    location /assets/ {\n        expires 1y;\n        add_header Cache-Control "public, max-age=31536000, immutable" always;\n        try_files $uri =404;\n    }\n''',
    '''    location ~* ^/assets/.*\\.wasm$ {\n        default_type application/wasm;\n        expires 1y;\n        add_header Cache-Control "public, max-age=31536000, immutable" always;\n        try_files $uri =404;\n    }\n\n    location /assets/ {\n        expires 1y;\n        add_header Cache-Control "public, max-age=31536000, immutable" always;\n        try_files $uri =404;\n    }\n''',
)

# ---------------------------------------------------------------------------
# Tests: coalescing behavior + 250 KB cache contract + static reveal architecture.
# ---------------------------------------------------------------------------
core_test = read("tests/integration/coreIntegration.test.tsx")
needle = '''  it("serializes competing commits so the second INDEX transaction cannot overtake the first", async () => {\n'''
insert = r'''  it("coalesces concurrent authoritative reloads instead of queueing the same startup read twice", async () => {
    const gate = deferred<void>();
    const restore = vi.fn(() => gate.promise);
    const load = vi.fn(async () => [makeBeat()]);
    const { libraryStateManager } = await loadLibraryManager({ restore, load });

    const first = libraryStateManager.reloadAuthoritative();
    const second = libraryStateManager.reloadAuthoritative();

    await waitForCondition(() => restore.mock.calls.length === 1, "authoritative reload never started");
    expect(restore).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    const [one, two] = await Promise.all([first, second]);
    expect(one.map(beat => beat.id)).toEqual(["beat-1"]);
    expect(two.map(beat => beat.id)).toEqual(["beat-1"]);
    expect(load).toHaveBeenCalledTimes(1);

    await libraryStateManager.reloadAuthoritative();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

'''
if core_test.count(needle) != 1:
    raise RuntimeError("coreIntegration test insertion marker mismatch")
write("tests/integration/coreIntegration.test.tsx", core_test.replace(needle, insert + needle, 1))

cache_test = r'''// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MAX_ARTWORK_THUMBNAIL_BYTES, artworkThumbnailCacheKey } from "../../src/features/artwork/artworkThumbnailCache";

describe("artwork thumbnail cache contract", () => {
  it("caps each cached cover at 250 KiB", () => {
    expect(MAX_ARTWORK_THUMBNAIL_BYTES).toBe(250 * 1024);
  });

  it("keys a thumbnail by beat plus durable artwork object so edits invalidate stale covers", () => {
    expect(artworkThumbnailCacheKey({
      id: "beat-1",
      assets: { artwork: { object_id: "direct:42" } },
    } as any)).toBe("beat-1:direct:42");
  });

  it("does not invent a cache identity when the beat has no durable artwork reference", () => {
    expect(artworkThumbnailCacheKey({ id: "beat-1", assets: undefined } as any)).toBeNull();
  });
});
'''
(ROOT / "tests/component-dom/artworkThumbnailCache.test.ts").write_text(cache_test, encoding="utf-8")

architecture_test = r'''// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/App.tsx", "utf8");
const beatCard = readFileSync("src/components/BeatCard.tsx", "utf8");
const nginx = readFileSync("deploy/web/beatgaler.com.conf", "utf8");

describe("Issue #97 startup reveal architecture", () => {
  it("boots the presentation layer from the last verified lightweight manifest", () => {
    expect(app).toContain("useState<Beat[]>(() => startupCachedBeatsRef.current ?? [])");
    expect(app).toContain("if (!cloudSessionVerified || (settings && !settings.telegram_cloud_connected)) return;");
  });

  it("reserves every filtered beat slot while revealing only artwork-ready cards", () => {
    expect(app).toContain("<SortableContext items={filteredBeats.map((b) => b.id)}");
    expect(app).toContain("visible={revealedBeatIds.has(beat.id)}");
    expect(beatCard).toContain('visibility: visible ? "visible" : "hidden"');
    expect(beatCard).toContain("if (!visible || !hasEnteredViewport || !beat.telegram_file_id) return;");
  });

  it("does not gate card reveal on audio cooking", () => {
    expect(app).toContain("title + artwork are enough to show a beat");
    expect(app).not.toContain("After the first six are usable, prepare the rest one at a time");
  });

  it("renders Empty Gallery only after online authority is verified", () => {
    expect(app).toContain('cloudSessionVerified && connectionState === "online" ? (');
  });

  it("serves WebAssembly with the streaming MIME type", () => {
    expect(nginx).toContain("default_type application/wasm;");
  });
});
'''
(ROOT / "tests/component-dom/startupRevealArchitecture.test.ts").write_text(architecture_test, encoding="utf-8")

print("Issue #97 patch applied")
