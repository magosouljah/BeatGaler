// metrics.mjs <repo> [all|<section>]   sections: patches singletons tx jobs testbags exports hooks env counts sizes routes orphans
// Deterministic, read-only structural metrics for BeatGaler. Counts are regex-based over TRACKED files only.
import { repoArg, tracked, read, lines, head, stripComments } from './lib.mjs';
const repo = repoArg();
const want = process.argv[3] || 'all';
const on = s => want === 'all' || want === s;
const all = tracked(repo);
const cloudProd = all.filter(f => /^cloud-server\/.*\.(js|cjs|mjs)$/.test(f) && !/^cloud-server\/(tests|scripts|tools)\//.test(f));
const cloudRoot = cloudProd.filter(f => /^cloud-server\/[^/]+$/.test(f));
const catalog = all.filter(f => /^cloud-server\/catalog\/[^/]+\.js$/.test(f));
const srcCode = all.filter(f => /^src\/.*\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
const testFiles = all.filter(f => /^(tests|cloud-server\/tests)\//.test(f) || /^scripts\/.*(test|regression)/.test(f));
const T = new Map();
const txt = f => { if (!T.has(f)) T.set(f, stripComments(read(repo, f))); return T.get(f); };
function count(files, re) {
  let n = 0; const per = [];
  for (const f of files) { const m = txt(f).match(re); if (m) { n += m.length; per.push([f, m.length]); } }
  return { n, files: per.length, per };
}
const out = (name, value, extra = '') => console.log([name, value, extra].join('\t'));
console.log('HEAD ' + head(repo));
console.log(['metric', 'value', 'detail'].join('\t'));

if (on('patches')) {
  // Any reassignment of an Express prototype method, however the prototype is named locally
  // (express.application.post = ..., or `const application = express.application; application.post = function ...`).
  const a = count(cloudProd, /\b(?:express\.)?application\.(?:post|get|use|listen|put|patch|delete|all)\s*=\s*function\b/g);
  out('P1 Express prototype method reassignments (cloud prod JS)', a.n, 'files=' + a.files + ' ' + a.per.map(p => p[0].replace('cloud-server/', '') + ':' + p[1]).join(' '));
  const a0 = count(cloudProd, /\bexpress\.application\.[A-Za-z]+\s*=(?!=)/g);
  out('P1b ...of which written literally as `express.application.X =`', a0.n, 'files=' + a0.files + ' (naive grep; undercounts)');
  const a1 = count(['cloud-server/server.js'], /\binstall[A-Za-z]+\(express\b/g);
  out('P1c install*(express) interposition calls in server.js', a1.n, '');
  const b = count(cloudProd, /\b(res|response)\.(json|send|end|write|writeHead|setHeader|status)\s*=(?!=)/g);
  out('P2 res.json/send/... reassignments (cloud prod JS)', b.n, 'files=' + b.files + ' ' + b.per.map(p => p.join(':')).join(' '));
  const c = count([...cloudProd, ...srcCode], /\b(globalThis|global|window|self)\.fetch\s*=(?!=)/g);
  out('P3 global fetch reassignments (cloud + src)', c.n, c.per.map(p => p.join(':')).join(' '));
}
if (on('singletons')) {
  const a = count(catalog, /^(?:async\s+)?function\s+configure[A-Z]\w*\s*\(/gm);
  out('S1 module-level configureX() singletons in cloud-server/catalog', a.n, 'files=' + a.files);
  const b = count(cloudProd, /\bcurrent(?:Catalog|Prefix|NativeTransport)\w*\s*\(\s*\)/g);
  out('S2 currentX() call sites (cloud prod JS)', b.n, 'files=' + b.files);
  const c = count(cloudProd, /^let\s+\w+\s*=\s*(?:null|undefined|false|0|new Map\(\)|new Set\(\)|\[\]|\{\})\s*;/gm);
  out('S3 module-level mutable `let x = <empty>` (cloud prod JS)', c.n, 'files=' + c.files);
}
if (on('tx')) {
  for (const name of ['sqlError', 'mutationTx', 'readTx']) {
    const a = count(catalog, new RegExp('(?:function\\s+' + name + '\\s*\\(|(?:const|let)\\s+' + name + '\\s*=)', 'g'));
    out('T  local definitions of ' + name + ' in cloud-server/catalog', a.n, a.per.map(p => p[0].replace('cloud-server/catalog/', '')).join(' '));
  }
  const b = count(catalog, /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/g);
  out('T  literal BEGIN/COMMIT/ROLLBACK tokens in cloud-server/catalog', b.n, 'files=' + b.files);
}
if (on('jobs')) {
  const a = count(cloudProd, /INSERT\s+INTO\s+catalog_jobs\b/gi);
  out('J1 raw INSERT INTO catalog_jobs sites (cloud prod JS)', a.n, 'files=' + a.files + ' ' + a.per.map(p => p.join(':')).join(' '));
  const b = count(cloudProd, /INSERT\s+INTO\s+catalog_operations\b/gi);
  out('J2 raw INSERT INTO catalog_operations sites', b.n, 'files=' + b.files);
  const c = count(cloudProd, /UPDATE\s+catalog_jobs\b/gi);
  out('J3 raw UPDATE catalog_jobs sites', c.n, 'files=' + c.files);
}
if (on('testbags')) {
  const a = count([...cloudProd, ...srcCode], /\b(?:_test|__test|__testing|_internals?|__internals?)\s*:\s*\{|exports\.(?:_test|__test)\s*=/g);
  out('B1 _test/__test export bags (cloud prod + src)', a.n, a.per.map(p => p.join(':')).join(' '));
  const b = count(testFiles, /(?:\.|\b)(?:_test|__test)\b/g);
  out('B2 uses of ._test/.__test in test files', b.n, 'files=' + b.files);
  const c = count(srcCode, /^export\s+(?:const|function)\s+(?:__\w+|\w+ForTests?|\w+__test\w*)\b/gm);
  out('B3 src exports named __x / xForTest(s)', c.n, 'files=' + c.files);
}
if (on('exports')) {
  const dtc = txt('cloud-server/direct-transport-control.js');
  const m = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/.exec(dtc);
  out('X1 exports of cloud-server/direct-transport-control.js', m ? m[1].split('\n').filter(l => /^\s+[A-Za-z_$]/.test(l)).length : 'n/a', 'lines=' + lines(read(repo, 'cloud-server/direct-transport-control.js')));
  const sc = txt('cloud-server/server-core.js');
  out('X2 server-core.js lines / top-level functions', lines(read(repo, 'cloud-server/server-core.js')), 'functions=' + (sc.match(/^(?:async\s+)?function\s+\w+/gm) || []).length);
  const c = txt('src/platform/contracts.ts');
  const ifaces = [...c.matchAll(/export interface (\w+)[^{]*\{([\s\S]*?)\n\}/g)];
  const ports = ifaces.filter(i => /Port$/.test(i[1]));
  const members = s => s.split('\n').filter(l => /^\s{2}[A-Za-z_]\w*\??\s*[:(]/.test(l)).length;
  const adapter = ifaces.find(i => i[1] === 'PlatformAdapter');
  out('X3 contracts.ts: ports on PlatformAdapter', adapter ? members(adapter[2]) - 3 : 'n/a', 'port interfaces=' + ports.length + ' members across ports=' + ports.reduce((a, i) => a + members(i[2]), 0) + ' exported decls=' + (c.match(/^export (?:interface|type|const|function|class|enum)/gm) || []).length);
  const g = txt('src/features/library/catalog/useCatalogGalleryScope.ts');
  const r = g.lastIndexOf('\n  return {');
  if (r >= 0) {
    const body = g.slice(r + 11, g.indexOf('\n  };', r));
    let depth = 0, keys = 0, cur = '';
    for (const ch of body) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; if (ch === ',' && depth === 0) { if (cur.trim()) keys++; cur = ''; } else cur += ch; }
    if (cur.trim()) keys++;
    out('X4 keys returned by useCatalogGalleryScope()', keys, '');
  }
}
if (on('hooks')) {
  const f = 'src/features/library/catalog/useCatalogGalleryScope.ts';
  const raw = read(repo, f), g = txt(f);
  const c = re => (g.match(re) || []).length;
  out('H1 useCatalogGalleryScope.ts lines', lines(raw), '');
  out('H2 hook calls in it', c(/\buse(State|Ref|Effect|LayoutEffect|Callback|Memo|Reducer|SyncExternalStore)\s*[(<]/g),
    ['useState', 'useRef', 'useEffect', 'useLayoutEffect', 'useCallback', 'useMemo', 'useSyncExternalStore'].map(h => h + '=' + c(new RegExp('\\b' + h + '\\s*[(<]', 'g'))).join(' '));
  out('H3 eslint-disable in it', (raw.match(/eslint-disable/g) || []).length, '');
  const e = count(srcCode, /eslint-disable/g); // comments are stripped in txt(); recount on raw
  let ed = 0, edf = 0; for (const s of srcCode) { const k = (read(repo, s).match(/eslint-disable|@ts-ignore|@ts-expect-error|as any\b/g) || []).length; if (k) { ed += k; edf++; } }
  out('H4 escape hatches in src (eslint-disable|@ts-ignore|@ts-expect-error|as any)', ed, 'files=' + edf);
  const perFile = srcCode.map(s => [s, (txt(s).match(/\buse(State|Ref|Effect|LayoutEffect|Callback|Memo)\s*[(<]/g) || []).length]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  out('H5 top hook-density files in src', perFile[0][1], perFile.map(p => p[0].replace('src/', '') + ':' + p[1]).join(' '));
}
if (on('env')) {
  const names = new Map(); let filesN = 0;
  for (const f of cloudProd) {
    const s = txt(f); const m = [...s.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)];
    const dyn = /process\.env\[(?!\s*['"])/.test(s) || /\b(?:const|let)\s*\{[^}]*\}\s*=\s*process\.env|=\s*process\.env\s*[;,)]|\(process\.env\)|\benv\s*=\s*process\.env\b/.test(s);
    if (m.length || dyn) filesN++;
    for (const x of m) { const n = x[1] || x[2]; names.set(n, (names.get(n) || 0) + 1); }
  }
  out('E1 distinct process.env.NAME read in cloud prod JS', names.size, 'read sites=' + [...names.values()].reduce((a, b) => a + b, 0));
  out('E2 cloud prod JS files touching process.env', filesN, 'of ' + cloudProd.length);
  const web = new Set(); for (const f of srcCode) for (const x of txt(f).matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g)) web.add(x[1]);
  out('E3 distinct import.meta.env.NAME in src', web.size, [...web].sort().join(' '));
}
if (on('counts')) {
  const wf = all.filter(f => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const pr = wf.filter(f => /^\s{2}pull_request:/m.test(read(repo, f)));
  const push = wf.filter(f => /^\s{2}push:/m.test(read(repo, f)));
  out('C1 workflow files', wf.length, 'pull_request=' + pr.length + ' push=' + push.length + ' lines=' + wf.reduce((a, f) => a + lines(read(repo, f)), 0));
  const p = JSON.parse(read(repo, 'package.json')), c = JSON.parse(read(repo, 'cloud-server/package.json'));
  out('C2 npm scripts (root / cloud-server)', Object.keys(p.scripts).length + ' / ' + Object.keys(c.scripts || {}).length, '');
  const sc = all.filter(f => f.startsWith('scripts/'));
  out('C3 tracked files under scripts/', sc.length, 'lines=' + sc.reduce((a, f) => a + lines(read(repo, f)), 0));
  out('C4 tracked files total', all.length, '');
  const docs = all.filter(f => f.startsWith('docs/'));
  out('C5 tracked files under docs/', docs.length, 'lines=' + docs.reduce((a, f) => a + lines(read(repo, f)), 0));
  out('C6 VERSION vs package.json version', read(repo, 'VERSION').trim() + ' vs ' + p.version, read(repo, 'VERSION').trim() === p.version ? 'match' : 'MISMATCH');
}
if (on('sizes')) {
  for (const [label, files] of [['src', srcCode], ['cloud prod JS', cloudProd]]) {
    const ls = files.map(f => [f, lines(read(repo, f))]).sort((a, b) => b[1] - a[1]);
    const tot = ls.reduce((a, x) => a + x[1], 0);
    const q = p => ls[Math.min(ls.length - 1, Math.floor(ls.length * (1 - p)))][1];
    out('Z  ' + label + ': files / lines', ls.length + ' / ' + tot, 'max=' + ls[0][1] + ' p90=' + q(0.9) + ' median=' + q(0.5) + ' >1000=' + ls.filter(x => x[1] > 1000).length + ' >500=' + ls.filter(x => x[1] > 500).length + ' top10 share=' + (100 * ls.slice(0, 10).reduce((a, x) => a + x[1], 0) / tot).toFixed(1) + '%');
    out('Z  ' + label + ': top 15', '', ls.slice(0, 15).map(x => x[0].replace(/^(src|cloud-server)\//, '') + ':' + x[1]).join(' '));
  }
}
if (on('routes')) {
  const a = count(cloudProd, /\b(?:app|router)\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`\/]/g);
  out('R1 Express route registrations (cloud prod JS)', a.n, 'files=' + a.files + ' ' + a.per.sort((x, y) => y[1] - x[1]).slice(0, 8).map(p => p[0].replace('cloud-server/', '') + ':' + p[1]).join(' '));
}
if (on('orphans')) {
  // test files that no runner selects: not under a directory-glob runner and not named in any package.json / workflow / suite manifest / script
  const globRun = f => /^tests\/(component-dom|integration)\/[^/]+\.test\.tsx?$/.test(f) || /^tests\/e2e\/[^/]+\.e2e\.mjs$/.test(f) /* wdio.e2e.conf.mjs glob (Desktop) */ ||/^cloud-server\/tests\/[^/]+\.(test\.(cjs|mjs)|runner\.cjs|integration\.cjs)$/.test(f);
  const cfg = ['package.json', 'cloud-server/package.json', 'scripts/catalog-suites.json', ...all.filter(f => /^\.github\/workflows\//.test(f)), ...all.filter(f => /^scripts\/[^/]+\.(mjs|cjs)$/.test(f)), ...all.filter(f => /^wdio\./.test(f)), 'tests/catalog-harness/wdio.catalog-harness.conf.mjs'].map(f => read(repo, f)).join('\n');
  const cand = all.filter(f => /^(tests|cloud-server\/tests)\/.*\.(test|integration|e2e|runner)\.(cjs|mjs|tsx?)$/.test(f));
  const orphans = cand.filter(f => !globRun(f) && !cfg.includes(f.split('/').pop()) && !cfg.includes(f.split('/').pop().replace(/\.tsx?$/, '.js')));
  out('O1 test files selected by no runner/config', orphans.length, 'of ' + cand.length + ': ' + orphans.join(' '));
  const never = cand.filter(f => /postgres-live\.integration/.test(f));
  out('O2 test files explicitly forbidden', never.length, never.join(' '));
}
