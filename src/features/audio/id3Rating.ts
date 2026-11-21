// Rating (0–5 estrellas) de un MP3 a partir de su etiqueta ID3v2: frame POPM («Popularimeter», ID3v2.3/2.4) o POP (ID3v2.2).
//
// El valor del POPM es un byte 0–255 sin escala universal (Windows 1/64/128/196/255, Winamp/otros 31/95/159/223/255, BeatGaler 1/64/128/192/255 o
// 51/102/153/204/255 según la versión). Se usa la MISMA escala por tramos que ya aplica el escritorio (`src-tauri/src/commands.rs`, lectura de POPM):
// 0 → 0, 1–51 → 1, 52–114 → 2, 115–167 → 3, 168–204 → 4, ≥ 205 → 5. Se acepta cualquier identidad (email) del POPM; con varios, vale el primero con valor.
// No se interpretan otras convenciones (TXXX «RATING», comentarios, ID3v1, APE, Vorbis): quedan en 0. Puro: sin red ni librerías externas.
import { readBlobAsArrayBuffer } from "./mp3Metadata";

const MAX_TAG_BYTES = 32 * 1024 * 1024; // más allá, la etiqueta no es una etiqueta (se ignora; la importación no espera ni falla)

export function starsFromPopmByte(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw <= 51 ? 1 : raw <= 114 ? 2 : raw <= 167 ? 3 : raw <= 204 ? 4 : 5;
}

const synchsafe = (b: Uint8Array, o: number): number => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ascii = (b: Uint8Array, o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));

/** Tamaño total (cabecera + cuerpo) de la etiqueta ID3v2 que empieza en `head`, o 0 si no hay etiqueta ID3v2 válida. */
export function id3v2TagSize(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== "ID3" || head[3] < 2 || head[3] > 4) return 0;
  if ([6, 7, 8, 9].some((i) => head[i] & 0x80)) return 0;
  return 10 + synchsafe(head, 6);
}

/** Estrellas (0–5) del primer POPM/POP con valor en una etiqueta ID3v2 completa (`tag` empieza en «ID3»). */
export function readId3Rating(tag: Uint8Array): number {
  const total = id3v2TagSize(tag); if (!total) return 0;
  const major = tag[3]; const end = Math.min(total, tag.length);
  let pos = 10;
  if (major >= 3 && (tag[5] & 0x40)) pos += major === 4 ? synchsafe(tag, pos) : 4 + u32(tag, pos); // cabecera extendida
  const idLen = major === 2 ? 3 : 4; const headLen = major === 2 ? 6 : 10;
  while (pos + headLen <= end) {
    if (tag[pos] === 0) break; // relleno
    const id = ascii(tag, pos, idLen);
    const size = major === 2 ? (tag[pos + 3] << 16) | (tag[pos + 4] << 8) | tag[pos + 5] : major === 4 ? synchsafe(tag, pos + 4) : u32(tag, pos + 4);
    const bodyStart = pos + headLen; const bodyEnd = bodyStart + size;
    if (size < 0 || bodyEnd > end) break;
    if (id === "POPM" || id === "POP") {
      const nul = tag.indexOf(0, bodyStart); // identidad (email) terminada en 0, luego el byte de valoración
      if (nul >= 0 && nul < bodyEnd - 1) { const stars = starsFromPopmByte(tag[nul + 1]); if (stars > 0) return stars; }
    }
    pos = bodyEnd;
  }
  return 0;
}

/** Estrellas (0–5) de un archivo MP3 (0 si no es un MP3 con ID3v2, no tiene POPM o la etiqueta es ilegible). Nunca lanza. */
export async function readMp3Rating(file: Blob): Promise<number> {
  try {
    const head = new Uint8Array(await readBlobAsArrayBuffer(file.slice(0, 10)));
    const total = id3v2TagSize(head);
    if (!total || total > MAX_TAG_BYTES) return 0;
    return readId3Rating(new Uint8Array(await readBlobAsArrayBuffer(file.slice(0, total))));
  } catch { return 0; }
}
