import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const series = [
  ['d1', 'd1-final'],
  ['d2-warm', 'd2-warm-final'],
  ['d2-warm-repeat', 'd2-warm-repeat'],
  ['d3-warm', 'd3-warm-final'],
  ['d3-warm-repeat', 'd3-warm-repeat'],
  ['d2-raw-a', 'd2-raw-final'],
  ['d2-raw-b', 'd2-raw-replenish-50'],
  ['d3-raw', 'd3-raw-final'],
  ['d4-101-first-0', 'd4-101-first-0'],
  ['d4-96-first-0-gated', 'd4-96-first-0-gated-12'],
  ['d4-96-first-10', 'd4-96-first-10'],
  ['d4-101-first-10', 'd4-101-first-10'],
  ['d4-96-first-50', 'd4-96-first-50'],
  ['d4-101-first-50', 'd4-101-first-50'],
  ['d4-96-first-100', 'd4-96-first-100'],
  ['d4-101-first-100', 'd4-101-first-100'],
  ['d4-101-first-coalesced', 'd4-101-first-coalesced-20'],
  ['d4-sequential', 'd4-sequential-96-then-101'],
];
const arg = series.map(([name, dir]) => `${name}=${path.join(root, 'tmp/playback-d', dir)}`).join(',');
const result = spawnSync(process.execPath, [path.join(here, 'report.mjs'), '--series', arg,
  '--out', here], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
