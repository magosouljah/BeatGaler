import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, ".unit-build");
const localTsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

function fail(message) {
  console.error(`FAIL unit tests: ${message}`);
  process.exit(1);
}

rmSync(buildDir, { recursive: true, force: true });
try {
  const tscArgs = ["-p", path.join(root, "tests", "tsconfig.unit.json")];
  if (existsSync(localTsc)) {
    execFileSync(process.execPath, [localTsc, ...tscArgs], { cwd: root, stdio: "inherit" });
  } else {
    const command = process.platform === "win32" ? "tsc.cmd" : "tsc";
    try {
      execFileSync(command, tscArgs, { cwd: root, stdio: "inherit" });
    } catch {
      fail("TypeScript is not installed. Run npm install/npm ci first.");
    }
  }

  const tests = [
    "metadataValidation.test.js",
    "playbackReadiness.test.js",
    "beatRuntimeState.test.js",
    "dragDropLogic.test.js",
    "proceduralBeatBackground.test.js",
    "securityFuzz.test.js",
  ];

  for (const test of tests) {
    execFileSync(process.execPath, [path.join(buildDir, "tests", "unit", test)], {
      cwd: root,
      stdio: "inherit",
    });
  }
  const componentTests = ["componentLogic.test.js"];
  for (const test of componentTests) {
    execFileSync(process.execPath, [path.join(buildDir, "tests", "component", test)], {
      cwd: root,
      stdio: "inherit",
    });
  }
  console.log(`PASS unit tests: ${tests.length} suites`);
  console.log(`PASS component tests: ${componentTests.length} suite`);
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
