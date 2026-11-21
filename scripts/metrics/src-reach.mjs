// src-reach.mjs <repo> [summary|unreachable|desktop-only|web-only|dynamic|reads <file-with-paths>]
// Regex import graph of src/ from src/main.tsx. Read-only.
// Edges followed: import ... from '<rel>', import '<rel>', export ... from '<rel>', import('<rel>'),
//                 new URL('<rel>', import.meta.url), new Worker(new URL(...)).  ?raw/?url/?worker suffixes are stripped.
// "runtime" graph ignores `import type` / `export type` statements (type-only edges vanish at build time).
// Desktop-only = reachable from main.tsx, but not when src/app/DesktopExperience.tsx is removed from the graph.
// Web-only     = same idea removing src/app/WebExperience.tsx.
// Limits: regex, not a TS parser. `import { type A, type B }` (all-inline-type) still counts as a runtime edge
// (over-approximates reachability); Vite tree-shaking and `platform.kind` branches are NOT modelled, so
// "reachable" means "in the module graph", not "executed in the Web build". Non-literal import() is listed, not followed.
import { repoArg, tracked, read, lines, head, stripComments } from './lib.mjs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const repo = repoArg();
const mode = process.argv[3] || 'summary';
const all = new Set(tracked(repo, 'src'));
const code = [...all].filter(f => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
function resolve(from, spec) {
  spec = spec.replace(/\?[a-z&=]+$/i, '');
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const c of [base, base + '.ts', base + '.tsx', base + '.js', base + '.jsx', base + '/index.ts', base + '/index.tsx', base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]) if (all.has(c)) return c;
  return null;
}
const rt = new Map(), ty = new Map(), dyn = [];
const STATIC = /\b(import|export)\s+(type\s+)?(?:[\w*\s{},$]+?\s+from\s+)?(['"])(\.{1,2}\/[^'"]+)\3/g;
const DYN = /\bimport\s*\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)/g;
const URLRE = /new\s+URL\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*,\s*import\.meta\.url/g;
for (const f of all) {
  if (!/\.(ts|tsx)$/.test(f)) continue;
  const src = stripComments(read(repo, f));
  const r = new Set(), t = new Set();
  let m;
  STATIC.lastIndex = 0; while ((m = STATIC.exec(src))) { const x = resolve(f, m[4]); if (x) (m[2] ? t : r).add(x); }
  DYN.lastIndex = 0; while ((m = DYN.exec(src))) { const x = resolve(f, m[2]); if (x) r.add(x); }
  URLRE.lastIndex = 0; while ((m = URLRE.exec(src))) { const x = resolve(f, m[2]); if (x) r.add(x); }
  src.split(/\r?\n/).forEach((l, i) => { if (/\bimport\s*\(\s*(?!['"`])[^)]/.test(l)) dyn.push(f + ':' + (i + 1) + ': ' + l.trim().slice(0, 140)); });
  rt.set(f, r); ty.set(f, t);
}
function reach(entry, { types = false, without = null } = {}) {
  const seen = new Set(); const st = [entry];
  while (st.length) {
    const f = st.pop(); if (seen.has(f) || f === without) continue; seen.add(f);
    for (const x of rt.get(f) || []) st.push(x);
    if (types) for (const x of ty.get(f) || []) st.push(x);
  }
  return seen;
}
const ENTRY = 'src/main.tsx';
const full = reach(ENTRY, { types: true });
const runtime = reach(ENTRY);
const noDesktop = reach(ENTRY, { without: 'src/app/DesktopExperience.tsx' });
const noWeb = reach(ENTRY, { without: 'src/app/WebExperience.tsx' });
const L = f => lines(read(repo, f));
const sumL = fs => fs.reduce((a, f) => a + L(f), 0);
const inRt = code.filter(f => runtime.has(f));
const typeOnly = code.filter(f => full.has(f) && !runtime.has(f));
const unreachable = code.filter(f => !full.has(f));
const desktopOnly = code.filter(f => runtime.has(f) && !noDesktop.has(f));
const webOnly = code.filter(f => runtime.has(f) && !noWeb.has(f));
const shared = code.filter(f => noDesktop.has(f) && noWeb.has(f));
if (mode === 'summary') {
  console.log('HEAD ' + head(repo));
  console.log(['class', 'files', 'lines'].join('\t'));
  console.log(['src code files (.ts/.tsx, no .d.ts)', code.length, sumL(code)].join('\t'));
  console.log(['runtime-reachable from src/main.tsx', inRt.length, sumL(inRt)].join('\t'));
  console.log(['  reachable ONLY through DesktopExperience', desktopOnly.length, sumL(desktopOnly)].join('\t'));
  console.log(['  reachable ONLY through WebExperience', webOnly.length, sumL(webOnly)].join('\t'));
  console.log(['  reachable without either (shared core)', shared.length, sumL(shared)].join('\t'));
  console.log(['  Web graph (main.tsx minus DesktopExperience)', code.filter(f => noDesktop.has(f)).length, sumL(code.filter(f => noDesktop.has(f)))].join('\t'));
  console.log(['reachable through type-only imports', typeOnly.length, sumL(typeOnly)].join('\t'));
  console.log(['unreachable from src/main.tsx', unreachable.length, sumL(unreachable)].join('\t'));
  console.log(['non-literal import() sites (not followed)', dyn.length, ''].join('\t'));
} else if (mode === 'unreachable') unreachable.forEach(f => console.log(f + '\t' + L(f)));
else if (mode === 'type-only') typeOnly.forEach(f => console.log(f + '\t' + L(f)));
else if (mode === 'desktop-only') desktopOnly.forEach(f => console.log(f + '\t' + L(f)));
else if (mode === 'web-only') webOnly.forEach(f => console.log(f + '\t' + L(f)));
else if (mode === 'dynamic') dyn.forEach(d => console.log(d));
else if (mode === 'reads') {
  // classify a list of src paths (one per line, file given as argv[4]) into web-graph / desktop-only / unreachable / missing
  const want = readFileSync(process.argv[4], 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const f of want) {
    const k = !all.has(f) ? 'MISSING' : noDesktop.has(f) ? 'web-graph' : runtime.has(f) ? 'desktop-only' : full.has(f) ? 'type-only' : 'unreachable';
    console.log(k + '\t' + f);
  }
}
else if (mode === 'cycles') {
  // strongly connected components (size > 1) of the runtime import graph = import cycles
  const nodes = code, idx = new Map(), low = new Map(), on = new Set(), st = [], sccs = []; let k = 0;
  const visit = v => {
    idx.set(v, k); low.set(v, k); k++; st.push(v); on.add(v);
    for (const w of rt.get(v) || []) { if (!rt.has(w)) continue; if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))); }
    if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c); }
  };
  for (const v of nodes) if (!idx.has(v)) visit(v);
  sccs.sort((a, b) => b.length - a.length);
  console.log('HEAD ' + head(repo));
  console.log('import cycles (SCC size>1) in src runtime graph: ' + sccs.length + '  files inside cycles: ' + sccs.reduce((a, c) => a + c.length, 0) + '  largest: ' + (sccs[0] ? sccs[0].length : 0));
  for (const c of sccs) console.log('  [' + c.length + '] ' + c.sort().join(' '));
}
