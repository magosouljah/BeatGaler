import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const paths = {
  version: path.join(root, "VERSION"),
  packageJson: path.join(root, "package.json"),
  packageLock: path.join(root, "package-lock.json"),
  tauriConf: path.join(root, "src-tauri", "tauri.conf.json"),
  cargoToml: path.join(root, "src-tauri", "Cargo.toml"),
  cargoLock: path.join(root, "src-tauri", "Cargo.lock"),
  settingsPanel: path.join(root, "src", "components", "SettingsPanel.tsx"),
  indexHtml: path.join(root, "index.html"),
};

function fail(message) {
  throw new Error(message);
}

function parseSemver(value) {
  const version = String(value ?? "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) fail(`Invalid semantic version "${version}". Example: 0.3.0 or 0.3.0-beta.1.`);
  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
  };
}

function stablePart(value) {
  const parsed = parseSemver(value);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function nextPatch(value) {
  const parsed = parseSemver(value);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function readRequired(file) {
  if (!fs.existsSync(file)) fail(`Missing required file: ${path.relative(root, file)}`);
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  return JSON.parse(readRequired(file));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readVersionFile() {
  return parseSemver(readRequired(paths.version)).raw;
}

function writeVersionFile(version) {
  fs.writeFileSync(paths.version, `${parseSemver(version).raw}\n`, "utf8");
}

function productNameFor(version) {
  const parsed = parseSemver(version);
  return /^beta(?:\.|$)/i.test(parsed.prerelease) ? "Beat Galer Beta" : "Beat Galer";
}

function resolveRequestedVersion(input, channel, currentVersion) {
  let base = input === "bump" ? nextPatch(currentVersion) : input;
  parseSemver(base);

  const normalizedChannel = String(channel || "").toLowerCase();
  if (!normalizedChannel) return parseSemver(base).raw;

  if (normalizedChannel === "stable") return stablePart(base);
  if (normalizedChannel === "beta") {
    const parsed = parseSemver(base);
    if (parsed.prerelease) {
      if (!/^beta(?:\.|$)/i.test(parsed.prerelease)) {
        fail(`Beta mode requires a beta prerelease, received: ${base}`);
      }
      return parsed.raw;
    }
    return `${stablePart(base)}-beta.1`;
  }

  fail(`Unknown channel "${channel}". Use beta or stable.`);
}

function updateCargoToml(raw, version) {
  const lines = raw.split(/\r?\n/);
  let inPackage = false;
  let updated = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\[package\]\s*$/.test(line)) {
      inPackage = true;
      continue;
    }
    if (/^\s*\[.+\]\s*$/.test(line)) inPackage = false;
    if (inPackage && /^\s*version\s*=\s*"[^"]+"\s*$/.test(line)) {
      lines[i] = `version = "${version}"`;
      updated = true;
      break;
    }
  }
  if (!updated) fail("Could not locate [package] version in src-tauri/Cargo.toml.");
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function updateCargoLock(raw, version) {
  const pattern = /(\[\[package\]\]\r?\nname = "beat_galer"\r?\nversion = ")[^"]+("\r?\n)/;
  if (!pattern.test(raw)) fail("Could not locate beat_galer package version in src-tauri/Cargo.lock.");
  return raw.replace(pattern, `$1${version}$2`);
}

function updateSettings(raw, version, productName) {
  const pattern = /Beat\s*Galer(?:\s+Beta)?\s+\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
  if (!pattern.test(raw)) fail("Could not locate visible BeatGaler version in SettingsPanel.tsx.");
  return raw.replace(pattern, `${productName} ${version}`);
}

function updateIndexHtml(raw, productName) {
  const pattern = /<title>[^<]*<\/title>/i;
  if (!pattern.test(raw)) fail("Could not locate <title> in index.html.");
  return raw.replace(pattern, `<title>${productName}</title>`);
}

function sync(version) {
  const nextVersion = parseSemver(version).raw;
  const productName = productNameFor(nextVersion);

  // Validate/read everything first so a bad source file cannot leave a half-written version update.
  const packageJson = readJson(paths.packageJson);
  const packageLock = readJson(paths.packageLock);
  const tauriConf = readJson(paths.tauriConf);
  const cargoTomlRaw = readRequired(paths.cargoToml);
  const cargoLockRaw = readRequired(paths.cargoLock);
  const settingsRaw = readRequired(paths.settingsPanel);
  const indexRaw = readRequired(paths.indexHtml);

  if (!packageLock.packages?.[""]) fail('package-lock.json does not contain packages[""].');

  const nextCargoToml = updateCargoToml(cargoTomlRaw, nextVersion);
  const nextCargoLock = updateCargoLock(cargoLockRaw, nextVersion);
  const nextSettings = updateSettings(settingsRaw, nextVersion, productName);
  const nextIndex = updateIndexHtml(indexRaw, productName);

  packageJson.version = nextVersion;
  packageLock.version = nextVersion;
  packageLock.packages[""].version = nextVersion;
  tauriConf.version = nextVersion;
  tauriConf.productName = productName;
  if (Array.isArray(tauriConf.app?.windows)) {
    for (const window of tauriConf.app.windows) window.title = productName;
  }

  writeVersionFile(nextVersion);
  writeJson(paths.packageJson, packageJson);
  writeJson(paths.packageLock, packageLock);
  fs.writeFileSync(paths.cargoToml, nextCargoToml, "utf8");
  fs.writeFileSync(paths.cargoLock, nextCargoLock, "utf8");
  writeJson(paths.tauriConf, tauriConf);
  fs.writeFileSync(paths.settingsPanel, nextSettings, "utf8");
  fs.writeFileSync(paths.indexHtml, nextIndex, "utf8");

  console.log(`BeatGaler version synced: ${nextVersion}`);
  console.log(`App name: ${productName}`);
}

function currentVersions() {
  const packageJson = readJson(paths.packageJson);
  const packageLock = readJson(paths.packageLock);
  const tauriConf = readJson(paths.tauriConf);
  const cargoToml = readRequired(paths.cargoToml);
  const cargoLock = readRequired(paths.cargoLock);
  const settings = readRequired(paths.settingsPanel);
  const index = readRequired(paths.indexHtml);

  const cargoTomlMatch = cargoToml.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  const cargoLockMatch = cargoLock.match(/\[\[package\]\]\r?\nname = "beat_galer"\r?\nversion = "([^"]+)"/);
  const settingsMatch = settings.match(/Beat\s*Galer(?:\s+Beta)?\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);

  return {
    VERSION: readVersionFile(),
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    "package-lock root": packageLock.packages?.[""]?.version,
    "tauri.conf.json": tauriConf.version,
    "Cargo.toml": cargoTomlMatch?.[1],
    "Cargo.lock": cargoLockMatch?.[1],
    "SettingsPanel.tsx": settingsMatch?.[1],
    productName: tauriConf.productName,
    windowTitle: tauriConf.app?.windows?.[0]?.title,
    htmlTitle: index.match(/<title>([^<]*)<\/title>/i)?.[1],
  };
}

function check() {
  const versions = currentVersions();
  const expected = versions.VERSION;
  const versionKeys = [
    "package.json",
    "package-lock.json",
    "package-lock root",
    "tauri.conf.json",
    "Cargo.toml",
    "Cargo.lock",
    "SettingsPanel.tsx",
  ];
  const mismatches = versionKeys.filter((key) => versions[key] !== expected);

  for (const key of ["VERSION", ...versionKeys]) console.log(`${key}: ${versions[key] ?? "MISSING"}`);

  const expectedName = productNameFor(expected);
  const nameMismatches = ["productName", "windowTitle", "htmlTitle"].filter((key) => versions[key] !== expectedName);
  console.log(`productName: ${versions.productName ?? "MISSING"}`);
  console.log(`windowTitle: ${versions.windowTitle ?? "MISSING"}`);
  console.log(`htmlTitle: ${versions.htmlTitle ?? "MISSING"}`);

  if (mismatches.length || nameMismatches.length) {
    const details = [
      ...mismatches.map((key) => `${key}=${versions[key] ?? "MISSING"}`),
      ...nameMismatches.map((key) => `${key}=${versions[key] ?? "MISSING"}`),
    ];
    fail(`Version/name mismatch. VERSION is the source of truth (${expected}): ${details.join(", ")}`);
  }

  console.log(`PASS version guard: VERSION is the single source of truth (${expected}).`);
}

function help() {
  console.log(`\nBeatGaler version manager — VERSION is the source of truth\n\nCommands:\n  npm run version:show\n  npm run version:check\n  npm run version:sync\n  npm run version:set -- 0.3.1 beta\n  npm run version:set -- 0.3.1 stable\n  npm run version:set -- 0.3.1-beta.2 beta\n  npm run version:bump -- beta\n  npm run version:bump -- stable\n\nExamples:\n  0.3.1 + beta   -> 0.3.1-beta.1 / Beat Galer Beta\n  0.3.1 + stable -> 0.3.1 / Beat Galer\n`);
}

const [mode = "help", ...args] = process.argv.slice(2);

switch (mode) {
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  case "show":
    console.log(readVersionFile());
    break;
  case "check":
    check();
    break;
  case "sync":
    sync(readVersionFile());
    break;
  case "set": {
    if (!args[0]) fail("Missing version. Example: npm run version:set -- 0.3.1 beta");
    const current = readVersionFile();
    const requested = resolveRequestedVersion(args[0], args[1], current);
    sync(requested);
    break;
  }
  case "bump-patch": {
    const current = readVersionFile();
    const requested = resolveRequestedVersion("bump", args[0] || "stable", current);
    sync(requested);
    break;
  }
  default:
    fail(`Unknown version command "${mode}". Run: node scripts/version.mjs help`);
}
