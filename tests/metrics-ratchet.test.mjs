import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareBaselines } from '../scripts/metrics/ratchet.mjs';

const originalGuard = 'tests/original.test.mjs';
const nextGuard = 'tests/new-text.test.mjs';
const baseline = { metrics: { P1: 2, S1: 3, CY: 1, CYF: 9, 'F+M': 1 }, sourceTextTests: [originalGuard] };

function runRatchet(t, {
  p1 = 2, cycles = [1, 9], extraRows = [], files = [['F', originalGuard]], allowlist = [], flags = [], baselineExtra = {},
} = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'metrics-ratchet-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dir = path.join(repo, 'scripts', 'metrics');
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'ratchet.mjs');
  copyFileSync(new URL('../scripts/metrics/ratchet.mjs', import.meta.url), script);
  const write = (name, content) => writeFileSync(path.join(dir, name), content);
  write('ratchet-baseline.json', JSON.stringify({ ...baseline, metrics: { ...baseline.metrics, ...baselineExtra } }));
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
  const fileTsv = files.map(([kind, file, subject]) => [kind, file, '1', '', ...(subject ? [subject] : [])].join('\t')).join('\n');
  write('metrics.mjs', `console.log(${JSON.stringify(metrics)});\n`);
  write('src-reach.mjs', `console.log(${JSON.stringify(`HEAD fixture
import cycles (SCC size>1) in src runtime graph: ${cycles[0]}  files inside cycles: ${cycles[1]}  largest: 9`)});
`);
  write('classify-tests.mjs', `console.log(process.argv[3] === 'summary'
    ? ${JSON.stringify(summary)} : ${JSON.stringify(fileTsv)});\n`);
  const result = spawnSync(process.execPath, [script, repo, ...flags], { encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('acepta métricas iguales e ignora el conteo informativo C4', t => {
  const result = runRatchet(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS trinquete: 7 métricas, 1 pruebas F\/M/);
});

test('bloquea y nombra cada métrica que sube', t => {
  const result = runRatchet(t, { p1: 3, files: [['F', originalGuard], ['M', nextGuard]], allowlist: [nextGuard] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /P1 sube de 2 a 3/);
  assert.match(result.stderr, /F\+M sube de 1 a 2/);
});

test('bloquea un ciclo de importación nuevo (métrica 7)', t => {
  const result = runRatchet(t, { cycles: [2, 11] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CY sube de 1 a 2/);
  assert.match(result.stderr, /CYF sube de 9 a 11/);
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
  const previous = { metrics: { P1: 2, S1: 3, 'F+M': 1 }, sourceTextTests: new Set(baseline.sourceTextTests) };
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

test('F+M:v1 y F+M:desktop se miden aparte; sin 5.ª columna cuenta como v1', t => {
  const withKeys = { files: [['F', originalGuard, 'desktop']], baselineExtra: { 'F+M:v1': 0, 'F+M:desktop': 1 } };
  const ok = runRatchet(t, withKeys);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /v1 0, desktop 1/);
  const fail = runRatchet(t, { files: [['F', originalGuard]], baselineExtra: { 'F+M:v1': 0, 'F+M:desktop': 1 } });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /F\+M:v1 sube de 0 a 1/);
});

test('un baseline anterior sin las claves por sujeto permite la primera instalación', () => {
  const previous = { ...baseline, sourceTextTests: new Set(baseline.sourceTextTests) };
  const current = { metrics: { ...baseline.metrics, 'F+M:v1': 1, 'F+M:desktop': 0 }, sourceTextTests: new Set(baseline.sourceTextTests) };
  assert.deepEqual(compareBaselines(current, previous), []);
});

test('etiqueta por sujeto: solo-Desktop => desktop; módulo V1 o indeterminado => v1', t => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'metrics-subject-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  put('src/main.tsx', "import './app/WebExperience';\nimport './app/DesktopExperience';\n");
  put('src/app/WebExperience.tsx', "import '../web';\n");
  put('src/app/DesktopExperience.tsx', "import '../desk';\n");
  put('src/web.ts', 'export const a = 1;\n');
  put('src/desk.ts', 'export const b = 1;\n');
  const fn = ['read', 'FileSync'].join(''); // evita que esta prueba se clasifique como lectura de texto
  const reader = lit => `import { ${fn} } from 'node:fs';\nconst s = ${fn}(${lit}, 'utf8');\n`;
  put('tests/integration/onlyDesktop.test.ts', reader('"src/desk.ts"'));
  put('tests/integration/readsV1.test.ts', reader('"src/web.ts"'));
  put('tests/integration/mixed.test.ts', reader('"src/desk.ts"') + reader('"src/web.ts"'));
  put('tests/integration/unknown.test.ts', reader('"src/desk.ts"') + reader('join(here, "mystery.ts")'));
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  const run = spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/metrics/classify-tests.mjs', import.meta.url)), repo, 'files',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const subject = Object.fromEntries(run.stdout.trim().split(/\r?\n/).map(l => l.split('\t'))
    .map(c => [path.basename(c[1]), c[4]]));
  assert.deepEqual(subject, {
    'onlyDesktop.test.ts': 'desktop',
    'readsV1.test.ts': 'v1',
    'mixed.test.ts': 'v1',
    'unknown.test.ts': 'v1',
  });
});
