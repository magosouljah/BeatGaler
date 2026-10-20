export interface Mp3PlayablePrefixMeasurement {
  playableSeconds: number;
  completeFrames: number;
  audioBytes: number;
  firstFrameOffset: number | null;
  id3Bytes: number;
  waitingForId3: boolean;
}

type MpegVersion = 1 | 2 | 2.5;
type MpegLayer = 1 | 2 | 3;

type ParsedFrame = {
  byteLength: number;
  durationSeconds: number;
  version: MpegVersion;
  layer: MpegLayer;
  sampleRate: number;
};

const BITRATES_MPEG1: Record<MpegLayer, readonly number[]> = {
  1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};

const BITRATES_MPEG2: Record<MpegLayer, readonly number[]> = {
  1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<string, readonly number[]> = {
  "1": [44100, 48000, 32000],
  "2": [22050, 24000, 16000],
  "2.5": [11025, 12000, 8000],
};

function asBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function isId3(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
}

function parseId3Prefix(bytes: Uint8Array): { id3Bytes: number; waiting: boolean; malformed: boolean } {
  if (!isId3(bytes)) return { id3Bytes: 0, waiting: false, malformed: false };
  if (bytes.length < 10) return { id3Bytes: 0, waiting: true, malformed: false };

  const major = bytes[3];
  if (major < 2 || major > 4) return { id3Bytes: 0, waiting: false, malformed: true };
  if (bytes[6] >= 0x80 || bytes[7] >= 0x80 || bytes[8] >= 0x80 || bytes[9] >= 0x80) {
    return { id3Bytes: 0, waiting: false, malformed: true };
  }

  const bodySize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const footerSize = major === 4 && (bytes[5] & 0x10) !== 0 ? 10 : 0;
  const id3Bytes = 10 + bodySize + footerSize;
  return { id3Bytes, waiting: bytes.length < id3Bytes, malformed: false };
}

function versionFromBits(bits: number): MpegVersion | null {
  if (bits === 3) return 1;
  if (bits === 2) return 2;
  if (bits === 0) return 2.5;
  return null;
}

function layerFromBits(bits: number): MpegLayer | null {
  if (bits === 3) return 1;
  if (bits === 2) return 2;
  if (bits === 1) return 3;
  return null;
}

function samplesPerFrame(version: MpegVersion, layer: MpegLayer): number {
  if (layer === 1) return 384;
  if (layer === 2) return 1152;
  return version === 1 ? 1152 : 576;
}

function parseFrame(bytes: Uint8Array, offset: number): ParsedFrame | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const version = versionFromBits((b1 >> 3) & 0x03);
  const layer = layerFromBits((b1 >> 1) & 0x03);
  if (!version || !layer) return null;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null;

  const bitrateKbps = (version === 1 ? BITRATES_MPEG1[layer] : BITRATES_MPEG2[layer])[bitrateIndex - 1];
  const sampleRate = SAMPLE_RATES[String(version)][sampleRateIndex];
  if (!bitrateKbps || !sampleRate) return null;

  const padding = (b2 >> 1) & 0x01;
  const bitrate = bitrateKbps * 1000;
  let byteLength: number;
  if (layer === 1) {
    byteLength = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  } else if (layer === 3 && version !== 1) {
    byteLength = Math.floor((72 * bitrate) / sampleRate + padding);
  } else {
    byteLength = Math.floor((144 * bitrate) / sampleRate + padding);
  }
  if (!Number.isInteger(byteLength) || byteLength < 4) return null;

  return {
    byteLength,
    durationSeconds: samplesPerFrame(version, layer) / sampleRate,
    version,
    layer,
    sampleRate,
  };
}

function bigEndianUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function hasMarker(bytes: Uint8Array, offset: number, marker: string): boolean {
  if (offset < 0 || offset + marker.length > bytes.length) return false;
  for (let index = 0; index < marker.length; index += 1) {
    if (bytes[offset + index] !== marker.charCodeAt(index)) return false;
  }
  return true;
}

