// Normalizadores de archivos del catálogo Web (C13): data URL → File y detección de MASTER MP3.
// Las variantes NO son equivalentes y se conservan con nombre explícito:
//  - `dataUrlToFile`: sin validar MIME (por defecto image/png), nombre `<beat>.<ext>` (ruta manual del Drawer y replaceBeat).
//  - `artworkFromDataUrl`: valida MIME soportado, sin MIME por defecto, nombre fijo `artwork.<ext>`, rechaza vacío (soltar portada).
import { SUPPORTED_ARTWORK_MIME } from "./catalogDropKinds";

export const EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/bmp": "bmp", "image/gif": "gif", "image/avif": "avif" };
const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

function decodeDataUrlBytes(data: string, base64: boolean) {
  return base64 ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data));
}

/** Data URL → File sin validar el MIME (png por defecto) y con el nombre del beat; null si no es data URL o no decodifica. */
export function dataUrlToFile(dataUrl: string, name: string): File | null {
  const m = DATA_URL.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "image/png";
  const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  try {
    const bytes = decodeDataUrlBytes(m[3], Boolean(m[2]));
    return new File([bytes], `${name.replace(/[\/:*?"<>|]+/g, "_") || "artwork"}.${ext}`, { type: mime });
  } catch { return null; }
}

/** Data URL → File de portada: solo MIME de imagen soportado, nombre `artwork.<ext>`; null si no lo es o está vacío. */
export function artworkFromDataUrl(dataUrl: string): File | null {
  const m = DATA_URL.exec(dataUrl);
  if (!m) return null;
  const type = (m[1] || "").toLowerCase(); if (!SUPPORTED_ARTWORK_MIME.has(type)) return null;
  try {
    const bytes = decodeDataUrlBytes(m[3], Boolean(m[2]));
    return bytes.length > 0 ? new File([bytes], `artwork.${EXT_BY_MIME[type]}`, { type }) : null;
  } catch { return null; }
}

/** MASTER MP3 por MIME (`audio/mpeg` | `audio/mp3`) o por extensión `.mp3`. */
export const isMp3Master = (spec: { mime?: string | null; filename?: string | null }): boolean =>
  /^audio\/(mpeg|mp3)$/i.test(spec.mime ?? "") || /\.mp3$/i.test(spec.filename ?? "");
