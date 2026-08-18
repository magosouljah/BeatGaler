import { cleanTags, normalizeBeatMetadata, normalizeTag, validateBpm, validateMusicKey, validateTag } from "../../src/lib/metadataValidation.js";
import { NATIVE_EXTERNAL_IMAGE_PREFIX, nativeExternalImageSignalFromPaths } from "../../src/features/dragdrop/nativeExternalImage.js";
import { assert, deepEqual, equal, runSuite } from "../helpers/testHarness.js";

function rng(seed = 0x5eed1234): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const random = rng();
const atoms = [
  "a", "Z", "0", "9", " ", "_", "-", ".", "/", "\\", ":", ";", "'", '"', "<", ">", "?", "*", "|", "[", "]", "(", ")",
  "\0", "\n", "\r", "\t", "😀", "é", "ñ", "中", "♯", "♭", "%", "&", "=", "#", "..", "CON", "NUL", "AUX",
];

function randomString(maxParts = 40): string {
  const count = Math.floor(random() * maxParts);
  let out = "";
  for (let i = 0; i < count; i += 1) out += atoms[Math.floor(random() * atoms.length)];
  return out;
}

runSuite("Security/property fuzz", [
  ["tag normalization is idempotent across 5000 adversarial strings", () => {
    for (let i = 0; i < 5000; i += 1) {
      const value = randomString();
      const once = normalizeTag(value);
      const twice = normalizeTag(once);
      equal(twice, once, `normalizeTag stopped being idempotent for ${JSON.stringify(value)}`);
    }
  }],
  ["every accepted fuzzed tag satisfies the public tag contract", () => {
    const allowed = /^[a-z0-9]+(?:[ _-][a-z0-9]+)*$/;
    for (let i = 0; i < 5000; i += 1) {
      const value = randomString();
      const result = validateTag(value);
      if (!result.valid) continue;
      assert(result.normalized.length > 0 && result.normalized.length <= 40, "Accepted tag escaped length bounds");
      assert(allowed.test(result.normalized), `Accepted unsafe tag: ${JSON.stringify(result.normalized)}`);
      equal(result.normalized, normalizeTag(value), "Accepted tag normalization drifted");
    }
  }],
  ["cleanTags always produces unique valid tags and respects the 30-tag cap", () => {
    for (let round = 0; round < 300; round += 1) {
      const input = Array.from({ length: 70 }, () => randomString(12));
      const result = cleanTags(input);
      assert(result.tags.length <= 30, "cleanTags escaped its 30-tag cap");
      equal(new Set(result.tags).size, result.tags.length, "cleanTags produced duplicates");
      for (const tag of result.tags) equal(validateTag(tag).valid, true, `cleanTags emitted invalid tag: ${tag}`);
    }
  }],
  ["BPM validation never accepts a number outside 60..300", () => {
    for (let i = 0; i < 5000; i += 1) {
      const value = randomString(8);
      const result = validateBpm(value);
      if (!result.valid || result.normalized === "") continue;
      const bpm = Number(result.normalized);
      assert(Number.isFinite(bpm) && bpm >= 60 && bpm <= 300, `Accepted BPM outside bounds: ${result.normalized}`);
    }
  }],
  ["music-key validation emits only canonical normalized keys", () => {
    const canonical = /^[A-G](?:#|b)?$|^[a-g](?:#|b)?m$/;
    for (let i = 0; i < 5000; i += 1) {
      const value = randomString(8);
      const result = validateMusicKey(value);
      if (!result.valid || result.normalized === "") continue;
      assert(canonical.test(result.normalized), `Accepted non-canonical key: ${JSON.stringify(result.normalized)}`);
    }
  }],
  ["metadata normalization is idempotent under adversarial metadata", () => {
    for (let i = 0; i < 1000; i += 1) {
      const beat = {
        name: randomString(20),
        tags: Array.from({ length: Math.floor(random() * 40) }, () => randomString(10)),
        bpm: randomString(6),
        key: randomString(6),
      };
      const once = normalizeBeatMetadata(beat);
      const twice = normalizeBeatMetadata(once);
      deepEqual(twice, once, "normalizeBeatMetadata stopped being idempotent");
    }
  }],
  ["dangerous URL schemes can never enter the native external-image router", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///C:/Windows/System32/calc.exe",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com/a.jpg",
      "blob:https://example.com/123",
    ]) {
      const signal = nativeExternalImageSignalFromPaths([`${NATIVE_EXTERNAL_IMAGE_PREFIX}${encodeURIComponent(url)}`]);
      equal(signal, null, `Dangerous URL scheme was accepted: ${url}`);
    }
  }],
  ["5000 malformed native image sentinels never crash or yield a non-http URL", () => {
    for (let i = 0; i < 5000; i += 1) {
      const payload = randomString(25);
      const signal = nativeExternalImageSignalFromPaths([`${NATIVE_EXTERNAL_IMAGE_PREFIX}${payload}`]);
      if (!signal || signal.kind !== "drop") continue;
      const protocol = new URL(signal.url).protocol;
      assert(protocol === "http:" || protocol === "https:", `Unsafe protocol escaped router: ${protocol}`);
    }
  }],
]);
