import type { Beat } from "../../types";

export const WEB_PLAYBACK_ROUTING_CACHE_KEY = "beatgaler:web-playback-routing:v1";
export const WEB_STARTUP_PLAYBACK_ROUTE_LIMIT = 14;
const PRESENTATION_SORT_CACHE_KEY = "beatvault:sort:v2";

export type WebPlaybackSort = "rating" | "manual" | "bpm" | "name";

export interface CachedPlaybackRoute {
  messageId: number;
  mimeType: string;
  sizeBytes: number | null;
}

export interface CachedStartupPlaybackRoute extends CachedPlaybackRoute {
  beatId: string;
}

export interface CachedPlaybackOrderEntry {
  beatId: string;
  manualIndex: number;
  rating: number;
  bpm: number;
  name: string;
}

export interface WebPlaybackRoutingCacheV1 {
  version: 1;
  routes: Record<string, CachedPlaybackRoute>;
  startup: CachedStartupPlaybackRoute[];
  sortBy: WebPlaybackSort;
  updatedAt: number;
  /** True only after Telegram manifest reconciliation, never from presentation cache. */
  authoritative?: boolean;
  /** Compact all-library ordering projection; no rich Beat/artwork data. */
  order?: CachedPlaybackOrderEntry[];
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value || 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nullableSize(value: unknown): number | null {
  // Number(null) === 0; that must not turn unknown Telegram size into a real 0.
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSort(value: unknown): WebPlaybackSort {
  const sort = String(value || "").trim();
  return sort === "manual" || sort === "bpm" || sort === "name" || sort === "rating"
    ? sort
    : "rating";
}

function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function defaultSort(): WebPlaybackSort {
  const storage = browserStorage();
  return normalizeSort(storage?.getItem(PRESENTATION_SORT_CACHE_KEY) || "rating");
}

function emptyCache(sortBy = defaultSort()): WebPlaybackRoutingCacheV1 {
  return { version: 1, routes: {}, startup: [], sortBy, updatedAt: Date.now(), authoritative: false, order: [] };
}

function normalizedRoute(value: unknown): CachedPlaybackRoute | null {
  const row = record(value);
  if (!row) return null;
  const messageId = positiveInteger(row.messageId);
  if (!messageId) return null;
  return {
    messageId,
    mimeType: text(row.mimeType) || "audio/mpeg",
    sizeBytes: nullableSize(row.sizeBytes),
  };
}

function normalizedOrder(value: unknown): CachedPlaybackOrderEntry[] {
  const output: CachedPlaybackOrderEntry[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    const row = record(raw);
    const beatId = text(row?.beatId);
    if (!beatId || seen.has(beatId)) continue;
    seen.add(beatId);
    output.push({
      beatId,
      manualIndex: Math.max(0, Math.trunc(finiteNumber(row?.manualIndex))),
      rating: finiteNumber(row?.rating),
      bpm: finiteNumber(row?.bpm),
      name: text(row?.name),
    });
  }
  return output;
}

export function readWebPlaybackRoutingCache(): WebPlaybackRoutingCacheV1 {
  const storage = browserStorage();
  if (!storage) return emptyCache();
  try {
    const raw = storage.getItem(WEB_PLAYBACK_ROUTING_CACHE_KEY);
    if (!raw) return emptyCache();
    const parsed = record(JSON.parse(raw));
    if (!parsed || Number(parsed.version) !== 1) return emptyCache();
    const routes: Record<string, CachedPlaybackRoute> = {};
    const rawRoutes = record(parsed.routes) || {};
    for (const [beatId, value] of Object.entries(rawRoutes)) {
      const id = beatId.trim();
      const route = normalizedRoute(value);
      if (id && route) routes[id] = route;
    }
    const startup: CachedStartupPlaybackRoute[] = [];
    const seen = new Set<string>();
    for (const value of Array.isArray(parsed.startup) ? parsed.startup : []) {
      const row = record(value);
      const beatId = text(row?.beatId);
      const route = normalizedRoute(row);
      if (!beatId || !route || seen.has(beatId)) continue;
      seen.add(beatId);
      startup.push({ beatId, ...route });
      if (startup.length >= WEB_STARTUP_PLAYBACK_ROUTE_LIMIT) break;
    }
    return {
      version: 1,
      routes,
      startup,
      sortBy: normalizeSort(parsed.sortBy || defaultSort()),
      updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : 0,
      authoritative: parsed.authoritative === true,
      order: normalizedOrder(parsed.order),
    };
  } catch {
    return emptyCache();
  }
}

export function writeWebPlaybackRoutingCache(cache: WebPlaybackRoutingCacheV1): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(WEB_PLAYBACK_ROUTING_CACHE_KEY, JSON.stringify({
      version: 1,
      routes: cache.routes,
      startup: cache.startup.slice(0, WEB_STARTUP_PLAYBACK_ROUTE_LIMIT),
      sortBy: normalizeSort(cache.sortBy),
      updatedAt: Math.max(0, Number(cache.updatedAt) || Date.now()),
      authoritative: cache.authoritative === true,
      order: cache.order || [],
    } satisfies WebPlaybackRoutingCacheV1));
  } catch {}
}

