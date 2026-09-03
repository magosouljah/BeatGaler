export interface BeatGalerMp3Metadata {
  name: string;
  bpm?: string | null;
  key?: string | null;
  tags?: string[] | null;
  rating?: number | null;
}

export interface Mp3Artwork {
  mimeType: string;
  bytes: ArrayBuffer | Uint8Array;
}

export interface StrippedMp3File {
  file: File;
  prefixBytesRemoved: number;
  suffixBytesRemoved: number;
}

function isSynchsafeByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < 0x80;
}

function id3v2PrefixLength(header: Uint8Array, fileSize: number): number {
  if (header.length < 10 || header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return 0;
  const major = header[3];
  if (major < 2 || major > 4) return 0;
  const sizeBytes = [header[6], header[7], header[8], header[9]];
  if (!sizeBytes.every(isSynchsafeByte)) return 0;
  const bodySize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
  const footerSize = major === 4 && (header[5] & 0x10) !== 0 ? 10 : 0;
  const total = 10 + bodySize + footerSize;
  return total > 0 && total < fileSize ? total : 0;
}

function hasId3v1Tag(tail: Uint8Array): boolean {
  return tail.length === 128 && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47;
}

export function looksLikeMp3(file: Pick<File, "name" | "type">): boolean {
  return /\.mp3$/i.test(file.name) || /^audio\/(?:mpeg|mp3)$/i.test(file.type || "");
}

/**
 * Removes only container-level ID3 metadata from an MP3 cloud payload.
 * MPEG audio bytes (including Xing/VBRI/LAME technical frames) are preserved byte-for-byte.
 */
export async function stripId3MetadataForCloud(file: File): Promise<StrippedMp3File> {
  if (!looksLikeMp3(file) || file.size <= 0) {
    return { file, prefixBytesRemoved: 0, suffixBytesRemoved: 0 };
  }

  const header = new Uint8Array(await file.slice(0, Math.min(10, file.size)).arrayBuffer());
  const prefixBytesRemoved = id3v2PrefixLength(header, file.size);
  let suffixBytesRemoved = 0;
  if (file.size - prefixBytesRemoved > 128) {
    const tail = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
    if (hasId3v1Tag(tail)) suffixBytesRemoved = 128;
  }

  const end = file.size - suffixBytesRemoved;
  if (prefixBytesRemoved === 0 && suffixBytesRemoved === 0) {
    return { file, prefixBytesRemoved: 0, suffixBytesRemoved: 0 };
  }
  if (prefixBytesRemoved >= end) {
    // Malformed metadata must never turn a valid user file into an empty upload.
    return { file, prefixBytesRemoved: 0, suffixBytesRemoved: 0 };
  }

  const clean = file.slice(prefixBytesRemoved, end, file.type || "audio/mpeg");
  return {
    file: new File([clean], file.name, { type: file.type || "audio/mpeg", lastModified: file.lastModified }),
    prefixBytesRemoved,
    suffixBytesRemoved,
  };
}

function uint32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

function synchsafe(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 21) & 0x7f;
  out[1] = (value >>> 14) & 0x7f;
  out[2] = (value >>> 7) & 0x7f;
  out[3] = value & 0x7f;
  return out;
}

function concat(parts: Array<Uint8Array>): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function latin1(value: string): Uint8Array {
  return Uint8Array.from(Array.from(value, character => character.charCodeAt(0) & 0xff));
}

function utf16le(value: string): Uint8Array {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = (code >>> 8) & 0xff;
  }
  return bytes;
}

function frame(id: string, payload: Uint8Array): Uint8Array {
  if (id.length !== 4) throw new Error(`Invalid ID3 frame id: ${id}`);
  return concat([latin1(id), uint32be(payload.byteLength), new Uint8Array([0, 0]), payload]);
}

function textFrame(id: string, value: string): Uint8Array | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // ID3v2.3 encoding=1 is UTF-16 with BOM and works with Windows/macOS players.
  return frame(id, concat([new Uint8Array([1]), utf16le(trimmed)]));
}

function ratingFrame(rating: number): Uint8Array | null {
  if (!Number.isFinite(rating) || rating <= 0) return null;
  const stars = Math.max(1, Math.min(5, Math.round(rating)));
  const byte = Math.round((stars / 5) * 255);
  return frame("POPM", concat([
    latin1("beatgaler@local"),
    new Uint8Array([0, byte, 0, 0, 0, 0]),
  ]));
}

function artworkFrame(artwork: Mp3Artwork): Uint8Array | null {
  const mime = String(artwork.mimeType || "image/jpeg").trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) return null;
  const bytes = artwork.bytes instanceof Uint8Array ? artwork.bytes : new Uint8Array(artwork.bytes);
  if (bytes.byteLength === 0) return null;
  return frame("APIC", concat([
    new Uint8Array([0]),
    latin1(mime),
    new Uint8Array([0, 3, 0]), // MIME terminator, CoverFront, empty description.
    bytes,
  ]));
}

/** Builds a fresh ID3v2.3 tag from BeatGaler INDEX fields for exported/downloaded MP3s. */
export function buildBeatGalerId3Tag(metadata: BeatGalerMp3Metadata, artwork?: Mp3Artwork | null): Uint8Array {
  const frames: Uint8Array[] = [];
  const add = (value: Uint8Array | null) => { if (value) frames.push(value); };
  add(textFrame("TIT2", metadata.name || ""));
  add(textFrame("TBPM", metadata.bpm || ""));
  add(textFrame("TKEY", metadata.key || ""));
  add(textFrame("TCON", (metadata.tags || []).map(tag => String(tag).trim()).filter(Boolean).join("; ")));
  add(ratingFrame(Number(metadata.rating || 0)));
  if (artwork) add(artworkFrame(artwork));

  const body = concat(frames);
  return concat([
    new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0]),
    synchsafe(body.byteLength),
    body,
  ]);
}
