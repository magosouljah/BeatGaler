const INTERNAL_SIZE = 16;
const OUTPUT_SIZE = 128;
const BACKGROUND_HEX = "#0c0c0c";
const GENERATOR_VERSION = "bg-v1";

const cache = new Map<string, string>();

type Uint64Parts = { lo: number; hi: number };

// FNV-1a 64-bit implemented as two uint32 words. This intentionally avoids
// BigInt literals so the production bundle remains compatible with Safari 13,
// while producing the exact same 64-bit hash as the previous BigInt version.
function fnv1a64(str: string): Uint64Parts {
  let lo = 0x84222325;
  let hi = 0xcbf29ce4;

  // FNV prime 0x00000100000001B3 = (0x100 << 32) + 0x1B3.
  const primeLow = 0x1b3;
  for (let i = 0; i < str.length; i += 1) {
    lo = (lo ^ str.charCodeAt(i)) >>> 0;

    const lowProduct = lo * primeLow;
    const nextLo = lowProduct >>> 0;
    const carry = Math.floor(lowProduct / 0x100000000);
    const nextHi = (carry + hi * primeLow + lo * 0x100) >>> 0;

    lo = nextLo;
    hi = nextHi;
  }

  return { lo, hi };
}

function rngFromSeed(text: string): () => number {
  const { lo: a, hi: b } = fnv1a64(text);
  let s = (a ^ ((b << 13) | (b >>> 19)) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const rand = (rng: () => number, min: number, max: number) => min + (max - min) * rng();
const wrapHue = (h: number) => ((h % 360) + 360) % 360;

function weightedPick<T>(rng: () => number, entries: { v: T; w: number }[]): T {
  let r = rng() * entries.reduce((sum, entry) => sum + entry.w, 0);
  for (const entry of entries) {
    r -= entry.w;
    if (r <= 0) return entry.v;
  }
  return entries[entries.length - 1].v;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = wrapHue(h) / 360;
  const sat = s / 100;
  const lit = l / 100;
  if (sat === 0) return [lit, lit, lit];
  const hue2rgb = (p: number, q: number, t: number) => {
    let time = t;
    if (time < 0) time += 1;
    if (time > 1) time -= 1;
    if (time < 1 / 6) return p + (q - p) * 6 * time;
    if (time < 1 / 2) return q;
    if (time < 2 / 3) return p + (q - p) * (2 / 3 - time) * 6;
    return p;
  };
  const q = lit < 0.5 ? lit * (1 + sat) : lit + sat - lit * sat;
  const p = 2 * lit - q;
  return [hue2rgb(p, q, hue + 1 / 3), hue2rgb(p, q, hue), hue2rgb(p, q, hue - 1 / 3)];
}

function colorProfile(rng: () => number) {
  const roll = rng();
  if (roll < 0.9) return { s: rand(rng, 82, 100), l: rand(rng, 50, 66) };
  if (roll < 0.97) return { s: rand(rng, 76, 90), l: rand(rng, 48, 62) };
  return { s: rand(rng, 70, 84), l: rand(rng, 46, 60) };
}

function chooseColorCount(rng: () => number) {
  return weightedPick(rng, [
    { v: 2, w: 45 },
    { v: 3, w: 35 },
    { v: 4, w: 20 },
  ]);
}

function harmonyHues(rng: () => number, base: number, colorCount: number) {
  const mode = weightedPick(rng, [
    { v: "analogous", w: 30 },
    { v: "complementary", w: 25 },
    { v: "split", w: 20 },
    { v: "triadic", w: 15 },
    { v: "wide-arc", w: 10 },
  ]);

  let pool: number[];
  if (mode === "analogous") {
    const spread = rand(rng, 26, 68);
    pool = [base, base - spread, base + spread, base + rand(rng, -spread * 0.55, spread * 0.55)];
  } else if (mode === "complementary") {
    const opposite = base + rand(rng, 168, 192);
    pool = [base, opposite, base + rand(rng, -28, 28), opposite + rand(rng, -24, 24)];
  } else if (mode === "split") {
    pool = [base, base + rand(rng, 145, 166), base - rand(rng, 145, 166), base + rand(rng, -26, 26)];
  } else if (mode === "triadic") {
    pool = [base, base + 120 + rand(rng, -10, 10), base + 240 + rand(rng, -10, 10), base + rand(rng, -22, 22)];
  } else {
    const width = rand(rng, 125, 165);
    const start = base - width / 2;
    pool = [base, start + rand(rng, 0, width), start + rand(rng, 0, width), start + rand(rng, 0, width)];
  }

  const hues: number[] = [];
  for (const hue of pool) {
    const wrapped = wrapHue(hue);
    if (!hues.some(existing => Math.abs((((wrapped - existing) + 540) % 360) - 180) < 10)) hues.push(wrapped);
    if (hues.length === colorCount) break;
  }
  while (hues.length < colorCount) hues.push(wrapHue(base + rand(rng, -160, 160)));
  return hues;
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

type Blob = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rot: number;
  intensity: number;
  color: [number, number, number];
  idx: number;
};

function makeSpec(seedText: string) {
  const rng = rngFromSeed(seedText);
  const colorCount = chooseColorCount(rng);
  const base = rand(rng, 0, 360);
  const hues = harmonyHues(rng, base, colorCount);
  const colors = hues.map((hue) => {
    const profile = colorProfile(rng);
    return { rgb: hslToRgb(hue, profile.s, profile.l) as [number, number, number] };
  });

  const blobCount = Math.floor(rand(rng, 5, 9.999));
  const targetCoverage = rand(rng, 0.42, 0.68);
  const weightsByCount: Record<number, number[]> = {
    2: [68, 32],
    3: [56, 29, 15],
    4: [50, 27, 15, 8],
  };
  const colorWeights = weightsByCount[colorCount];

  const blobs: Blob[] = [];
  for (let i = 0; i < blobCount; i += 1) {
    const idx = weightedPick(rng, colorWeights.map((w, colorIndex) => ({ v: colorIndex, w })));
    blobs.push({
      cx: rand(rng, 0.04, 0.96),
      cy: rand(rng, 0.04, 0.96),
      rx: rand(rng, 0.18, 0.54),
      ry: rand(rng, 0.18, 0.54),
      rot: rand(rng, 0, Math.PI * 2),
      intensity: rand(rng, 0.68, 1.2),
      color: colors[idx].rgb,
      idx,
    });
  }

  for (let idx = 0; idx < colorCount; idx += 1) {
    if (!blobs.some((blob) => blob.idx === idx)) {
      const replaceAt = Math.max(0, blobs.length - 1 - idx);
      blobs[replaceAt].idx = idx;
      blobs[replaceAt].color = colors[idx].rgb;
      if (idx >= 2) {
        blobs[replaceAt].rx *= 0.78;
        blobs[replaceAt].ry *= 0.78;
        blobs[replaceAt].intensity *= 0.88;
      }
    }
  }

  return { blobs, targetCoverage };
}

function renderProceduralCanvas(seedText: string, outputSize = OUTPUT_SIZE, backgroundHex = BACKGROUND_HEX): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const spec = makeSpec(seedText);
  const bg = hexToRgb01(backgroundHex);
  const source = document.createElement("canvas");
  source.width = INTERNAL_SIZE;
  source.height = INTERNAL_SIZE;
  const sctx = source.getContext("2d");
  if (!sctx) return null;
  const image = sctx.createImageData(INTERNAL_SIZE, INTERNAL_SIZE);
  const pixelRng = rngFromSeed(`${seedText}:pixels`);

  for (let y = 0; y < INTERNAL_SIZE; y += 1) {
    for (let x = 0; x < INTERNAL_SIZE; x += 1) {
      const u = (x + 0.5) / INTERNAL_SIZE;
      const v = (y + 0.5) / INTERNAL_SIZE;
      let sum = 0;
      let rr = 0;
      let gg = 0;
      let bb = 0;

      for (const blob of spec.blobs) {
        const dx = u - blob.cx;
        const dy = v - blob.cy;
        const c = Math.cos(blob.rot);
        const s = Math.sin(blob.rot);
        const qx = (dx * c - dy * s) / blob.rx;
        const qy = (dx * s + dy * c) / blob.ry;
        let w = Math.exp(-(qx * qx + qy * qy) * 1.75) * blob.intensity;
        w *= rand(pixelRng, 0.92, 1.08);
        sum += w;
        rr += blob.color[0] * w;
        gg += blob.color[1] * w;
        bb += blob.color[2] * w;
      }

      const density = 1 - Math.exp(-sum * 0.84);
      const cover = clamp((density - 0.13) / Math.max(0.24, 1 - spec.targetCoverage));
      const alpha = clamp(Math.pow(cover, 0.92), 0, 0.88);
      if (sum > 0.0001) {
        rr /= sum;
        gg /= sum;
        bb /= sum;
      }

      const edgeDark = Math.pow(Math.min(u, 1 - u, v, 1 - v) * 2, 0.4);
      const a = alpha * clamp(edgeDark * 0.94 + 0.06);
      const r = bg[0] * (1 - a) + rr * a;
      const g = bg[1] * (1 - a) + gg * a;
      const b = bg[2] * (1 - a) + bb * a;
      const i = (y * INTERNAL_SIZE + x) * 4;
      image.data[i] = Math.round(clamp(r) * 255);
      image.data[i + 1] = Math.round(clamp(g) * 255);
      image.data[i + 2] = Math.round(clamp(b) * 255);
      image.data[i + 3] = 255;
    }
  }
  sctx.putImageData(image, 0, 0);

  const output = document.createElement("canvas");
  output.width = outputSize;
  output.height = outputSize;
  const ctx = output.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, output.width, output.height);
  ctx.fillStyle = backgroundHex;
  ctx.fillRect(0, 0, output.width, output.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  const blur = Math.max(8, output.width / 24);
  ctx.filter = `blur(${blur}px) saturate(1.08)`;
  const pad = blur * 2;
  ctx.drawImage(source, -pad, -pad, output.width + pad * 2, output.height + pad * 2);
  ctx.restore();
  return output;
}

export function getProceduralBeatBackgroundDataUrl(beatId: string): string | null {
  const key = `${GENERATOR_VERSION}:${beatId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const canvas = renderProceduralCanvas(key);
  if (!canvas) return null;
  const dataUrl = canvas.toDataURL("image/png");
  cache.set(key, dataUrl);
  return dataUrl;
}


// Test-only white-box seam. Production callers should use
// getProceduralBeatBackgroundDataUrl(); this exposes deterministic generator
// internals so unit tests can protect distribution/range invariants without a DOM.
export const __testProceduralBeatBackground = {
  makeSpec,
  rngFromSeed,
  hslToRgb,
  chooseColorCount,
  harmonyHues,
};
