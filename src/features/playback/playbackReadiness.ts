export type PlaybackReadinessBeat = {
  cloud_status?: string | null;
};

/**
 * Cloud states that mean the card exists, but MASTER playback is not safe yet.
 *
 * UPLOADING: Telegram slots/index are still being committed.
 * PLAYBACK_PREPARING: upload is durable, but Download Cooking has not produced
 * enough contiguous MASTER bytes for a reliable first Play yet.
 */
export const PLAYBACK_BLOCKING_CLOUD_STATUSES = new Set([
  "UPLOADING",
  "PLAYBACK_PREPARING",
]);

export function isBeatPlaybackBlocked(beat: PlaybackReadinessBeat): boolean {
  return PLAYBACK_BLOCKING_CLOUD_STATUSES.has(String(beat.cloud_status || "").toUpperCase());
}
