import assert from "node:assert/strict";
import { buildStaticUpdaterManifest, validateStaticUpdaterManifest } from "./updater-manifest.mjs";

const signature = "dGVzdC1zaWduYXR1cmUtYnl0ZXMtdGhhdC1hcmUtbm90LWEtcGF0aA==";
const version = "0.7.1";

const windows = buildStaticUpdaterManifest({
  version,
  platform: "windows-x86_64",
  artifactUrl: "https://example.invalid/BeatGaler-0.7.1.nsis.zip",
  signature,
  pubDate: "2026-08-19T12:00:00Z",
});
const withArmMac = buildStaticUpdaterManifest({
  version,
  platform: "darwin-aarch64",
  artifactUrl: "https://example.invalid/BeatGaler-0.7.1.app.tar.gz",
  signature,
  baseManifest: windows,
  pubDate: "2026-08-19T12:01:00Z",
});
const withBothMac = buildStaticUpdaterManifest({
  version,
  platform: "darwin-x86_64",
  artifactUrl: "https://example.invalid/BeatGaler-0.7.1.app.tar.gz",
  signature,
  baseManifest: withArmMac,
  pubDate: "2026-08-19T12:02:00Z",
});

assert.deepEqual(
  Object.keys(withBothMac.platforms).sort(),
  ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"].sort(),
  "Mac updater generation must preserve an existing Windows entry and both Mac architectures",
);

const macFirst = buildStaticUpdaterManifest({
  version,
  platform: "darwin-aarch64",
  artifactUrl: "https://example.invalid/BeatGaler-0.7.1.app.tar.gz",
  signature,
  pubDate: "2026-08-19T12:03:00Z",
});
const windowsSecond = buildStaticUpdaterManifest({
  version,
  platform: "windows-x86_64",
  artifactUrl: "https://example.invalid/BeatGaler-0.7.1.nsis.zip",
  signature,
  baseManifest: macFirst,
  pubDate: "2026-08-19T12:04:00Z",
});
assert.ok(windowsSecond.platforms["darwin-aarch64"], "Windows updater generation must preserve an existing Mac entry");
assert.ok(windowsSecond.platforms["windows-x86_64"], "Windows entry must be added");

const differentVersionBase = { ...withBothMac, version: "0.7.0" };
const newer = buildStaticUpdaterManifest({
  version,
  platform: "darwin-aarch64",
  artifactUrl: "https://example.invalid/BeatGaler-0.7.1.app.tar.gz",
  signature,
  baseManifest: differentVersionBase,
  pubDate: "2026-08-19T12:05:00Z",
});
assert.deepEqual(Object.keys(newer.platforms), ["darwin-aarch64"], "Updater must never merge platform artifacts from a different release version");
validateStaticUpdaterManifest(withBothMac);
console.log("PASS updater manifest cross-platform merge regression");
