// refs.mjs <repo> [tsv|summary|unref|who]
// Inventory of tooling files (scripts/, cloud-server/scripts, deploy/, root *.ps1, wdio, migration/, release/, ...)
// and who references each one (by basename, or by extension-less stem inside quotes) among tracked text files.
// Read-only. Limits: basename match can over-count generic names; a file referenced only through a glob or a
// directory listing (fs.readdirSync) shows as unreferenced.
import { repoArg, tracked, read, isText, lines, head } from './lib.mjs';
import path from 'node:path';
const repo = repoArg();
const all = tracked(repo).filter(isText);
const SKIP_REF = /^(package-lock\.json|cloud-server\/package-lock\.json|src-tauri\/Cargo\.lock)$|^scripts\/metrics\//;
const texts = new Map();
for (const f of all) { if (SKIP_REF.test(f)) continue; texts.set(f, read(repo, f)); }
const targets = tracked(repo, 'scripts', 'cloud-server/scripts', 'cloud-server/tools', 'cloud-server/operator', 'deploy', 'migration', 'release', 'supply-chain', 'patches', '*.ps1', 'wdio.*.conf.mjs')
  .filter(f => !/^(DESIGN|src-tauri|docs|tests|cloud-server\/tests|scripts\/metrics)\//.test(f));
function group(f) {
  if (f.startsWith('scripts/catalog-lab/')) return 'catalog-lab';
  if (f.startsWith('scripts/catalog-bench/')) return 'catalog-bench';
  if (f.startsWith('scripts/backup/')) return 'backup';
  if (f.startsWith('scripts/aws/')) return 'aws-deploy';
  if (f.startsWith('scripts/wry-patches/')) return 'desktop-wry';
  if (f.startsWith('cloud-server/scripts/')) return 'cloud-scripts';
  if (f.startsWith('cloud-server/tools/')) return 'cloud-tools';
  if (f.startsWith('cloud-server/operator/')) return 'cloud-operator';
  if (f.startsWith('deploy/')) return 'deploy';
  if (f.startsWith('migration/')) return 'migration';
  if (f.startsWith('release/')) return 'release';
  if (f.startsWith('supply-chain')) return 'supply-chain';
  if (f.startsWith('patches')) return 'patches';
  if (/^wdio\./.test(f)) return 'wdio';
  if (!f.includes('/')) return 'root-ps1';
  const b = path.basename(f);
  if (/^regression-/.test(b)) return 'scripts:regression';
  if (/^run-/.test(b)) return 'scripts:runner';
  if (/^test-/.test(b)) return 'scripts:test';
  if (/^v1-/.test(b)) return 'scripts:v1-ops';
  if (/^catalog-/.test(b)) return 'scripts:catalog';
  return 'scripts:other';
}
function cls(f) {
  if (f === 'package.json' || f === 'cloud-server/package.json') return 'pkg';
  if (f.startsWith('.github/')) return 'workflow';
  if (/\.(md|txt|log)$/i.test(f) || f.startsWith('docs/') || f.startsWith('BLUEPRINT/') || f.startsWith('.agents/')) return 'docs';
  if (f.startsWith('tests/') || f.startsWith('cloud-server/tests/')) return 'tests';
  if (f.startsWith('scripts/') || f.startsWith('cloud-server/scripts/') || f.startsWith('deploy/') || /\.ps1$/.test(f) || /^wdio\./.test(f)) return 'scripts';
  if (f.startsWith('src/') || f.startsWith('cloud-server/') || f.startsWith('src-tauri/') || f === 'vite.config.ts') return 'code';
  return 'other';
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rows = [];
for (const t of targets) {
  const base = path.basename(t);
  const stem = base.replace(/\.(mjs|cjs|js|ps1|sh|ts|json|sql)$/, '');
  const stemRe = stem.length > 8 ? new RegExp('[/\'"`]' + esc(stem) + '[\'"`]') : null;
  const counts = { pkg: 0, workflow: 0, scripts: 0, tests: 0, code: 0, docs: 0, other: 0 };
  const who = [];
  for (const [f, s] of texts) {
    if (f === t) continue;
    if (s.includes(base) || (stemRe && stemRe.test(s))) { counts[cls(f)]++; if (cls(f) !== 'docs') who.push(f); }
  }
  rows.push({ g: group(t), f: t, l: lines(texts.get(t) ?? read(repo, t)), ...counts, who });
}
const exec = r => r.pkg + r.workflow + r.scripts + r.tests + r.code + r.other;
const mode = process.argv[3] || 'tsv';
if (mode === 'tsv') {
  console.log(['group', 'file', 'lines', 'pkg', 'workflow', 'scripts', 'tests', 'code', 'docs', 'other'].join('\t'));
  for (const r of rows) console.log([r.g, r.f, r.l, r.pkg, r.workflow, r.scripts, r.tests, r.code, r.docs, r.other].join('\t'));
} else if (mode === 'summary') {
  const by = {};
  for (const r of rows) {
    const b = by[r.g] ??= { files: 0, lines: 0, noRefAny: 0, docsOnly: 0, execRef: 0, entry: 0 };
    b.files++; b.lines += r.l;
    if (r.pkg + r.workflow > 0) b.entry++;
    if (exec(r) === 0 && r.docs === 0) b.noRefAny++; else if (exec(r) === 0) b.docsOnly++; else b.execRef++;
  }
  console.log('HEAD ' + head(repo) + '  targets=' + rows.length);
  console.log(['group', 'files', 'lines', 'ref_by_pkg_or_workflow', 'ref_by_any_code_or_config', 'docs_only', 'no_reference'].join('\t'));
  const tot = { files: 0, lines: 0, entry: 0, execRef: 0, docsOnly: 0, noRefAny: 0 };
  for (const [g, b] of Object.entries(by).sort()) {
    console.log([g, b.files, b.lines, b.entry, b.execRef, b.docsOnly, b.noRefAny].join('\t'));
    for (const k of Object.keys(tot)) tot[k] += b[k];
  }
  console.log(['TOTAL', tot.files, tot.lines, tot.entry, tot.execRef, tot.docsOnly, tot.noRefAny].join('\t'));
} else if (mode === 'unref') {
  for (const r of rows) if (exec(r) === 0) console.log([r.g, r.f, r.l, 'docs=' + r.docs].join('\t'));
} else if (mode === 'who') {
  for (const r of rows) console.log(r.f + '\t' + r.l + '\t' + r.who.slice(0, 5).join(', '));
}
