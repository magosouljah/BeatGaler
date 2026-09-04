export interface Mp3PlayablePrefixInfo {
  playableSeconds: number;
  completeFrames: number;
  firstFrameOffset: number | null;
}

const MPEG1_BITRATES_KBPS: Record<number, readonly number[]> = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
};

const MPEG2_BITRATES_KBPS: Record<number, readonly number[]> = {
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
};

type FrameInfo = {
  frameBytes: number;
  samples: number;
  sampleRate: number;
};

function id3v2PrefixLength(bytes: Uint8Array): number {
  const looksLikeId3 = bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  if (!looksLikeId3) return 0;
  // A partial ID3 header must never be scanned as MPEG data. Wait until the
  // complete 10-byte header is present before trusting its declared size.
  if (bytes.byteLength < 10) return bytes.byteLength;
  const version = bytes[3];
  if (version < 2 || version > 4) return 0;
  const sizeBytes = bytes.subarray(6, 10);
  if (Array.from(sizeBytes).some(value => (value & 0x80) !== 0)) return 0;
  const bodyBytes = ((sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3]) >>> 0;
  const footerBytes = version === 4 && (bytes[5] & 0x10) !== 0 ? 10 : 0;
  // When the declared tag is larger than the bytes available so far, consume
  // the entire current prefix. This prevents false MPEG sync inside ID3 data.
  return Math.min(bytes.byteLength, 10 + bodyBytes + footerBytes);
}

function parseFrame(bytes: Uint8Array, offset: number): FrameInfo | null {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const mpeg1 = versionBits === 3;
  const bitrateTable = mpeg1 ? MPEG1_BITRATES_KBPS[layerBits] : MPEG2_BITRATES_KBPS[layerBits];
  const bitrateKbps = bitrateTable?.[bitrateIndex] || 0;
  if (!bitrateKbps) return null;

  const baseRates = versionBits === 3
    ? [44100, 48000, 32000]
    : versionBits === 2
      ? [22050, 24000, 16000]
      : [11025, 12000, 8000];
  const sampleRate = baseRates[sampleRateIndex];
  if (!sampleRate) return null;

  const bitrate = bitrateKbps * 1000;
  let frameBytes = 0;
  let samples = 0;
  if (layerBits === 3) {
    samples = 384;
    frameBytes = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  } else if (layerBits === 2) {
    samples = 1152;
    frameBytes = Math.floor((144 * bitrate) / sampleRate + padding);
  } else {
    samples = mpeg1 ? 1152 : 576;
    frameBytes = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate + padding);
  }
  if (frameBytes < 4) return null;
  return { frameBytes, samples, sampleRate };
}

/**
 * Measures complete MPEG audio frames already present in a prefix. Leading
 * ID3v2 is skipped defensively so legacy cloud masters still warm correctly.
 * Xing/VBRI/LAME data is left untouched: duration comes from the MPEG frames
 * themselves, so variable bitrate prefixes are handled naturally.
 */
export function inspectMp3PlayablePrefix(input: ArrayBuffer | Uint8Array): Mp3PlayablePrefixInfo {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let offset = id3v2PrefixLength(bytes);
  let firstFrameOffset: number | null = null;
  let completeFrames = 0;
  let playableSeconds = 0;

  while (offset + 4 <= bytes.byteLength) {
    const frame = parseFrame(bytes, offset);
    if (!frame) {
      if (firstFrameOffset !== null) break;
      offset += 1;
      continue;
    }
    if (offset + frame.frameBytes > bytes.byteLength) break;

    if (firstFrameOffset === null) firstFrameOffset = offset;
    completeFrames += 1;
    playableSeconds += frame.samples / frame.sampleRate;
    offset += frame.frameBytes;
  }

  return { playableSeconds, completeFrames, firstFrameOffset };
}
