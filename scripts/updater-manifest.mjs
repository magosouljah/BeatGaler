import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSemver(value) {
  const raw = String(value ?? "").trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!match) throw new Error(`Invalid updater version: ${value}`);
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
  };
}

export function compareSemver(aValue, bValue) {
  const a = parseSemver(aValue);
  const b = parseSemver(bValue);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function validPlatformKey(key) {
  return /^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)$/.test(key);
}

function assertHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
}

export function validateStaticUpdaterManifest(manifest, { currentVersion = null } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Updater manifest root must be an object.");
  }
  const version = parseSemver(manifest.version).raw;
  if (currentVersion && compareSemver(version, currentVersion) <= 0) {
    throw new Error(`Updater version ${version} must be newer than installed ${currentVersion}.`);
  }
  if (!manifest.platforms || typeof manifest.platforms !== "object" || Array.isArray(manifest.platforms)) {
    throw new Error("Updater manifest must contain platforms.");
  }
  const entries = Object.entries(manifest.platforms);
  if (entries.length === 0) throw new Error("Updater manifest must contain at least one platform artifact.");
  for (const [target, artifact] of entries) {
    if (!validPlatformKey(target)) throw new Error(`Unsupported updater platform key: ${target}`);
    if (!artifact || typeof artifact !== "object") throw new Error(`${target} artifact must be an object.`);
    assertHttpsUrl(artifact.url, `${target}.url`);
    const signature = String(artifact.signature ?? "").trim();
    if (!signature) throw new Error(`${target}.signature is required.`);
    if (/^(https?:|file:)/i.test(signature) || /[\\/]\.sig$/i.test(signature)) {
      throw new Error(`${target}.signature must contain signature bytes/text, not a URL or file path.`);
    }
  }
  if (manifest.pub_date != null && Number.isNaN(Date.parse(String(manifest.pub_date)))) {
    throw new Error("pub_date must be an RFC3339-compatible date.");
  }
  return { version, targets: entries.map(([target]) => target) };
}

export function validateUpdaterActivationConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Updater activation config must be an object.");
  const endpoint = String(config.endpoint ?? "").trim();
  const pubkey = String(config.pubkey ?? "").trim();
  assertHttpsUrl(endpoint, "Updater endpoint");
  if (!pubkey || pubkey.length < 32) throw new Error("Updater public key is missing or implausibly short.");
  if (/PRIVATE KEY/i.test(pubkey)) throw new Error("Updater config must never contain a private signing key.");
  return true;
}

function readCurrentVersion() {
  return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
}

function requireArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

export function buildStaticUpdaterManifest({ version, platform, artifactUrl, signature, notes = "", pubDate = new Date().toISOString(), baseManifest = null }) {
  const normalizedVersion = parseSemver(version).raw;
  const reusablePlatforms = baseManifest && typeof baseManifest === "object" && !Array.isArray(baseManifest)
    && parseSemver(baseManifest.version).raw === normalizedVersion
    && baseManifest.platforms && typeof baseManifest.platforms === "object" && !Array.isArray(baseManifest.platforms)
      ? { ...baseManifest.platforms }
      : {};
  const manifest = {
    version: normalizedVersion,
    notes: String(notes || baseManifest?.notes || ""),
    pub_date: new Date(pubDate).toISOString(),
    platforms: {
      ...reusablePlatforms,
      [platform]: {
        signature: String(signature).trim(),
        url: String(artifactUrl).trim(),
      },
    },
  };
  validateStaticUpdaterManifest(manifest);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "validate") {
      const file = args[0];
      if (!file) throw new Error("Usage: node scripts/updater-manifest.mjs validate <latest.json>");
      const manifest = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
      const result = validateStaticUpdaterManifest(manifest, { currentVersion: readCurrentVersion() });
      console.log(`PASS updater manifest: ${result.version} (${result.targets.join(", ")})`);
    } else if (command === "validate-release") {
      const file = args[0];
      if (!file) throw new Error("Usage: node scripts/updater-manifest.mjs validate-release <latest.json>");
      const manifest = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
      const result = validateStaticUpdaterManifest(manifest);
      console.log(`PASS release updater manifest: ${result.version} (${result.targets.join(", ")})`);
    } else if (command === "generate") {
      const version = requireArg(args, "--version");
      const platform = requireArg(args, "--platform");
      const artifact = path.resolve(requireArg(args, "--artifact"));
      const signatureFile = path.resolve(requireArg(args, "--signature"));
      const artifactUrl = requireArg(args, "--url");
      const output = path.resolve(requireArg(args, "--output"));
      const notesIndex = args.indexOf("--notes");
      const notes = notesIndex >= 0 && notesIndex + 1 < args.length ? args[notesIndex + 1] : "";
      const mergeIndex = args.indexOf("--merge-existing");
      const mergeFile = mergeIndex >= 0 && mergeIndex + 1 < args.length ? path.resolve(args[mergeIndex + 1]) : null;
      let baseManifest = null;
      if (mergeFile && fs.existsSync(mergeFile)) {
        baseManifest = JSON.parse(fs.readFileSync(mergeFile, "utf8"));
        validateStaticUpdaterManifest(baseManifest);
      }
      if (!fs.existsSync(artifact)) throw new Error(`Updater artifact does not exist: ${artifact}`);
      if (!fs.existsSync(signatureFile)) throw new Error(`Updater signature does not exist: ${signatureFile}`);
      if (fs.statSync(artifact).size === 0) throw new Error("Updater artifact is empty.");
      const signature = fs.readFileSync(signatureFile, "utf8").trim();
      const manifest = buildStaticUpdaterManifest({ version, platform, artifactUrl, signature, notes, baseManifest });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      console.log(`PASS generated updater manifest: ${output}`);
    } else {
      throw new Error("Usage: updater-manifest.mjs <validate|validate-release|generate> ...");
    }
  } catch (error) {
    console.error(`FAIL updater manifest: ${error.message}`);
    process.exit(1);
  }
}
