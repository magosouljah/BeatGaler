import {
  readWebPlaybackRoutingCache,
  writeWebPlaybackRoutingCache,
  type CachedPlaybackRouteSuspect,
} from "./webPlaybackRoutingCache";

function positiveMessageId(value: unknown): number | null {
  const id = Number(value || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function suspectBeatIdsForMessage(messageId: number): string[] {
  const id = positiveMessageId(messageId);
  if (!id) return [];
  const cache = readWebPlaybackRoutingCache();
  return Object.entries(cache.suspect || {})
    .filter(([, suspect]) => suspect.messageId === id)
    .map(([beatId]) => beatId);
}

export function isPlaybackMessageRouteSuspect(messageId: number): boolean {
  return suspectBeatIdsForMessage(messageId).length > 0;
}

export function markPlaybackMessageRouteSuspect(messageId: number): string[] {
  const id = positiveMessageId(messageId);
  if (!id) return [];
  const cache = readWebPlaybackRoutingCache();
  const matched = Object.entries(cache.routes)
    .filter(([, route]) => route.messageId === id)
    .map(([beatId]) => beatId);
  if (matched.length === 0) return [];

  const nextSuspect: Record<string, CachedPlaybackRouteSuspect> = { ...(cache.suspect || {}) };
  const markedAt = Date.now();
  for (const beatId of matched) nextSuspect[beatId] = { messageId: id, markedAt };
  cache.suspect = nextSuspect;
  cache.startup = cache.startup.filter(item => !matched.includes(item.beatId));
  cache.updatedAt = markedAt;
  writeWebPlaybackRoutingCache(cache);
  return matched;
}
