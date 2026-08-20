import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseMacMinimumVersions(otoolOutput) {
  const versions = [];
  const lines = String(otoolOutput ?? "").split(/\r?\n/);
  let command = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const commandMatch = line.match(/^cmd\s+(LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX)$/);
    if (commandMatch) {
      command = commandMatch[1];
      continue;
    }
    if (command === "LC_BUILD_VERSION") {
      const match = line.match(/^minos\s+([0-9]+(?:\.[0-9]+){0,2})$/);
      if (match) {
        versions.push(match[1]);
        command = "";
      }
    } else if (command === "LC_VERSION_MIN_MACOSX") {
      const match = line.match(/^version\s+([0-9]+(?:\.[0-9]+){0,2})$/);
      if (match) {
        versions.push(match[1]);
        command = "";
      }
    }
  }

  return versions;
}

function versionParts(value) {
  return String(value).split(".").map(part => Number.parseInt(part, 10) || 0);
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length, 3);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export function assertCompatibleMinimumVersions(versions, maximum, label = "Mach-O") {
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(`${label}: no macOS minimum-version load command was found.`);
  }
  const tooNew = versions.filter(version => compareVersions(version, maximum) > 0);
  if (tooNew.length > 0) {
    throw new Error(`${label}: requires macOS ${tooNew.join(", ")}, newer than BeatGaler target ${maximum}.`);
  }
  return versions;
}

function main() {
  const [binaryPath, maximum = "12.0"] = process.argv.slice(2);
  if (!binaryPath) {
    throw new Error("Usage: node scripts/check-macos-min-version.mjs <Mach-O path> [maximum macOS version]");
  }
  if (process.platform !== "darwin") {
    throw new Error("Mach-O minimum-version inspection must run on macOS because it requires otool.");
  }
  const output = execFileSync("otool", ["-l", binaryPath], { encoding: "utf8" });
  const versions = assertCompatibleMinimumVersions(
    parseMacMinimumVersions(output),
    maximum,
    path.basename(binaryPath),
  );
  console.log(`PASS ${binaryPath} minimum macOS versions: ${versions.join(", ")} (target <= ${maximum})`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL macOS minimum-version check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
