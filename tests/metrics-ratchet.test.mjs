import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareBaselines } from '../scripts/metrics/ratchet.mjs';

const originalGuard = 'tests/original.test.mjs';
const nextGuard = 'tests/new-text.test.mjs';
const baseline = { metrics: { P1: 2, S1: 3, 'F+M': 1 }, sourceTextTests: [originalGuard] };

function runRatchet(t, {
  p1 = 2, extraRows = [], files = [['F', originalGuard]], allowlist = [], flags = [],
} = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'metrics-ratchet-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dir = path.join(repo, 'scripts', 'metrics');
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'ratchet.mjs');
  copyFileSync(new URL('../scripts/metrics/ratchet.mjs', import.meta.url), script);
  const write = (name, content) => writeFileSync(path.join(dir, name), content);
  write('ratchet-baseline.json', JSON.stringify(baseline));
  write('static-guards.allowlist.txt', allowlist.join('\n'));
  const metrics = [
    'HEAD fixture', 'metric\tvalue\tdetail',
    `P1 Express patches\t${p1}\t`, 'S1 Singletons\t3\t', 'C4 total\t999\t', ...extraRows,
  ].join('\n');
  const f = files.filter(([kind]) => kind === 'F').length;
  const m = files.filter(([kind]) => kind === 'M').length;
  const summary = [
    'HEAD fixture', 'directory\tfiles\tC_behaviour\tF_source_text\tM_mixed\tO_other',
    `TOTAL\t${f + m}\t0\t${f}\t${m}\t0`,
  ].join('\n');
  const fileTsv = files.map(([kind, file]) => [kind, file, '1', ''].join('\t')).join('\n');
  write('metrics.mjs', `console.log(${JSON.stringify(metrics)});\n`);
  write('classify-tests.mjs', `console.log(process.argv[3] === 'summary'
    ? ${JSON.stringify(summary)} : ${JSON.stringify(fileTsv)});\n`);
  const result = spawnSync(process.execPath, [script, repo, ...flags], { encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('acepta métricas iguales e ignora el conteo informativo C4', t => {
  const result = runRatchet(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS trinquete: 3 métricas, 1 pruebas F\/M/);
});

test('bloquea y nombra cada métrica que sube', t => {
  const result = runRatchet(t, { p1: 3, files: [['F', originalGuard], ['M', nextGuard]], allowlist: [nextGuard] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /P1 sube de 2 a 3/);
  assert.match(result.stderr, /F\+M sube de 1 a 2/);
});

test('acepta una mejora con aviso', t => {
  const result = runRatchet(t, { p1: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /P1 baja de 2 a 1: actualiza el baseline/);
});

test('una mejora bloquea con --strict-improve', t => {
  const result = runRatchet(t, { p1: 1, flags: ['--strict-improve'] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /P1 baja de 2 a 1: actualiza el baseline/);
});

test('bloquea y nombra una métrica nueva sin umbral', t => {
  const result = runRatchet(t, { extraRows: ['N1 métrica nueva\t99\t'] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Métrica sin baseline: N1 métrica nueva/);
});

for (const kind of ['F', 'M']) {
  test(`bloquea un archivo ${kind} nuevo aunque el conteo literal no suba`, t => {
    const result = runRatchet(t, { files: [[kind, nextGuard]] });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Prueba de texto nueva (F/M) fuera de la lista: ${nextGuard}`));
  });
}

test('acepta una excepción nominal si F+M queda dentro del umbral', t => {
  const result = runRatchet(t, { files: [['M', nextGuard]], allowlist: [nextGuard] });
  assert.equal(result.status, 0, result.stderr);
});

test('protege umbrales y rutas iniciales del baseline histórico', () => {
  const previous = { ...baseline, sourceTextTests: new Set(baseline.sourceTextTests) };
  const current = { metrics: { P1: 3, 'F+M': 0 }, sourceTextTests: new Set([nextGuard]) };
  assert.deepEqual(compareBaselines(current, previous), [
    'Baseline: P1 sube de 2 a 3',
    'Baseline: falta el umbral anterior de S1',
    `Baseline: archivo nuevo en el conjunto base de pruebas de texto: ${nextGuard}`,
  ]);
});

test('permite bajar umbrales y retirar rutas del baseline histórico', () => {
  const previous = { ...baseline, sourceTextTests: new Set(baseline.sourceTextTests) };
  const current = { metrics: { ...baseline.metrics, P1: 1, 'F+M': 0 }, sourceTextTests: new Set() };
  assert.deepEqual(compareBaselines(current, previous), []);
});
