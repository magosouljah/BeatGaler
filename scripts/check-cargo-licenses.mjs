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
  "CDLA-Permissive-2.0",
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

function tokenize(expression) {
  // Cargo metadata still contains legacy dual-license expressions such as
  // MIT/Apache-2.0. Cargo historically used `/` with OR semantics, so
  // normalize those before evaluating the SPDX-style expression.
  return expression
    .replace(/\//g, " OR ")
    .replace(/([()])/g, " $1 ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function evaluateLicenseExpression(expression) {
  const tokens = tokenize(expression);
  let cursor = 0;
  const seenIds = new Set();

  function peek() {
    return tokens[cursor] ?? null;
  }

  function take(expected) {
    const token = peek();
    if (expected && token !== expected) {
      throw new Error(`Expected ${expected}, found ${token ?? "end of expression"}`);
    }
    cursor += 1;
    return token;
  }

  function parsePrimary() {
    if (peek() === "(") {
      take("(");
      const value = parseOr();
      take(")");
      return value;
    }

    const id = take();
    if (!id || ["AND", "OR", "WITH", ")"].includes(id)) {
      throw new Error(`Expected license identifier, found ${id ?? "end of expression"}`);
    }
    seenIds.add(id);
    let value = allowedIds.has(id);

    if (peek() === "WITH") {
      take("WITH");
      const exceptionId = take();
      if (!exceptionId || ["AND", "OR", "WITH", "(", ")"].includes(exceptionId)) {
        throw new Error(`Expected license exception after WITH, found ${exceptionId ?? "end of expression"}`);
      }
      seenIds.add(exceptionId);
      value = value && allowedIds.has(exceptionId);
    }

    return value;
  }

  function parseAnd() {
    let value = parsePrimary();
    while (peek() === "AND") {
      take("AND");
      // Do not short-circuit parsing: every token still needs validation.
      const rhs = parsePrimary();
      value = value && rhs;
    }
    return value;
  }

  function parseOr() {
    let value = parseAnd();
    while (peek() === "OR") {
      take("OR");
      // An OR expression is acceptable when at least one complete branch is
      // made only from licenses/exceptions that BeatGaler explicitly allows.
      const rhs = parseAnd();
      value = value || rhs;
    }
    return value;
  }

  const allowed = parseOr();
  if (cursor !== tokens.length) {
    throw new Error(`Unexpected token ${tokens[cursor]}`);
  }

  return {
    allowed,
    identifiers: [...seenIds],
    unknownIds: [...seenIds].filter((id) => !allowedIds.has(id))
  };
}

const packages = [];
const failures = [];
for (const pkg of metadata.packages ?? []) {
  // The BeatGaler workspace package itself is governed by the product's own
  // release/legal gate; this scanner is for third-party Cargo dependencies.
  if (pkg.source == null) continue;

  const license = pkg.license ?? null;
  let evaluation = {
    allowed: false,
    identifiers: [],
    unknownIds: [],
    parseError: null
  };

  if (license) {
    try {
      evaluation = { ...evaluateLicenseExpression(license), parseError: null };
    } catch (error) {
      evaluation.parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const entry = {
    package: `${pkg.name}@${pkg.version}`,
    source: pkg.source,
    license,
    allowed: evaluation.allowed,
    identifiers: evaluation.identifiers,
    unknownIds: evaluation.unknownIds,
    parseError: evaluation.parseError
  };
  packages.push(entry);
  if (!license || !evaluation.allowed || evaluation.parseError) failures.push(entry);
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(
  reportPath,
  `${JSON.stringify({ allowedIds: [...allowedIds].sort(), packages, failures }, null, 2)}\n`
);

if (failures.length) {
  console.error("Cargo license gate failed. Review these packages:");
  for (const failure of failures) {
    const details = [];
    if (failure.unknownIds.length) details.push(`unapproved alternatives: ${failure.unknownIds.join(", ")}`);
    if (failure.parseError) details.push(`parse error: ${failure.parseError}`);
    console.error(`- ${failure.package}: ${failure.license ?? "MISSING"}${details.length ? ` [${details.join("; ")}]` : ""}`);
  }
  process.exit(1);
}

console.log(`PASS Cargo license gate (${packages.length} third-party packages)`);
