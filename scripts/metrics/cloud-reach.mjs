// cloud-reach.mjs <repo> [summary|unreachable|tools-only|tests-only|dynamic|prod]
// Static require/import graph over tracked JS of the Cloud. Read-only.
// Entries PROD  = cloud-server/server.js, cloud-server/catalog-worker.js  (deploy/aws/beatgaler-start.sh)
//         TOOLS = cloud-server/scripts/**, cloud-server/tools/**, scripts/**, deploy/**   (CLIs / ops)
//         TESTS = cloud-server/tests/**, tests/**
// Edges: require('<relative>'), import ... from '<relative>', import('<relative>') with STRING LITERAL specifiers only.
// Limits: computed requires (require(variable), require(path.join(...))) are NOT followed and are listed by mode
// "dynamic"; a module loaded only that way shows as unreachable. Comment stripping is crude.
import { repoArg, tracked, read, lines, head, stripComments } from './lib.mjs';
import path from 'node:path';
const repo = repoArg();
const mode = process.argv[3] || 'summary';
const all = new Set(tracked(repo));
const isJs = f => /\.(js|cjs|mjs)$/.test(f);
const scopeFiles = [...all].filter(f => isJs(f) && (f.startsWith('cloud-server/') || f.startsWith('scripts/') || f.startsWith('deploy/') || f.startsWith('tests/')));
const subject = [...all].filter(f => isJs(f) && f.startsWith('cloud-server/') && !/^cloud-server\/(tests|scripts|tools)\//.test(f));

function resolve(from, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const cands = [base, base + '.js', base + '.cjs', base + '.mjs', base + '.json', base + '/index.js'];
  for (const c of cands) if (all.has(c)) return c;
  return null;
}
const edges = new Map();
const dynamic = [];
const RE = [
  /\brequire\s*\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)/g,
  /\bfrom\s*(['"])(\.{1,2}\/[^'"]+)\1/g,
  /\bimport\s*\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)/g,
  /\bimport\s+(['"])(\.{1,2}\/[^'"]+)\1/g,
  /\brequire\.resolve\s*\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)/g,
];
for (const f of scopeFiles) {
  const src = stripComments(read(repo, f));
  const out = new Set();
  for (const re of RE) { re.lastIndex = 0; let m; while ((m = re.exec(src))) { const r = resolve(f, m[2]); if (r) out.add(r); } }
  edges.set(f, out);
  if (subject.includes(f)) {
    const ls = src.split(/\r?\n/);
    ls.forEach((l, i) => { if (/\brequire\s*\(\s*(?!['"`])[^)]/.test(l) && !/\brequire\s*\(\s*\)/.test(l)) dynamic.push(f + ':' + (i + 1) + ': ' + l.trim().slice(0, 150)); });
  }
}
function reach(entries) {
  const seen = new Set(); const st = entries.filter(e => all.has(e));
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f); for (const t of edges.get(f) || []) if (!seen.has(t)) st.push(t); }
  return seen;
}
const PROD = ['cloud-server/server.js', 'cloud-server/catalog-worker.js'];
const TOOLS = scopeFiles.filter(f => /^(cloud-server\/(scripts|tools)|scripts|deploy)\//.test(f));
const TESTS = scopeFiles.filter(f => /^(cloud-server\/tests|tests)\//.test(f));
const rProd = reach(PROD), rTools = reach(TOOLS), rTests = reach(TESTS);
const L = f => lines(read(repo, f));
const sumL = fs => fs.reduce((a, f) => a + L(f), 0);
const prod = subject.filter(f => rProd.has(f));
const toolsOnly = subject.filter(f => !rProd.has(f) && rTools.has(f));
const testsOnly = subject.filter(f => !rProd.has(f) && !rTools.has(f) && rTests.has(f));
const none = subject.filter(f => !rProd.has(f) && !rTools.has(f) && !rTests.has(f));
if (mode === 'summary') {
  console.log('HEAD ' + head(repo));
  console.log(['class', 'files', 'lines'].join('\t'));
  console.log(['cloud JS (excl. tests/scripts/tools)', subject.length, sumL(subject)].join('\t'));
  console.log(['reachable from server.js|catalog-worker.js', prod.length, sumL(prod)].join('\t'));
  console.log(['NOT prod-reachable', subject.length - prod.length, sumL(subject) - sumL(prod)].join('\t'));
  console.log(['  only via tools/CLIs', toolsOnly.length, sumL(toolsOnly)].join('\t'));
  console.log(['  only via tests', testsOnly.length, sumL(testsOnly)].join('\t'));
  console.log(['  referenced by nothing', none.length, sumL(none)].join('\t'));
  console.log(['computed require() sites in cloud JS (not followed)', dynamic.length, ''].join('\t'));
  const onlyServer = reach(['cloud-server/server.js']), onlyWorker = reach(['cloud-server/catalog-worker.js']);
  console.log(['reachable from server.js', subject.filter(f => onlyServer.has(f)).length, ''].join('\t'));
  console.log(['reachable from catalog-worker.js', subject.filter(f => onlyWorker.has(f)).length, ''].join('\t'));
} else if (mode === 'unreachable') { for (const f of [...toolsOnly.map(f => 'tools\t' + f), ...testsOnly.map(f => 'tests\t' + f), ...none.map(f => 'none\t' + f)]) console.log(f + '\t' + L(f.split('\t')[1])); }
else if (mode === 'tools-only') toolsOnly.forEach(f => console.log(f + '\t' + L(f)));
else if (mode === 'tests-only') testsOnly.forEach(f => console.log(f + '\t' + L(f)));
else if (mode === 'dynamic') dynamic.forEach(d => console.log(d));
else if (mode === 'prod') prod.forEach(f => console.log(f + '\t' + L(f)));
else if (mode === 'cycles') {
  const nodes = subject, idx = new Map(), low = new Map(), on = new Set(), st = [], sccs = []; let k = 0;
  const visit = v => {
    idx.set(v, k); low.set(v, k); k++; st.push(v); on.add(v);
    for (const w of edges.get(v) || []) { if (!subject.includes(w)) continue; if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))); }
    if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c); }
  };
  for (const v of nodes) if (!idx.has(v)) visit(v);
  sccs.sort((a, b) => b.length - a.length);
  console.log('HEAD ' + head(repo));
  console.log('require cycles (SCC size>1) in cloud prod JS: ' + sccs.length + '  files inside cycles: ' + sccs.reduce((a, c) => a + c.length, 0) + '  largest: ' + (sccs[0] ? sccs[0].length : 0));
  for (const c of sccs) console.log('  [' + c.length + '] ' + c.sort().join(' '));
}
