import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const checks = [
  ["01-typecheck", "npm run test:typecheck"],
  ["02-unit-ts", "npm run test:unit:ts"],
  ["03-component-dom", "npm run test:component:dom"],
  ["04-integration", "npm run test:integration"],
  ["05-regressions", "npm run test:regressions"],
  ["06-build-web", "npm run build:web"],
  ["07-build", "npm run build"],
];

const outputDir = path.resolve("artifacts", "migration-check-logs");
await mkdir(outputDir, { recursive: true });

const results = [];

function runCheck(name, command) {
  return new Promise((resolve) => {
    const chunks = [];
    const header = `\n===== ${name}: ${command} =====\n`;
    process.stdout.write(header);
    chunks.push(header);

    const child = spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      chunks.push(chunk);
    });

    child.on("error", (error) => {
      const message = `\n[runner error] ${error.stack ?? error.message}\n`;
      process.stderr.write(message);
      chunks.push(message);
    });

    child.on("close", async (code, signal) => {
      const exitCode = Number.isInteger(code) ? code : 1;
      const footer = `\n===== RESULT: ${exitCode === 0 ? "PASS" : "FAIL"}; exit=${exitCode}; signal=${signal ?? "none"} =====\n`;
      process.stdout.write(footer);
      chunks.push(footer);
      await writeFile(path.join(outputDir, `${name}.log`), Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))));
      resolve({ name, command, exitCode, signal: signal ?? null });
    });
  });
}

for (const [name, command] of checks) {
  // Run every check even if an earlier one fails so the artifact contains the full picture.
  results.push(await runCheck(name, command));
}

const failed = results.filter((result) => result.exitCode !== 0);
const summary = [
  `Migration checks: ${failed.length === 0 ? "PASS" : "FAIL"}`,
  "",
  ...results.map((result) => `${result.exitCode === 0 ? "PASS" : "FAIL"}  ${result.name}  ${result.command}`),
  "",
  failed.length === 0
    ? "All checks passed."
    : `Failed checks: ${failed.map((result) => result.name).join(", ")}`,
  "",
].join("\n");

await writeFile(path.join(outputDir, "summary.txt"), summary, "utf8");
process.stdout.write(`\n${summary}`);

if (failed.length > 0) {
  process.exitCode = 1;
}
