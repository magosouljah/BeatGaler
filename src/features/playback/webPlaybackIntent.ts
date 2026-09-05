export interface WebPlaybackIntent {
  id: number;
  beatId: string;
}

type PreparedIntent = WebPlaybackIntent & { url: string };

let nextIntentId = 0;
let latestIntent: WebPlaybackIntent | null = null;
const preparedByUrl = new Map<string, PreparedIntent>();
const MAX_PREPARED_URLS = 64;

export function beginWebPlaybackIntent(beatId: string): WebPlaybackIntent {
  const intent = { id: ++nextIntentId, beatId: String(beatId || "").trim() };
  latestIntent = intent;
  return intent;
}

export function isCurrentWebPlaybackIntent(intent: WebPlaybackIntent): boolean {
  return latestIntent?.id === intent.id && latestIntent.beatId === intent.beatId;
}

export function rememberPreparedWebPlaybackUrl(url: string, intent: WebPlaybackIntent): void {
  const normalized = String(url || "").trim();
  if (!normalized) return;
  preparedByUrl.delete(normalized);
  preparedByUrl.set(normalized, { ...intent, url: normalized });
  while (preparedByUrl.size > MAX_PREPARED_URLS) {
    const oldest = preparedByUrl.keys().next().value as string | undefined;
    if (!oldest) break;
    preparedByUrl.delete(oldest);
  }
}

export function supersededWebPlaybackUrl(intent: WebPlaybackIntent): string {
  const url = `beatgaler-superseded:${intent.id}`;
  rememberPreparedWebPlaybackUrl(url, intent);
  return url;
}

/**
 * Shared useAudio is also used by Desktop. Untracked URLs are therefore
 * accepted. A tracked Web URL is accepted only for the latest Play intent.
 */
export function shouldAcceptWebPlaybackRequest(beatId: string, urls: readonly string[]): boolean {
  const tracked = urls.map(url => preparedByUrl.get(String(url || "").trim())).find(Boolean);
  if (!tracked) return true;
  return tracked.beatId === beatId && latestIntent?.id === tracked.id && latestIntent.beatId === beatId;
}

export function invalidateWebPlaybackIntentForBeat(beatId: string | null | undefined): void {
  const id = String(beatId || "").trim();
  if (!latestIntent || !id || latestIntent.beatId !== id) return;
  latestIntent = { id: ++nextIntentId, beatId: "" };
}

export function invalidateAllWebPlaybackIntents(): void {
  latestIntent = { id: ++nextIntentId, beatId: "" };
  preparedByUrl.clear();
}
