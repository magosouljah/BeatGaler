import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const omitted = (process.env.npm_config_omit ?? '').split(/[\s,]+/);
const patchPackage = join(process.cwd(), 'node_modules', 'patch-package', 'index.js');

if (omitted.includes('dev')) {
  console.log('Skipping build-time dependency patches for production-only install.');
  process.exit(0);
}

if (!existsSync(patchPackage)) {
  console.error('patch-package is required for a full install.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [patchPackage], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
