import fs from 'node:fs';
import path from 'node:path';

const lockPath = path.resolve(process.argv[2] || 'cloud-server/package-lock.json');
const reportPath = path.resolve(process.argv[3] || 'artifacts/supply-chain/postgres-npm-licenses.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const packages = lock.packages || {};

const allowed = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MIT', 'MIT-0', 'Unlicense',
]);
const rootNames = ['pg', '@aws-sdk/client-secrets-manager'];

function resolveDependency(parentPath, name) {
  let current = parentPath;
  while (true) {
    const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const marker = current.lastIndexOf('/node_modules/');
    if (marker < 0) break;
    current = current.slice(0, marker);
  }
  const root = `node_modules/${name}`;
  return packages[root] ? root : null;
}

const roots = rootNames.map(name => `node_modules/${name}`);
for (let index = 0; index < roots.length; index += 1) {
  if (!packages[roots[index]]) throw new Error(`${rootNames[index]} is not present in the cloud-server lockfile.`);
}

const queue = [...roots];
const visited = new Set();
const report = [];
const failures = [];
while (queue.length) {
  const packagePath = queue.shift();
  if (visited.has(packagePath)) continue;
  visited.add(packagePath);
  const metadata = packages[packagePath];
  const name = packagePath.split('/node_modules/').at(-1).replace(/^node_modules\//, '');
  const entry = { package: `${name}@${metadata.version || 'unknown'}`, license: metadata.license || null, path: packagePath };
  report.push(entry);
  if (!entry.license || !allowed.has(entry.license)) failures.push(entry);
  const dependencies = { ...(metadata.dependencies || {}), ...(metadata.optionalDependencies || {}) };
  for (const depName of Object.keys(dependencies)) {
    const child = resolveDependency(packagePath, depName);
    if (child) queue.push(child);
  }
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify({ roots: rootNames, packages: report, failures }, null, 2)}\n`);
if (failures.length) {
  console.error('PostgreSQL/AWS npm license gate failed:');
  for (const failure of failures) console.error(`- ${failure.package}: ${failure.license || 'MISSING'}`);
  process.exit(1);
}
console.log(`PASS PostgreSQL/AWS npm license gate (${report.length} packages)`);
