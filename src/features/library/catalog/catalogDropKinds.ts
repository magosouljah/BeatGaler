// Clasificación de lo que se arrastra sobre la Gallery POSTGRES. Depende del TIPO de archivo, nunca de la zona de la tarjeta bajo el cursor.
//  - Durante `dragover` el navegador solo expone tipos/kinds (modo protegido): `classifyDragPayload`.
//  - En `drop` se conocen nombre y bytes: `classifyDroppedFile`.
import { looksLikeArtworkDrop } from "../../dragdrop/browserArtwork";
import { isProjectDawFileName } from "../../projects/projectFileTypes";

// El reemplazo y el enrutamiento conservan sus reglas MIME propias (B9).
export type DroppedAudioKind = "MP3" | "WAV" | "PROJECT";
export const classifyDroppedAudio = (file: Pick<File, "name" | "type">): DroppedAudioKind | null =>
  /\.wav$/i.test(file.name) || file.type === "audio/wav" || file.type === "audio/x-wav" ? "WAV"
    : /\.mp3$/i.test(file.name) || file.type === "audio/mpeg" ? "MP3"
      : /\.zip$/i.test(file.name) || isProjectDawFileName(file.name.toLowerCase()) ? "PROJECT" : null;

export type DragPayloadKind = "image" | "audio" | "file" | "none";
export type DroppedFileKind = "image" | "mp3" | "wav" | "project" | "unsupported";

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;
export const SUPPORTED_ARTWORK_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif", "image/avif"]);

export function classifyDroppedFile(file: Pick<File, "name" | "type">): DroppedFileKind {
  const type = (file.type || "").toLowerCase();
  if (IMAGE_EXT.test(file.name) || SUPPORTED_ARTWORK_MIME.has(type)) return "image";
  if (/\.wav$/i.test(file.name) || type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return "wav";
  if (/\.mp3$/i.test(file.name) || type === "audio/mpeg" || type === "audio/mp3") return "mp3";
  if (/\.zip$/i.test(file.name) || isProjectDawFileName(file.name.toLowerCase())) return "project"; // PROJECT ZIP o archivo de DAW (.flp, .als, …)
  return "unsupported";
}

/** Tipo de carga durante el arrastre (solo tipos MIME/kinds). Un archivo sin tipo reconocible es `file`: se resuelve al soltar. */
export function classifyDragPayload(dt: DataTransfer): DragPayloadKind {
  const items = Array.from(dt.items || []).filter((i) => i.kind === "file");
  if (items.length > 0) {
    const types = items.map((i) => (i.type || "").toLowerCase());
    if (types.every((t) => t.startsWith("image/"))) return "image";
    if (types.every((t) => t.startsWith("audio/"))) return "audio";
    return "file";
  }
  if (Array.from(dt.types || []).includes("Files")) return "file";
  return looksLikeArtworkDrop(dt) ? "image" : "none"; // imagen arrastrada desde una página web (URL/HTML)
}
