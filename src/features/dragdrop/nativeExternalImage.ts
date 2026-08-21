// Bridge for BeatGaler's tiny WRY Option-2 patch.
// WRY's public DragDropEvent currently carries filesystem paths only, so the
// patched Windows receiver transports a browser-image signal in a reserved
// sentinel PathBuf. This module MUST decode/filter that sentinel before any
// value can enter BeatGaler's local filesystem import router.

export const NATIVE_EXTERNAL_IMAGE_PREFIX = "__BEATGALER_EXTERNAL_IMAGE_V1__";
export const NATIVE_EXTERNAL_IMAGE_PENDING = `${NATIVE_EXTERNAL_IMAGE_PREFIX}PENDING`;

export type NativeExternalImageSignal =
  | { kind: "pending" }
  | { kind: "drop"; url: string; source: "pinterest" | "browser" };

function sourceForExternalImageUrl(url: string): "pinterest" | "browser" {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "i.pinimg.com" || host.endsWith(".pinimg.com") || host.includes("pinterest.")) {
      return "pinterest";
    }
  } catch {}
  return "browser";
}

export function nativeExternalImageSignalFromPaths(paths: readonly string[]): NativeExternalImageSignal | null {
  if (paths.length !== 1) return null;
  const value = paths[0];
  if (value === NATIVE_EXTERNAL_IMAGE_PENDING) return { kind: "pending" };
  if (!value.startsWith(NATIVE_EXTERNAL_IMAGE_PREFIX)) return null;

  const encoded = value.slice(NATIVE_EXTERNAL_IMAGE_PREFIX.length);
  if (!encoded || encoded === "PENDING") return null;
  try {
    // Windows transports an encoded URL; macOS NSPasteboard transports the
    // original URL string. Preserve already-absolute URLs so signed/query
    // percent escapes are not decoded a second time.
    const url = /^https?:\/\//i.test(encoded) ? encoded : decodeURIComponent(encoded);
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { kind: "drop", url, source: sourceForExternalImageUrl(url) };
  } catch {
    return null;
  }
}