function directMessageId(value: unknown): number | null {
  const match = /^direct:(\d+)$/.exec(text(value));
  return positiveInteger(match?.[1]);
}

function firstPart(value: unknown): JsonRecord | null {
  const row = record(value);
  const parts = Array.isArray(row?.parts) ? row!.parts : [];
  return record(parts[0]);
}

function routeFromManifestBeat(entry: JsonRecord): CachedPlaybackRoute | null {
  const master = record(entry.master);
  if (!master) return null;
  const part = firstPart(master.manifest) || firstPart(master);
  const messageId = positiveInteger(part?.telegram_message_id ?? master.telegram_message_id)
    || directMessageId(part?.telegram_file_id ?? master.telegram_file_id)
    || directMessageId(master.cloud_file_id);
  if (!messageId) return null;
  return {
    messageId,
    mimeType: text(master.mime ?? master.mime_type) || "audio/mpeg",
    sizeBytes: nullableSize(part?.size ?? master.size),
  };
}

function deletedIds(manifest: JsonRecord): Set<string> {
  const ids = new Set<string>();
  for (const value of Array.isArray(manifest.deleted) ? manifest.deleted : []) {
    const row = record(value);
    const id = text(row?.beat_id ?? row?.id);
    if (id) ids.add(id);
  }
  for (const value of Array.isArray(manifest.trash) ? manifest.trash : []) {
    const row = record(value);
    const beat = record(row?.beat) || row;
    const id = text(beat?.id);
    if (id) ids.add(id);
  }
  return ids;
}

function orderFromManifest(manifest: JsonRecord): CachedPlaybackOrderEntry[] {
  const deleted = deletedIds(manifest);
  const output: CachedPlaybackOrderEntry[] = [];
  for (const raw of Array.isArray(manifest.beats) ? manifest.beats : []) {
    const beat = record(raw);
    const beatId = text(beat?.id);
    if (!beat || !beatId || deleted.has(beatId)) continue;
    output.push({
      beatId,
      manualIndex: output.length,
      rating: finiteNumber(beat.rating),
      bpm: finiteNumber(beat.bpm),
      name: text(beat.name),
    });
  }
  return output;
}

function orderFromBeats(beats: readonly Beat[]): CachedPlaybackOrderEntry[] {
  return beats.map((beat, manualIndex) => ({
    beatId: beat.id,
    manualIndex,
    rating: finiteNumber(beat.rating),
    bpm: finiteNumber(beat.bpm),
    name: String(beat.name || "").trim(),
  }));
}

function sortedOrder(order: readonly CachedPlaybackOrderEntry[], sortBy: WebPlaybackSort): CachedPlaybackOrderEntry[] {
  if (sortBy === "manual") return order.slice().sort((a, b) => a.manualIndex - b.manualIndex);
  return order.slice().sort((a, b) => {
    if (sortBy === "bpm") return a.bpm - b.bpm || a.manualIndex - b.manualIndex;
    if (sortBy === "name") return a.name.localeCompare(b.name) || a.manualIndex - b.manualIndex;
    return b.rating - a.rating || a.manualIndex - b.manualIndex;
  });
}

function startupFromOrder(
  order: readonly CachedPlaybackOrderEntry[],
  routes: Record<string, CachedPlaybackRoute>,
  sortBy: WebPlaybackSort,
): CachedStartupPlaybackRoute[] {
  const startup: CachedStartupPlaybackRoute[] = [];
  for (const item of sortedOrder(order, sortBy)) {
    const route = routes[item.beatId];
    if (!route) continue;
    startup.push({ beatId: item.beatId, ...route });
    if (startup.length >= WEB_STARTUP_PLAYBACK_ROUTE_LIMIT) break;
  }
  return startup;
}

