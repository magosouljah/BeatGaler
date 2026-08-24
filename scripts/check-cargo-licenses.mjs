import fs from "node:fs";
import path from "node:path";

const metadataPath = path.resolve(process.argv[2] ?? "artifacts/supply-chain/cargo-metadata.json");
const reportPath = path.resolve("artifacts/supply-chain/cargo-licenses.json");
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

const allowedIds = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "ISC",
  "LLVM-exception",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OpenSSL",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "Zlib"
]);

function identifiers(expression) {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !["AND", "OR", "WITH"].includes(token));
}

const packages = [];
const failures = [];
for (const pkg of metadata.packages ?? []) {
  // The BeatGaler workspace package itself is governed by the product's own
  // release/legal gate; this scanner is for third-party Cargo dependencies.
  if (pkg.source == null) continue;
  const license = pkg.license ?? null;
  const ids = license ? identifiers(license) : [];
  const unknownIds = ids.filter((id) => !allowedIds.has(id));
  const entry = {
    package: `${pkg.name}@${pkg.version}`,
    source: pkg.source,
    license,
    unknownIds
  };
  packages.push(entry);
  if (!license || unknownIds.length) failures.push(entry);
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify({ packages, failures }, null, 2)}\n`);

if (failures.length) {
  console.error("Cargo license gate failed. Review these packages:");
  for (const failure of failures) {
    console.error(`- ${failure.package}: ${failure.license ?? "MISSING"}${failure.unknownIds.length ? ` [unknown: ${failure.unknownIds.join(", ")}]` : ""}`);
  }
  process.exit(1);
}

console.log(`PASS Cargo license gate (${packages.length} third-party packages)`);
