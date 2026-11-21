// npm-scripts.mjs <repo>
// For every npm script (root + cloud-server): files it names that do not exist, who invokes it
// (workflows, other npm scripts, other tracked scripts/docs), and a scope tag. Also checks file paths named
// in workflow `run:` lines. Read-only.
import { repoArg, tracked, read, head } from './lib.mjs';
const repo = repoArg();
const all = new Set(tracked(repo));
const wfs = [...all].filter(f => /^\.github\/workflows\/.*\.ya?ml$/.test(f));
const wfText = new Map(wfs.map(f => [f, read(repo, f)]));
const codeText = [...all].filter(f => /^(scripts|cloud-server\/scripts|deploy|tests|cloud-server\/tests)\/.*\.(mjs|cjs|js|ps1|sh|json)$/.test(f) || /^wdio\./.test(f)).map(f => [f, read(repo, f)]);
const docText = [...all].filter(f => /\.md$/.test(f)).map(f => [f, read(repo, f)]);
const PATHRE = /(?:^|[\s"'=(])((?:\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.(?:mjs|cjs|js|ps1|sh|ts|json|toml|py))(?=$|[\s"')&;])/g;
function scope(name, cmd) {
  if (/tauri|cargo|updater|windows|macos|mac-portability|release|packaging|wry|version|upgrade-matrix|e2e:desktop|e2e:import|e2e:downloads|e2e:recovery|github:|build:release|^build$|^check$|^dev$/.test(name) || /src-tauri|cargo |wdio\.e2e|run-tauri|patch-wry/.test(cmd)) return 'DESKTOP/RELEASE';
  return 'V1';
}
console.log('HEAD ' + head(repo));
console.log(['pkg', 'script', 'scope', 'missing_files', 'by_workflows', 'by_npm_scripts', 'by_scripts_or_tests', 'by_docs'].join('\t'));
for (const [pkg, dir] of [['root', ''], ['cloud', 'cloud-server/']]) {
  const p = JSON.parse(read(repo, dir + 'package.json'));
  const scripts = p.scripts || {};
  for (const [name, cmd] of Object.entries(scripts)) {
    const missing = [];
    for (const m of cmd.matchAll(PATHRE)) {
      let f = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
      if (/^(node_modules|https?:)/.test(f)) continue;
      let full = dir + f; while (/(^|\/)[^/]+\/\.\.\//.test(full)) full = full.replace(/(^|\/)[^/]+\/\.\.\//, '$1');
      if (!all.has(full) && !all.has(f)) missing.push(f);
    }
    const needle = new RegExp('npm (?:run )?(?:--prefix \\S+ )?(?:run )?' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w:.-])');
    const byWf = wfs.filter(f => { const t = wfText.get(f); if (!needle.test(t)) return false; if (pkg === 'cloud') return /working-directory: cloud-server|--prefix cloud-server/.test(t); return true; }).map(f => f.replace('.github/workflows/', '').replace(/\.ya?ml$/, ''));
    const byNpm = Object.entries(scripts).filter(([n, c]) => n !== name && needle.test(c)).map(([n]) => n);
    const byCode = codeText.filter(([, t]) => needle.test(t)).map(([f]) => f);
    const byDocs = docText.filter(([, t]) => needle.test(t)).length;
    console.log([pkg, name, scope(name, cmd), missing.join(' ') || '-', byWf.join(' ') || '-', byNpm.join(' ') || '-', byCode.slice(0, 3).join(' ') || '-', byDocs].join('\t'));
  }
}
// workflow run-lines: named files that do not exist
console.log('\nworkflow file references that do not exist:');
let bad = 0;
for (const f of wfs) {
  const t = wfText.get(f); const wd = /working-directory: cloud-server/.test(t);
  for (const line of t.split('\n')) {
    if (!/^\s*(-\s*)?(run:|node |npm |bash |sh |pwsh |powershell )/.test(line) && !/^\s+node /.test(line)) continue;
    for (const m of line.matchAll(PATHRE)) {
      const g = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
      if (/^(node_modules|artifacts|tmp|dist|target|\$)/.test(g) || !g.includes('/')) continue;
      if (!all.has(g) && !all.has('cloud-server/' + g)) { bad++; console.log('  ' + f.replace('.github/workflows/', '') + ': ' + g + (wd ? '  (cwd may be cloud-server)' : '')); }
    }
  }
}
console.log('  total=' + bad);
