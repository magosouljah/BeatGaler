import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function take(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`Missing ${flag}`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

const output = take("--output");
const platform = take("--platform");
const sourceManifestPath = take("--sources");
const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
const files = [];

for (const item of args) {
  const separator = item.indexOf("=");
  if (separator <= 0) throw new Error(`Expected name=path, received ${item}`);
  const name = item.slice(0, separator);
  const filePath = item.slice(separator + 1);
  const bytes = fs.readFileSync(filePath);
  files.push({
    name,
    path: filePath.replaceAll("\\", "/"),
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex")
  });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  gitSha: process.env.GITHUB_SHA ?? null,
  platform,
  sources: sourceManifest,
  files
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
for (const file of files) console.log(`${file.sha256}  ${file.name}`);
