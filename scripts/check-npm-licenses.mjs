import fs from "node:fs";
import path from "node:path";

const lockPath = path.resolve("package-lock.json");
const reportPath = path.resolve("artifacts/supply-chain/npm-licenses.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

// This list is intentionally exact. A new license expression must be reviewed
// instead of silently entering the build graph.
const allowed = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 OR MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT AND Zlib",
  "MIT OR Apache-2.0",
  "MIT OR CC0-1.0",
  "MIT OR GPL-3.0-or-later",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
  "(MIT AND Zlib)",
  "(MIT OR CC0-1.0)",
  "(MIT OR GPL-3.0-or-later)"
]);

// css-value 0.0.1 omits license metadata from its npm manifest, but its
// upstream README carries the MIT license. Keep the override narrow so a
// version change requires a fresh review.
const metadataOverrides = new Map([
  ["css-value@0.0.1", {
    license: "MIT",
    evidence: "upstream README: visionmedia/css-value, MIT license"
  }]
]);

const packages = [];
const failures = [];
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!packagePath) continue;
  const name = packagePath.replace(/^node_modules\//, "");
  const version = metadata.version ?? "unknown";
  const key = `${name}@${version}`;
  const override = metadataOverrides.get(key);
  const license = metadata.license ?? override?.license ?? null;
  const entry = {
    package: key,
    license,
    dev: Boolean(metadata.dev),
    metadataOverride: override?.evidence ?? null
  };
  packages.push(entry);
  if (!license || !allowed.has(license)) failures.push(entry);
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify({ packages, failures }, null, 2)}\n`);

if (failures.length) {
  console.error("NPM license gate failed. Review these packages:");
  for (const failure of failures) console.error(`- ${failure.package}: ${failure.license ?? "MISSING"}`);
  process.exit(1);
}

console.log(`PASS npm license gate (${packages.length} packages)`);
