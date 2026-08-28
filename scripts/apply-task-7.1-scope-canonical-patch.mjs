import fs from 'node:fs';

const file = 'cloud-server/direct-capability-boundary.js';
const source = fs.readFileSync(file, 'utf8');
if (source.includes('function canonicalScope(value)')) {
  console.log('Canonical scope comparison already applied.');
  process.exit(0);
}
const from = `function sameScope(left, right) {\n  return JSON.stringify(left || null) === JSON.stringify(right || null);\n}\n`;
const to = `function canonicalScope(value) {\n  if (!value || typeof value !== "object" || Array.isArray(value)) return null;\n  const objectType = String(value.object_type || value.objectType || "").trim().toLowerCase();\n  const rawIds = Array.isArray(value.object_ids || value.objectIds) ? (value.object_ids || value.objectIds) : [];\n  return {\n    object_type: objectType,\n    object_ids: [...new Set(rawIds.map(item => String(item ?? "").trim()).filter(Boolean))].sort(),\n  };\n}\n\nfunction sameScope(left, right) {\n  return JSON.stringify(canonicalScope(left)) === JSON.stringify(canonicalScope(right));\n}\n`;
const first = source.indexOf(from);
if (first < 0) throw new Error('sameScope block not found.');
if (source.indexOf(from, first + from.length) >= 0) throw new Error('sameScope block is not unique.');
fs.writeFileSync(file, source.slice(0, first) + to + source.slice(first + from.length), 'utf8');
console.log('Applied canonical Direct capability scope comparison.');
