import { createHash } from "node:crypto";

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Expected binary data.");
}

function synchsafe(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  const values = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (values.some(value => value > 0x7f)) return null;
  return (values[0] << 21) | (values[1] << 14) | (values[2] << 7) | values[3];
}

/** Returns the full ID3v2 container size, including the 10-byte header/footer. */
export function id3v2Length(value) {
  const bytes = asBytes(value);
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const major = bytes[3];
  if (major < 2 || major > 4) return 0;
  const bodySize = synchsafe(bytes, 6);
  if (bodySize === null) return 0;
  const footer = major === 4 && (bytes[5] & 0x10) !== 0 ? 10 : 0;
  const total = 10 + bodySize + footer;
  return total <= bytes.length ? total : 0;
}

/** Removes only leading ID3v2 and trailing ID3v1 containers; MPEG bytes remain untouched. */
export function stripMp3ContainerTags(value) {
  const bytes = asBytes(value);
  const prefixBytesRemoved = id3v2Length(bytes);
  const hasId3v1 = bytes.length - prefixBytesRemoved >= 128 &&
    bytes[bytes.length - 128] === 0x54 && bytes[bytes.length - 127] === 0x41 && bytes[bytes.length - 126] === 0x47;
  const suffixBytesRemoved = hasId3v1 ? 128 : 0;
  const end = bytes.length - suffixBytesRemoved;
  if (prefixBytesRemoved >= end) {
    return { bytes: bytes.slice(), prefixBytesRemoved: 0, suffixBytesRemoved: 0 };
  }
  return {
    bytes: bytes.slice(prefixBytesRemoved, end),
    prefixBytesRemoved,
    suffixBytesRemoved,
  };
}

export function sha256Hex(value) {
  return createHash("sha256").update(asBytes(value)).digest("hex");
}

function decodeText(bytes) {
  if (bytes.length === 0) return "";
  const encoding = bytes[0];
  const data = bytes.slice(1);
  if (encoding === 0) return new TextDecoder("latin1").decode(data).replace(/\0+$/, "");
  if (encoding === 3) return new TextDecoder("utf-8").decode(data).replace(/\0+$/, "");
  if (encoding === 1 && data.length >= 2) {
    const littleEndian = data[0] === 0xff && data[1] === 0xfe;
    const start = (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff) ? 2 : 0;
    let text = "";
    for (let index = start; index + 1 < data.length; index += 2) {
      const unit = littleEndian ? data[index] | (data[index + 1] << 8) : (data[index] << 8) | data[index + 1];
      if (unit === 0) break;
      text += String.fromCharCode(unit);
    }
    return text;
  }
  return "";
}

/** Minimal ID3v2.3 parser for the fields written by WebDownloadsManager. */
export function parseId3v23Frames(value) {
  const bytes = asBytes(value);
  const tagLength = id3v2Length(bytes);
  if (!tagLength || bytes[3] !== 3) throw new Error("Expected a complete ID3v2.3 tag.");
  const text = {};
  let popm = null;
  let offset = 10;
  while (offset + 10 <= tagLength) {
    const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const length = (bytes[offset + 4] * 0x1000000) + (bytes[offset + 5] << 16) + (bytes[offset + 6] << 8) + bytes[offset + 7];
    const frameEnd = offset + 10 + length;
    if (length < 0 || frameEnd > tagLength) throw new Error(`Malformed ID3v2.3 ${id} frame.`);
    const payload = bytes.slice(offset + 10, frameEnd);
    if (id.startsWith("T")) text[id] = decodeText(payload);
    if (id === "POPM") {
      const zero = payload.indexOf(0);
      if (zero >= 0 && zero + 1 < payload.length) popm = { email: new TextDecoder("latin1").decode(payload.slice(0, zero)), rating: payload[zero + 1] };
    }
    offset = frameEnd;
  }
  return { tagLength, text, popm };
}
