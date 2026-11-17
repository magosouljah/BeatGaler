// Cambio de portada por arrastre de una imagen sobre una BeatCard de la Gallery POSTGRES. Mismo servicio que el Drawer:
// `mutations.replaceBeat` con SOLO el archivo de portada (operación REPLACE C7 + gateway); `updated === original` ⇒ ningún metadato cambia.
// Nunca crea un beat nuevo ni toca audio. Sin confirmación (igual que el BeatGaler anterior): es una acción directa y reversible.
import type { ArtworkDropSource } from "../../dragdrop/browserArtwork";
import { fetchInternetArtworkDataUrl } from "../../artwork/internetArtwork";
import { SUPPORTED_ARTWORK_MIME } from "./catalogDropKinds";
import type { CatalogMutations } from "./catalogMutations";
import { beatFromCatalogDetail } from "./catalogMutations";

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", bmp: "image/bmp", gif: "image/gif", avif: "image/avif" };
const EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/bmp": "bmp", "image/gif": "gif", "image/avif": "avif" };

/** Archivo de imagen con tipo MIME explícito y compatible; null si no lo es. */
export function normalizeArtworkFile(file: File): File | null {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const type = (file.type || MIME_BY_EXT[ext] || "").toLowerCase();
  if (!SUPPORTED_ARTWORK_MIME.has(type)) return null;
  return file.type === type ? file : new File([file], file.name || `artwork.${EXT_BY_MIME[type]}`, { type });
}

function dataUrlToArtworkFile(dataUrl: string): File | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const type = (m[1] || "").toLowerCase(); if (!SUPPORTED_ARTWORK_MIME.has(type)) return null;
  try {
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return bytes.length > 0 ? new File([bytes], `artwork.${EXT_BY_MIME[type]}`, { type }) : null;
  } catch { return null; }
}

/** Primera fuente utilizable (archivo local o URL de una página); un fallo de una no impide probar la siguiente. */
export async function resolveArtworkFile(sources: ArtworkDropSource[]): Promise<File> {
  const errors: string[] = [];
  for (const source of sources) {
    try {
      const file = source.kind === "file" ? normalizeArtworkFile(source.file) : dataUrlToArtworkFile(/^data:image\//i.test(source.url) ? source.url : await fetchInternetArtworkDataUrl(source.url));
      if (file && file.size > 0) return file;
      errors.push(`${source.kind}: formato de imagen no compatible`);
    } catch (e) { errors.push(`${source.kind}: ${String((e as { message?: unknown })?.message ?? e)}`); }
  }
  throw new Error(errors.length ? errors.join(" | ") : "No se encontró una imagen utilizable en lo soltado.");
}

export type ReplaceArtworkResult = { status: "committed"; beatId: string } | { status: "failed"; message: string };

export async function replaceBeatArtwork({ mutations, beatId, file }: { mutations: Pick<CatalogMutations, "getBeat" | "replaceBeat">; beatId: string; file: File }): Promise<ReplaceArtworkResult> {
  let detail;
  try { detail = await mutations.getBeat(beatId); } catch (e) { return { status: "failed", message: `No se pudo leer el beat: ${String((e as { message?: unknown })?.message ?? e)}` }; }
  const original = beatFromCatalogDetail(detail, null);
  try {
    const outcome = await mutations.replaceBeat({ beatId, expectedVersion: detail.version, original, updated: original, files: { artwork: file } });
    if (outcome.status === "committed") return { status: "committed", beatId };
    if (outcome.status === "conflict") return { status: "failed", message: "Este beat cambió en otro dispositivo; la portada no se cambió. Vuelve a intentarlo." };
    return { status: "failed", message: `La operación quedó en estado ${outcome.status}; el beat conserva su portada actual.` };
  } catch (e) { return { status: "failed", message: String((e as { message?: unknown })?.message ?? e) }; }
}
