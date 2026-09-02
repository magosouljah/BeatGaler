import type { Beat } from "../../types";

export const MAX_ARTWORK_THUMBNAIL_BYTES = 250 * 1024;
const ARTWORK_CACHE_NAME = "beatgaler-artwork-thumbnails-v1";
const activeObjectUrls = new Map<string, string>();

type ArtworkIdentity = Pick<Beat, "id" | "assets">;

export function artworkThumbnailCacheKey(beat: ArtworkIdentity): string {
  const objectId = beat.assets?.artwork?.object_id?.trim();
  return objectId ? `${beat.id}:${objectId}` : `${beat.id}:local`;
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
  if (!cacheSupported()) return null;

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
  if (!cacheSupported()) return source;

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
