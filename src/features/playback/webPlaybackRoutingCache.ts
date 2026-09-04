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

export interface WebPlaybackRoutingCacheV1 {
  version: 1;
  routes: Record<string, CachedPlaybackRoute>;
  startup: CachedStartupPlaybackRoute[];
  sortBy: WebPlaybackSort;
  updatedAt: number;
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
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
  return { version: 1, routes: {}, startup: [], sortBy, updatedAt: Date.now() };
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
  return ids;
}

function orderedManifestBeats(manifest: JsonRecord, sortBy: WebPlaybackSort): JsonRecord[] {
  const deleted = deletedIds(manifest);
  const beats = (Array.isArray(manifest.beats) ? manifest.beats : [])
    .map(record)
    .filter((beat): beat is JsonRecord => Boolean(beat && text(beat.id) && !deleted.has(text(beat.id))));
  if (sortBy === "manual") return beats;
  const manualIndex = new Map(beats.map((beat, index) => [text(beat.id), index]));
  return beats.slice().sort((a, b) => {
    if (sortBy === "bpm") return Number(a.bpm || 0) - Number(b.bpm || 0);
    if (sortBy === "name") return text(a.name).localeCompare(text(b.name));
    const ratingDiff = Number(b.rating || 0) - Number(a.rating || 0);
    return ratingDiff || (manualIndex.get(text(a.id)) ?? 0) - (manualIndex.get(text(b.id)) ?? 0);
  });
}

function startupFromManifest(
  manifest: JsonRecord,
  routes: Record<string, CachedPlaybackRoute>,
  sortBy: WebPlaybackSort,
): CachedStartupPlaybackRoute[] {
  const startup: CachedStartupPlaybackRoute[] = [];
  for (const beat of orderedManifestBeats(manifest, sortBy)) {
    const beatId = text(beat.id);
    const route = routes[beatId];
    if (!route) continue;
    startup.push({ beatId, ...route });
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
  const cache: WebPlaybackRoutingCacheV1 = {
    version: 1,
    routes,
    startup: startupFromManifest(manifest, routes, previous.sortBy),
    sortBy: previous.sortBy,
    updatedAt: Date.now(),
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

export function upsertPlaybackRouteFromBeat(beat: Beat): void {
  const route = routeFromBeat(beat);
  if (!route) return;
  const cache = readWebPlaybackRoutingCache();
  cache.routes[beat.id] = route;
  const startup = cache.startup.find(item => item.beatId === beat.id);
  if (startup) Object.assign(startup, route);
  cache.updatedAt = Date.now();
  writeWebPlaybackRoutingCache(cache);
}

export function deletePlaybackRoutes(beatIds: readonly string[]): void {
  if (beatIds.length === 0) return;
  const ids = new Set(beatIds.map(id => String(id || "").trim()).filter(Boolean));
  const cache = readWebPlaybackRoutingCache();
  for (const id of ids) delete cache.routes[id];
  cache.startup = cache.startup.filter(item => !ids.has(item.beatId));
  cache.updatedAt = Date.now();
  writeWebPlaybackRoutingCache(cache);
}

export function updatePlaybackRoutingStartupFromBeats(
  beats: readonly Beat[],
  sortBy: WebPlaybackSort,
): WebPlaybackRoutingCacheV1 {
  const cache = readWebPlaybackRoutingCache();
  cache.sortBy = normalizeSort(sortBy);
  const manualIndex = new Map(beats.map((beat, index) => [beat.id, index]));
  const ordered = beats.slice().sort((a, b) => {
    if (cache.sortBy === "manual") return (manualIndex.get(a.id) ?? 0) - (manualIndex.get(b.id) ?? 0);
    if (cache.sortBy === "bpm") return Number(a.bpm || 0) - Number(b.bpm || 0);
    if (cache.sortBy === "name") return a.name.localeCompare(b.name);
    const ratingDiff = Number(b.rating || 0) - Number(a.rating || 0);
    return ratingDiff || (manualIndex.get(a.id) ?? 0) - (manualIndex.get(b.id) ?? 0);
  });
  cache.startup = [];
  for (const beat of ordered) {
    const route = cache.routes[beat.id] || routeFromBeat(beat);
    if (!route) continue;
    cache.routes[beat.id] = route;
    cache.startup.push({ beatId: beat.id, ...route });
    if (cache.startup.length >= WEB_STARTUP_PLAYBACK_ROUTE_LIMIT) break;
  }
  cache.updatedAt = Date.now();
  writeWebPlaybackRoutingCache(cache);
  return cache;
}

export function updatePlaybackRoutingSort(sortBy: WebPlaybackSort, beats?: readonly Beat[]): void {
  if (beats) {
    updatePlaybackRoutingStartupFromBeats(beats, sortBy);
    return;
  }
  const cache = readWebPlaybackRoutingCache();
  cache.sortBy = normalizeSort(sortBy);
  cache.updatedAt = Date.now();
  writeWebPlaybackRoutingCache(cache);
}
