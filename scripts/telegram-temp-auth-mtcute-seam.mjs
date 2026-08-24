import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// M0-B0 only: verify the exact @mtcute 0.31.x seam BeatGaler can reuse for a
// split permanent-side/temp-side network probe. This does not connect to Telegram,
// does not read BeatGaler credentials and does not modify production runtime.

const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);

async function findPackageRoot(entryUrl, expectedName) {
  let current = path.dirname(fileURLToPath(entryUrl));
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = path.join(current, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name === expectedName) return { root: current, manifest };
    } catch {
      // Keep walking toward the package root.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate package root for ${expectedName}.`);
}

async function collectSources(root) {
  const out = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const info = await stat(full);
      if (info.size <= 0 || info.size > MAX_SCAN_BYTES) continue;
      out.push(full);
    }
  }
  return out;
}

async function findSourceContaining(files, requiredFragments) {
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (requiredFragments.every(fragment => text.includes(fragment))) {
      return { file, text };
    }
  }
  return null;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function main() {
  const webEntry = import.meta.resolve('@mtcute/web');
  const webPackage = await findPackageRoot(webEntry, '@mtcute/web');

  // Resolve @mtcute/core from the exact dependency graph owned by @mtcute/web,
  // rather than assuming npm hoisted it to the BeatGaler project root.
  const requireFromWeb = createRequire(pathToFileURL(path.join(webPackage.root, 'package.json')));
  const coreEntryPath = requireFromWeb.resolve('@mtcute/core');
  const corePackage = await findPackageRoot(pathToFileURL(coreEntryPath), '@mtcute/core');

  assert.match(String(webPackage.manifest.version), /^0\.31\./, 'BeatGaler M0-B seam was audited against @mtcute/web 0.31.x');
  assert.match(String(corePackage.manifest.version), /^0\.31\./, 'BeatGaler M0-B seam was audited against @mtcute/core 0.31.x');

  const files = await collectSources(corePackage.root);

  const pfs = await findSourceContaining(files, [
    'auth.bindTempAuthKey',
    'TEMP_AUTH_KEY_EXPIRY',
    'tempKey.encryptMessage',
    '_authKey.key',
    'onTmpKeyChange',
  ]);
  assert.ok(pfs, 'Could not locate mtcute PFS binding implementation in installed @mtcute/core.');

  const authorization = await findSourceContaining(files, [
    'p_q_inner_data_temp_dc',
    'expiresIn',
    'doAuthorization',
  ]);
  assert.ok(authorization, 'Could not locate mtcute temporary auth-key generation implementation.');

  // These are the exact properties M0-B needs to separate. The existing PFS
  // implementation already creates a temporary key and sends the bind request
  // under that key, but it also consumes the permanent key bytes locally to
  // build encrypted_message. Therefore simply enabling usePfs would NOT satisfy
  // Task 5.1; the permanent-side envelope construction must be delegated.
  assert.ok(pfs.text.includes('doAuthorization(this, this._crypto, TEMP_AUTH_KEY_EXPIRY)'));
  assert.ok(pfs.text.includes("_: 'auth.bindTempAuthKey'"));
  assert.ok(pfs.text.includes('this._session._authKey.key'));
  assert.ok(pfs.text.includes('tempKey.encryptMessage'));
  assert.ok(pfs.text.includes('TEMP_AUTH_KEY_REFRESH_MARGIN'));
  assert.ok(pfs.text.includes('this._authorizePfs(true)'));
  assert.ok(authorization.text.includes("expiresIn ? 'mt_p_q_inner_data_temp_dc'"));

  const summary = {
    mode: 'M0-B0 mtcute seam audit only',
    mtcute_web: webPackage.manifest.version,
    mtcute_core: corePackage.manifest.version,
    temp_key_generation_present: true,
    bind_sent_with_temp_key_present: true,
    permanent_key_bytes_used_by_stock_pfs: true,
    rolling_refresh_present: true,
    stock_use_pfs_satisfies_task_5_1: false,
    permanent_auth_reaches_client_in_target: false,
    galer_file_bytes: false,
    network_bind_proven: false,
    direct_mtproto_operation_proven: false,
    pfs_source: relative(corePackage.root, pfs.file),
    authorization_source: relative(corePackage.root, authorization.file),
    next_gate: 'M0-B1: run split bind with separately generated permanent and temporary auth keys; client submits auth.bindTempAuthKey directly to Telegram.',
  };

  console.log('PASS M0-B0 mtcute seam: temp-key generation/send/refresh exist, but stock PFS still consumes permanent key bytes client-side');
  console.log(JSON.stringify(summary));
}

await main();