export function updatePlaybackRoutingCacheFromManifest(value: unknown): WebPlaybackRoutingCacheV1 {
  const manifest = record(value);
  if (!manifest) return readWebPlaybackRoutingCache();
  const previous = readWebPlaybackRoutingCache();
  const routes: Record<string, CachedPlaybackRoute> = {};
  const deleted = deletedIds(manifest);
  for (const raw of Array.isArray(manifest.beats) ? manifest.beats : []) {
    const beat = record(raw);
    const beatId = text(beat?.id);
    if (!beat || !beatId || deleted.has(beatId)) continue;
    const route = routeFromManifestBeat(beat);
    if (route) routes[beatId] = route;
  }
  const order = orderFromManifest(manifest);
  const cache: WebPlaybackRoutingCacheV1 = {
    version: 1,
    routes,
    startup: startupFromOrder(order, routes, previous.sortBy),
    sortBy: previous.sortBy,
    updatedAt: Date.now(),
    authoritative: true,
    order,
  };
  writeWebPlaybackRoutingCache(cache);
  return cache;
}

function beatMessageId(beat: Beat): number | null {
  return positiveInteger(beat.telegram_message_id)
    || directMessageId(beat.assets?.master?.object_id)
    || directMessageId(beat.telegram_file_id);
}

function routeFromBeat(beat: Beat): CachedPlaybackRoute | null {
  const messageId = beatMessageId(beat);
  if (!messageId) return null;
  return {
    messageId,
    mimeType: beat.assets?.master?.mime_type || "audio/mpeg",
    sizeBytes: nullableSize(beat.assets?.master?.size_bytes),
  };
}

function upsertOrderEntry(cache: WebPlaybackRoutingCacheV1, beat: Beat): void {
  const order = cache.order || [];
  const existing = order.find(item => item.beatId === beat.id);
  if (existing) {
    existing.rating = finiteNumber(beat.rating);
    existing.bpm = finiteNumber(beat.bpm);
    existing.name = String(beat.name || "").trim();
  } else {
    const manualIndex = order.reduce((max, item) => Math.max(max, item.manualIndex), -1) + 1;
    order.push({
      beatId: beat.id,
      manualIndex,
      rating: finiteNumber(beat.rating),
      bpm: finiteNumber(beat.bpm),
      name: String(beat.name || "").trim(),
    });
  }
  cache.order = order;
}

export function upsertPlaybackRouteFromBeat(beat: Beat): void {
  const route = routeFromBeat(beat);
  if (!route) return;
  const cache = readWebPlaybackRoutingCache();
  cache.routes[beat.id] = route;
  upsertOrderEntry(cache, beat);
  cache.startup = startupFromOrder(cache.order || [], cache.routes, cache.sortBy);
  cache.updatedAt = Date.now();
  writeWebPlaybackRoutingCache(cache);
}

export function deletePlaybackRoutes(beatIds: readonly string[]): void {
  if (beatIds.length === 0) return;
  const ids = new Set(beatIds.map(id => String(id || "").trim()).filter(Boolean));
  const cache = readWebPlaybackRoutingCache();
  for (const id of ids) delete cache.routes[id];
  cache.order = (cache.order || []).filter(item => !ids.has(item.beatId));
  cache.startup = startupFromOrder(cache.order, cache.routes, cache.sortBy);
  cache.updatedAt = Date.now();
  writeWebPlaybackRoutingCache(cache);
}

export function updatePlaybackRoutingStartupFromBeats(
  beats: readonly Beat[],
  sortBy: WebPlaybackSort,
): WebPlaybackRoutingCacheV1 {
  const cache = readWebPlaybackRoutingCache();
  cache.sortBy = normalizeSort(sortBy);

  if (cache.authoritative && (cache.order?.length || 0) > 0) {
    // A partial rich page must never replace the all-library Telegram projection.
    cache.startup = startupFromOrder(cache.order || [], cache.routes, cache.sortBy);
  } else {
    cache.order = orderFromBeats(beats);
    for (const beat of beats) {
      const route = cache.routes[beat.id] || routeFromBeat(beat);
      if (route) cache.routes[beat.id] = route;
    }
    cache.startup = startupFromOrder(cache.order, cache.routes, cache.sortBy);
  }

  cache.updatedAt = Date.now();
  writeWebPlaybackRoutingCache(cache);
  return cache;
}

export function updatePlaybackRoutingSort(sortBy: WebPlaybackSort, beats?: readonly Beat[]): void {
  const normalized = normalizeSort(sortBy);
  const cache = readWebPlaybackRoutingCache();
  cache.sortBy = normalized;
  if (cache.authoritative && (cache.order?.length || 0) > 0) {
    cache.startup = startupFromOrder(cache.order || [], cache.routes, normalized);
    cache.updatedAt = Date.now();
    writeWebPlaybackRoutingCache(cache);
    return;
  }
  if (beats) {
    updatePlaybackRoutingStartupFromBeats(beats, normalized);
    return;
  }
  cache.updatedAt = Date.now();
  writeWebPlaybackRoutingCache(cache);
}

export function isPlaybackRoutingAuthoritative(): boolean {
  return readWebPlaybackRoutingCache().authoritative === true;
}