/** Duration recorded by an MP3 encoder in the first MPEG frame, if present. */
export function mp3DeclaredDuration(input: ArrayBuffer | Uint8Array): number | null {
  const bytes = asBytes(input);
  const firstFrameOffset = measureMp3PlayablePrefix(bytes).firstFrameOffset;
  if (firstFrameOffset === null) return null;
  const frame = parseFrame(bytes, firstFrameOffset);
  if (!frame || frame.layer !== 3) return null;
  const frameEnd = firstFrameOffset + frame.byteLength;
  const readFrames = (offset: number): number | null => {
    if (offset + 4 > frameEnd || offset + 4 > bytes.length) return null;
    const count = bigEndianUint32(bytes, offset);
    const duration = count * samplesPerFrame(frame.version, frame.layer) / frame.sampleRate;
    return count > 0 && Number.isFinite(duration) && duration > 0 ? duration : null;
  };

  const mono = (bytes[firstFrameOffset + 3] >> 6) === 3;
  const sideInfoBytes = frame.version === 1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const crcBytes = (bytes[firstFrameOffset + 1] & 1) === 0 ? 2 : 0;
  const xing = firstFrameOffset + 4 + crcBytes + sideInfoBytes;
  if (hasMarker(bytes, xing, "Xing") || hasMarker(bytes, xing, "Info")) {
    if (xing + 12 <= frameEnd && xing + 12 <= bytes.length
      && (bigEndianUint32(bytes, xing + 4) & 1) !== 0) {
      return readFrames(xing + 8);
    }
  }

  // Fraunhofer VBRI stores the total MPEG frame count after its byte count.
  for (const offset of [firstFrameOffset + 36, firstFrameOffset + 38]) {
    if (hasMarker(bytes, offset, "VBRI")) return readFrames(offset + 14);
  }
  return null;
}

/**
 * Measures only complete MPEG audio frames already present in a downloaded MP3 prefix.
 * Container-level ID3v2 is skipped as one synchsafe block. Xing/VBRI/LAME data stays
 * inside its MPEG frame and is intentionally left untouched.
 */
export function measureMp3PlayablePrefix(input: ArrayBuffer | Uint8Array): Mp3PlayablePrefixMeasurement {
  const bytes = asBytes(input);
  const id3 = parseId3Prefix(bytes);
  if (id3.waiting || id3.malformed) {
    return {
      playableSeconds: 0,
      completeFrames: 0,
      audioBytes: 0,
      firstFrameOffset: null,
      id3Bytes: id3.id3Bytes,
      waitingForId3: id3.waiting,
    };
  }

  let firstFrameOffset: number | null = null;
  let cursor = id3.id3Bytes;
  for (; cursor + 4 <= bytes.length; cursor += 1) {
    const frame = parseFrame(bytes, cursor);
    if (!frame || cursor + frame.byteLength > bytes.length) continue;
    firstFrameOffset = cursor;
    break;
  }

  if (firstFrameOffset === null) {
    return {
      playableSeconds: 0,
      completeFrames: 0,
      audioBytes: 0,
      firstFrameOffset: null,
      id3Bytes: id3.id3Bytes,
      waitingForId3: false,
    };
  }

  cursor = firstFrameOffset;
  let playableSeconds = 0;
  let completeFrames = 0;
  let audioBytes = 0;
  while (cursor + 4 <= bytes.length) {
    const frame = parseFrame(bytes, cursor);
    if (!frame || cursor + frame.byteLength > bytes.length) break;
    playableSeconds += frame.durationSeconds;
    completeFrames += 1;
    audioBytes += frame.byteLength;
    cursor += frame.byteLength;
  }

  return {
    playableSeconds,
    completeFrames,
    audioBytes,
    firstFrameOffset,
    id3Bytes: id3.id3Bytes,
    waitingForId3: false,
  };
}
