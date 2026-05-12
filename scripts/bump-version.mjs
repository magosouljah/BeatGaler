import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");

function bumpPatch(version) {
  const parts = version.split(".").map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n) || n < 0)) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${patch + 1}`;
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const currentVersion = packageJson.version;
const nextVersion = bumpPatch(currentVersion);

packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const cargoToml = fs.readFileSync(cargoTomlPath, "utf8").split(/\r?\n/);
let inPackageSection = false;
let cargoUpdated = false;
for (let i = 0; i < cargoToml.length; i += 1) {
  const line = cargoToml[i];
  if (/^\s*\[package\]\s*$/.test(line)) {
    inPackageSection = true;
    continue;
  }
  if (/^\s*\[.+\]\s*$/.test(line) && !/^\s*\[package\]\s*$/.test(line)) {
    inPackageSection = false;
  }
  if (inPackageSection && /^\s*version\s*=\s*".*"\s*$/.test(line)) {
    cargoToml[i] = `version = "${nextVersion}"`;
    cargoUpdated = true;
    break;
  }
}
if (!cargoUpdated) {
  throw new Error("Could not update [package] version in Cargo.toml");
}
fs.writeFileSync(cargoTomlPath, `${cargoToml.join("\n")}\n`);

const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = nextVersion;
fs.writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`);

console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`);
