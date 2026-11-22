// Selecciona un caso del humo V1. Cada sonda conserva sus mediciones y artefactos.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cases = new Map([
  ['smoke', 'probe-smoke-v1.mjs'],
  ['account-billing', 'probe-account-billing.mjs'],
  ['add-beat', 'probe-add-beat.mjs'],
  ['artwork-remove', 'probe-artwork-remove.mjs'],
  ['audit', 'probe-audit.mjs'],
  ['chrome-geometry', 'probe-chrome-geometry.mjs'],
  ['drop-beat', 'probe-drop-beat.mjs'],
  ['drop-visuals', 'probe-drop-visuals.mjs'],
  ['e79', 'probe-e79.mjs'],
  ['e80', 'probe-e80.mjs'],
  ['e86-import', 'probe-e86-import.mjs'],
  ['first-block-cases', 'probe-first-block-cases.mjs'],
  ['first-card', 'probe-first-card.mjs'],
  ['first-play', 'probe-first-play.mjs'],
  ['mse-stream', 'probe-mse-stream.mjs'],
  ['section61', 'probe-section61.mjs'],
  ['startup-profile', 'probe-startup-profile.mjs'],
  ['url', 'probe-url.mjs'],
  ['v09', 'v09-run.mjs'],
  ['v10', 'v10-browser.mjs'],
]);

const [id = 'smoke', ...args] = process.argv.slice(2);
if (id === '--list' && args.length === 0) {
  for (const [name, file] of cases) console.log(`${name}\t${file}`);
} else if (!cases.has(id)) {
  console.error('Caso desconocido. Uso: node scripts/catalog-lab/run-smoke-v1.mjs [--list | caso [opciones]]');
  process.exitCode = 2;
} else {
  try {
    for (const [index, arg] of args.entries()) {
      if (arg !== '--base') continue;
      const base = new URL(args[index + 1]);
      if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') {
        throw new Error('--base debe apuntar al preview local del LAB (http://127.0.0.1)');
      }
    }
    const { requireFakeLab, localChromeOptions } = await import('./browser-common.mjs');
    await requireFakeLab();
    localChromeOptions();
    const script = fileURLToPath(new URL(cases.get(id), import.meta.url));
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, CATALOG_LAB_SMOKE_CASE: '1' },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Proceso terminado por ${result.signal}`);
    process.exitCode = result.status;
  } catch (error) {
    console.error(`HUMO V1 ${id} FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
