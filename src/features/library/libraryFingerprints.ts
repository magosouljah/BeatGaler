import type { Beat } from "../../types";

export function cloudBeatFingerprint(beat: Beat): string {
  // IMPORTANT: image_base64/image_preview_base64 are presentation/cache state.
  // Cloud artwork is tracked durably in Rust cloud_metadata. Including decoded
  // image bytes here made startup artwork hydration look like nine independent
  // metadata edits, causing an INDEX rewrite storm and Telegram 429s.
  return [
    beat.id,
    beat.name,
    String(beat.bpm ?? ""),
    beat.key ?? "",
    beat.tags.join("\u001f"),
    String(beat.rating ?? 0),
    beat.color ?? "",
    beat.color2 ?? "",
    beat.telegram_file_id ?? "",
    String(beat.telegram_message_id ?? ""),
  ].join("\u001e");
}

export function drawerMetadataCommitFingerprint(beat: Beat): string {
  const artwork = beat.image_base64 ?? "";
  const artworkMark = artwork
    ? `${artwork.length}:${artwork.slice(0, 32)}:${artwork.slice(-32)}`
    : "";
  return [
    cloudBeatFingerprint(beat),
    artworkMark,
    JSON.stringify(beat.image_crop ?? null),
  ].join("\u001d");
}

export function libraryViewFingerprint(beats: Beat[]): string {
  return beats.map(beat => [
    beat.id,
    beat.name,
    beat.cloud_status ?? "",
    beat.telegram_file_id ?? "",
    String(beat.telegram_message_id ?? ""),
    String(beat.bpm ?? ""),
    beat.key ?? "",
    beat.tags.join("\u001f"),
    String(beat.rating ?? 0),
  ].join("\u001d")).join("\u001c");
}
