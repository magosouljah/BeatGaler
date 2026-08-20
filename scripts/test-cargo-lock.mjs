import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lockPath = path.join(root, "src-tauri", "Cargo.lock");
const lock = fs.readFileSync(lockPath, "utf8");

const blocks = lock.split(/(?=\[\[package\]\]\r?\n)/g);
const packages = blocks
  .filter((block) => block.startsWith("[[package]]"))
  .map((block) => {
    const name = block.match(/^name = "([^"]+)"/m)?.[1] ?? "";
    const version = block.match(/^version = "([^"]+)"/m)?.[1] ?? "";
    const dependenciesBlock = block.match(/^dependencies = \[(.*?)^\]/ms)?.[1] ?? "";
    const dependencies = [...dependenciesBlock.matchAll(/^\s*"([^"]+)"/gm)].map((match) => match[1]);
    return { name, version, dependencies, block };
  });

let passed = 0;
function ok(condition, message) {
  if (!condition) {
    console.error(`FAIL Cargo.lock: ${message}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`PASS ${message}`);
}

const rootPackage = packages.find((pkg) => pkg.name === "beat_galer");
ok(Boolean(rootPackage), "root beat_galer package exists in Cargo.lock");

for (const dependency of ["zip", "unicode-normalization", "tauri-plugin-single-instance"]) {
  ok(rootPackage?.dependencies.some((entry) => entry === dependency || entry.startsWith(`${dependency} `)), `root lock dependencies include ${dependency}`);
}

const exactPackages = new Map([
  ["zip", "4.6.1"],
  ["unicode-normalization", "0.1.25"],
  ["tauri-plugin-single-instance", "2.4.3"],
]);

for (const [name, version] of exactPackages) {
  ok(packages.some((pkg) => pkg.name === name && pkg.version === version), `${name} is locked to ${version}`);
}

if (process.exitCode) {
  console.error("Cargo.lock is stale. Run Cargo once from the current Cargo.toml, then commit the regenerated src-tauri/Cargo.lock.");
  process.exit(process.exitCode);
}

console.log(`PASS Cargo.lock portability gate (${passed} invariants)`);
