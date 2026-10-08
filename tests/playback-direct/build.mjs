import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const webRoot = path.dirname(require.resolve('@mtcute/web'));
const coreRoot = path.dirname(createRequire(path.join(webRoot, 'package.json')).resolve('@mtcute/core'));

// Only adapt Vite asset/alias loading. Production worker, scheduler and mtcute
// are compiled unchanged; no mock network, replacement cache or retry policy.
export async function buildHarness(outdir) {
  await fs.mkdir(outdir, { recursive: true });
  await build({
    entryPoints: {
      worker: path.join(root, 'tests/playback-direct/worker.mjs'),
      auth: path.join(root, 'src/features/cloud/webTempAuth.ts'),
      mp3: path.join(root, 'src/features/audio/mp3PlayablePrefix.ts'),
    }, outdir, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    alias: {
      __beatgaler_mtcute_utils__: path.join(coreRoot, 'utils.js'),
      __beatgaler_mtcute_authorization__: path.join(coreRoot, 'network/authorization.js'),
    },
    outExtension: { '.js': '.mjs' },
    plugins: [{ name: 'local-wasm', setup(b) {
      b.onResolve({ filter: /mtcute\.wasm\?url$/ }, () => ({ path: 'wasm', namespace: 'harness' }));
      b.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
        contents: `import { readFileSync } from 'node:fs'; export default 'data:application/wasm;base64,' + readFileSync(${JSON.stringify(require.resolve('@mtcute/wasm/mtcute.wasm'))}).toString('base64');`,
        loader: 'js',
      }));
    } }],
  });
}
