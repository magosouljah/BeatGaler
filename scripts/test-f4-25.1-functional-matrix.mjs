import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const matrixPath = path.join(root, 'release', 'f4-25.1-functional-matrix.json');
const pkgPath = path.join(root, 'package.json');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const requiredPlatforms = ['web-browsers', 'windows', 'macos', 'iphone'];
const requiredJourneys = ['auth', 'import', 'review', 'playback', 'edit', 'trash', 'offline', 'youtube', 'updater', 'billing'];
const allowed = new Set(['AUTOMATED_PASS', 'PENDING_EXTERNAL', 'PRODUCT_FINDING', 'NOT_COVERED']);

if (matrix.schema !== 'beatgaler-f4-25.1-matrix-v1') throw new Error('Unexpected matrix schema.');
if (!Array.isArray(matrix.matrix)) throw new Error('matrix must be an array.');

const seen = new Set();
for (const row of matrix.matrix) {
  const key = `${row.platform}:${row.journey}`;
  if (seen.has(key)) throw new Error(`Duplicate matrix row: ${key}`);
  seen.add(key);
  if (!allowed.has(row.status)) throw new Error(`Invalid status for ${key}: ${row.status}`);
  if (!row.reason || typeof row.reason !== 'string') throw new Error(`Missing reason for ${key}`);
  if (!Array.isArray(row.evidence)) throw new Error(`Evidence must be an array for ${key}`);
  for (const evidenceKey of row.evidence) {
    if (!matrix.evidenceCatalog[evidenceKey]) throw new Error(`Unknown evidence key ${evidenceKey} in ${key}`);
  }
  if (row.status === 'AUTOMATED_PASS' && row.evidence.length === 0) {
    throw new Error(`AUTOMATED_PASS requires evidence for ${key}`);
  }
}

for (const platform of requiredPlatforms) {
  for (const journey of requiredJourneys) {
    const key = `${platform}:${journey}`;
    if (!seen.has(key)) throw new Error(`Missing required matrix row: ${key}`);
  }
}

for (const [name, refs] of Object.entries(matrix.evidenceCatalog)) {
  if (!Array.isArray(refs) || refs.length === 0) throw new Error(`Evidence catalog entry ${name} is empty.`);
  for (const ref of refs) {
    if (ref.startsWith('package.json#')) {
      const scriptName = ref.slice('package.json#'.length);
      if (!pkg.scripts?.[scriptName]) throw new Error(`Missing package script referenced by evidence: ${scriptName}`);
    } else if (!ref.startsWith('PR#') && !ref.startsWith('Test - ')) {
      const candidate = path.join(root, ref);
      if (!fs.existsSync(candidate)) throw new Error(`Missing evidence path: ${ref}`);
    }
  }
}

const counts = matrix.matrix.reduce((acc, row) => {
  acc[row.status] = (acc[row.status] || 0) + 1;
  return acc;
}, {});

console.log(JSON.stringify({
  schema: matrix.schema,
  baseline: matrix.baseline,
  rows: matrix.matrix.length,
  counts,
  requiredPlatforms,
  requiredJourneys
}, null, 2));
