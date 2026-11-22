import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const baselinePath = 'scripts/metrics/ratchet-baseline.json';
const allowlistPath = 'scripts/metrics/static-guards.allowlist.txt';
const textMetric = 'F+M';
const metricHeader = 'metric\tvalue\tdetail';
const summaryHeader = 'directory\tfiles\tC_behaviour\tF_source_text\tM_mixed\tO_other';
const informationalIds = new Set([
  'P1b', 'P1c', 'H5', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'R1', 'O1', 'O2',
]);
const informationalRows = new Set([
  'T  local definitions of sqlError in cloud-server/catalog',
  'T  local definitions of mutationTx in cloud-server/catalog',
  'T  local definitions of readTx in cloud-server/catalog',
  'Z  src: files / lines',
  'Z  src: top 15',
  'Z  cloud prod JS: files / lines',
  'Z  cloud prod JS: top 15',
  'T12 A  POST /auth/login (Web form -> session)',
  "T12 B  Edit a beat's metadata (Drawer Save -> SQL UPDATE)",
  'T12 C  Upload a beat (Add beat -> Direct B -> worker commit)',
]);
const transactionTokens = 'T  literal BEGIN/COMMIT/ROLLBACK tokens in cloud-server/catalog';

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseCount(raw, label) {
  if (/^\d+$/.test(raw) && isCount(Number(raw))) return Number(raw);
  throw new Error(`Valor de métrica inválido para ${label}: ${raw}`);
}

function tsvRows(tsv, header) {
  const lines = tsv.trimEnd().split(/\r?\n/);
  if (lines.shift()?.startsWith('HEAD ') && lines.shift() === header) return lines;
  throw new Error(`Cabecera TSV inválida. Se esperaba ${header}`);
}

function textTestPaths(paths, label) {
  if (!Array.isArray(paths) || paths.some(file => typeof file !== 'string'
    || !/^(?:tests|cloud-server\/tests|scripts)\/[^\\\t\r\n]+$/.test(file)
    || file.split('/').some(segment => segment === '.' || segment === '..' || segment === 'helpers' || !segment))) {
    throw new Error(`${label}: se esperan rutas nominales de archivos de prueba`);
  }
  const unique = new Set(paths);
  if (unique.size !== paths.length) throw new Error(`${label}: rutas duplicadas`);
  return unique;
}

function parseBaseline(json) {
  const { metrics, sourceTextTests } = JSON.parse(json);
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)
    || !Object.hasOwn(metrics, textMetric) || Object.values(metrics).some(value => !isCount(value))) {
    throw new Error(`${baselinePath}: se esperan umbrales enteros, incluido ${textMetric}`);
  }
  return { metrics, sourceTextTests: textTestPaths(sourceTextTests, baselinePath) };
}

export function compareBaselines(current, previous) {
  const errors = [];
  for (const [metric, limit] of Object.entries(previous.metrics)) {
    if (!Object.hasOwn(current.metrics, metric)) {
      errors.push(`Baseline: falta el umbral anterior de ${metric}`);
    } else if (current.metrics[metric] > limit) {
      errors.push(`Baseline: ${metric} sube de ${limit} a ${current.metrics[metric]}`);
    }
  }
  for (const file of current.sourceTextTests) {
    if (!previous.sourceTextTests.has(file)) {
      errors.push(`Baseline: archivo nuevo en el conjunto base de pruebas de texto: ${file}`);
    }
  }
  return errors;
}

function readPreviousBaseline(repo, ref) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  if (!git('ls-tree', commit, '--', baselinePath).trim()) {
    if (git('ls-tree', commit, '--', 'scripts/metrics/ratchet.mjs').trim()) {
      throw new Error(`Falta el baseline en ${ref}, que ya contiene el trinquete`);
    }
    console.log(`Baseline inicial: ${ref} es anterior al trinquete`);
    return;
  }
  return parseBaseline(git('show', `${commit}:${baselinePath}`));
}

function readMetrics(tsv, limits, errors) {
  const measured = new Map();
  for (const row of tsvRows(tsv, metricHeader)) {
    const [label, value] = row.split('\t');
    const id = label.split(' ', 1)[0];
    if (informationalIds.has(id) || informationalRows.has(label)) continue;
    const key = label === transactionTokens ? 'T' : id === 'T' ? label : id;
    if (key === textMetric || !Object.hasOwn(limits, key)) {
      errors.push(`Métrica sin baseline: ${label}`);
    } else if (measured.has(key)) {
      errors.push(`Métrica duplicada: ${label}`);
    } else {
      measured.set(key, parseCount(value, label));
    }
  }
  return measured;
}

function readTextTests(summary, files) {
  const [total, , , rawF, rawM] = tsvRows(summary, summaryHeader).at(-1).split('\t');
  if (total !== 'TOTAL') throw new Error('Falta la fila TOTAL del clasificador de pruebas');
  const counts = { F: parseCount(rawF, 'F'), M: parseCount(rawM, 'M') };
  const rows = files.trimEnd().split(/\r?\n/).map(line => line.split('\t'));
  const observed = {
    F: rows.filter(([kind]) => kind === 'F').map(([, file]) => file),
    M: rows.filter(([kind]) => kind === 'M').map(([, file]) => file),
  };
  if (observed.F.length !== counts.F || observed.M.length !== counts.M) {
    throw new Error('El resumen F/M y el listado del clasificador difieren');
  }
  return {
    count: counts.F + counts.M,
    files: textTestPaths([...observed.F, ...observed.M], 'Clasificador F/M'),
  };
}

function main() {
  const { values, positionals } = parseArgs({
    options: { against: { type: 'string' }, 'strict-improve': { type: 'boolean' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new Error('Uso: node scripts/metrics/ratchet.mjs <repo> [--against <ref>] [--strict-improve]');
  }
  const repo = path.resolve(positionals[0]);
  const read = file => readFileSync(path.join(repo, file), 'utf8');
  const run = (file, ...args) => execFileSync(process.execPath, [
    fileURLToPath(new URL(file, import.meta.url)), repo, ...args,
  ], { encoding: 'utf8' });
  const baseline = parseBaseline(read(baselinePath));
  const allowlist = textTestPaths(read(allowlistPath).split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#')), allowlistPath);
  const errors = [];
  if (values.against !== undefined) {
    const previous = readPreviousBaseline(repo, values.against);
    if (previous) errors.push(...compareBaselines(baseline, previous));
  }
  const measured = readMetrics(run('metrics.mjs'), baseline.metrics, errors);
  const textTests = readTextTests(run('classify-tests.mjs', 'summary'), run('classify-tests.mjs', 'files'));
  measured.set(textMetric, textTests.count);
  for (const file of textTests.files) {
    if (!baseline.sourceTextTests.has(file) && !allowlist.has(file)) {
      errors.push(`Prueba de texto nueva (F/M) fuera de la lista: ${file}`);
    }
  }

  for (const [metric, limit] of Object.entries(baseline.metrics)) {
    const value = measured.get(metric);
    if (value === undefined) {
      errors.push(`Métrica del baseline ausente en la medición: ${metric}`);
    } else if (value > limit) {
      errors.push(`${metric} sube de ${limit} a ${value}`);
    } else if (value < limit) {
      const message = `${metric} baja de ${limit} a ${value}: actualiza el baseline`;
      if (values['strict-improve']) errors.push(message);
      else console.warn(message);
    }
  }
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`PASS trinquete: ${measured.size} métricas, ${textTests.count} pruebas F/M`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
