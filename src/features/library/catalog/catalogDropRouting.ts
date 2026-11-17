// Decide qué hace un drop. La acción depende del TIPO de archivo; la tarjeta solo decide el DESTINO (qué beat).
//   imagen            + tarjeta  → portada de ese beat   | sin tarjeta → aviso (no hay beat al que asignarla)
//   MP3 / WAV         + tarjeta  → reemplazo de audio (con confirmación) | sin tarjeta → beat nuevo (Add beat)
//   otro tipo / varios           → aviso (solo cuando realmente corresponde)
import type { ArtworkDropSource } from "../../dragdrop/browserArtwork";
import { classifyDroppedFile } from "./catalogDropKinds";
import type { CatalogDropEvent } from "./useCatalogFileDrop";

export type DropAction =
  | { type: "import"; file: File }
  | { type: "replace-audio"; beatId: string; file: File }
  | { type: "artwork-file"; beatId: string; file: File }
  | { type: "artwork-sources"; beatId: string; sources: Promise<ArtworkDropSource[]> }
  | { type: "alert"; title: string; message: string };

export function routeDrop(e: CatalogDropEvent): DropAction {
  const { files, artwork, targetBeatId: beatId } = e;
  if (files.length > 1) return { type: "alert", title: "Drop one file at a time", message: beatId ? "Drop one MP3, WAV or image on a beat." : "BeatGaler Web imports one beat per drag action." };
  if (files.length === 1) {
    const file = files[0]; const kind = classifyDroppedFile(file);
    if (kind === "image") return beatId ? { type: "artwork-file", beatId, file } : { type: "alert", title: "Drop the image on a beat", message: "Drop an image onto a beat to change its cover." };
    if (kind === "mp3" || kind === "wav") return beatId ? { type: "replace-audio", beatId, file } : { type: "import", file };
    return { type: "alert", title: "Unsupported file", message: beatId ? "Drop an MP3 or WAV to replace this beat's audio, or an image (PNG, JPG, WEBP, BMP, GIF, AVIF) to change its cover." : "Drop an MP3 or WAV file to add a beat." };
  }
  if (artwork) return beatId ? { type: "artwork-sources", beatId, sources: artwork } : { type: "alert", title: "Drop the image on a beat", message: "Drop an image onto a beat to change its cover." };
  return { type: "alert", title: "Nothing to import", message: "Drop an MP3 or WAV file to add a beat." };
}
