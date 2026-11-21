// pr-checks.mjs <repo> [base-ref=main] [head-ref=HEAD]
// Which workflows would be TRIGGERED by a pull_request base<-head, from the workflow files at <head-ref> in the
// working tree. Read-only (git diff --name-only + file reads). Glob semantics approximated: `**` = any path,
// `*` = any chars except `/`. Does NOT know branch-protection required checks (not visible locally) nor job-level `if:`.
import { execFileSync } from 'node:child_process';
import { repoArg, tracked, read, head } from './lib.mjs';
const repo = repoArg();
const base = process.argv[3] || 'main', hd = process.argv[4] || 'HEAD';
const changed = execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', 'diff', '--name-only', base + '...' + hd], { maxBuffer: 1 << 26 }).toString().split('\n').filter(Boolean);
const glob = g => new RegExp('^' + g.replace(/^['"]|['"]$/g, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]') + '$');
const wfs = tracked(repo, '.github/workflows').filter(f => /\.ya?ml$/.test(f));
console.log('HEAD ' + head(repo) + '  diff ' + base + '...' + hd + ' = ' + changed.length + ' files');
console.log(['workflow', 'pull_request', 'runs_on_this_PR', 'matched_files', 'example'].join('\t'));
let run = 0;
for (const f of wfs) {
  const y = read(repo, f);
  const on = /^on:\s*\n([\s\S]*?)(?=^\S)/m.exec(y + '\nEND:\n');
  const block = on ? on[1] : '';
  const pr = /^  pull_request:[ \t]*\n((?:    .*\n|\s*\n)*)/m.exec(block + '\n');
  const prBare = /^  pull_request:\s*$/m.test(block);
  if (!pr && !prBare) { console.log([f.replace('.github/workflows/', ''), 'no', '-', '', ''].join('\t')); continue; }
  const body = pr ? pr[1] : '';
  const branches = /^    branches:\s*(?:\[([^\]]*)\]|\n((?:      - .*\n)+))/m.exec(body);
  const brs = branches ? (branches[1] ? branches[1].split(',') : branches[2].split('\n')).map(s => s.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
  const pm = /^    paths:\s*\n((?:      - .*\n)+)/m.exec(body);
  const paths = pm ? pm[1].split('\n').map(s => s.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : null;
  const branchOk = !brs || brs.some(b => glob(b).test(base.replace(/^origin\//, '')));
  let matched = changed;
  if (paths) { const res = paths.map(glob); matched = changed.filter(c => res.some(r => r.test(c))); }
  const runs = branchOk && matched.length > 0;
  if (runs) run++;
  console.log([f.replace('.github/workflows/', ''), paths ? 'paths(' + paths.length + ')' : 'all paths', runs ? 'YES' : 'no', matched.length, matched[0] || ''].join('\t'));
}
console.log('workflows triggered by this PR: ' + run + ' of ' + wfs.length);
