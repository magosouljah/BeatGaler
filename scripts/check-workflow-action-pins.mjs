import fs from "node:fs";
import path from "node:path";

const workflowsDir = path.resolve(".github/workflows");
const files = fs.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/i.test(name)).sort();
const failures = [];
const uses = [];

for (const file of files) {
  const fullPath = path.join(workflowsDir, file);
  const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
    if (!match) return;
    const value = match[1];
    if (value.startsWith("./")) return;
    uses.push({ file, line: index + 1, uses: value });
    if (!/@[0-9a-f]{40}$/i.test(value)) {
      failures.push({ file, line: index + 1, uses: value });
    }
  });
}

fs.mkdirSync("artifacts/supply-chain", { recursive: true });
fs.writeFileSync(
  "artifacts/supply-chain/workflow-action-pins.json",
  `${JSON.stringify({ uses, failures }, null, 2)}\n`
);

if (failures.length) {
  console.error("Mutable GitHub Action references found:");
  for (const failure of failures) console.error(`- ${failure.file}:${failure.line} ${failure.uses}`);
  process.exit(1);
}

console.log(`PASS workflow action pin gate (${uses.length} external action references)`);
