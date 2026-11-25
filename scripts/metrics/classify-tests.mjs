// classify-tests.mjs <repo> [summary|files|F|M|C|O|json]
// Deterministic, read-only classification of every tracked test file.
//   C  behaviour  : imports/requires/spawns product code and does NOT read product source as text
//   F  source-text: reads product source files as text (readFileSync/readFile/?raw) and does not execute product code
//   M  mixed      : both
//   O  other      : neither pattern (helpers-only, pure-data, shell)
// "Product source read" = the file has a read call AND one non-import, non-spawn line gives evidence:
//   (1) a read call whose own line names product code (top-level product dir literal, path segments, __dirname/..,
//       require.resolve, or any literal with a code extension), excluding fixtures/tmp/.json/.sql/worker/test files;
//   (2) a product path literal with a code extension elsewhere in the file (helper read("src/x.ts"), file tables).
// Limits: text heuristic. A test that reads source only to locate something, or that both spawns and reads a script,
// lands in M. Audit with mode "files" (prints the evidence line per file).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoArg, tracked, read, head } from './lib.mjs';
const repo = repoArg();
const mode = process.argv[3] || 'summary';

const DIRS = [
  ['tests/component-dom', f => /^tests\/component-dom\/[^/]+\.test\.tsx?$/.test(f)],
  ['tests/integration', f => /^tests\/integration\/[^/]+\.test\.tsx?$/.test(f)],
  ['tests/unit+component', f => /^tests\/(unit|component)\/[^/]+\.test\.tsx?$/.test(f)],
  ['tests/e2e-web', f => /^tests\/e2e-web\/[^/]+\.(test|e2e)\.(mjs|cjs)$/.test(f)],
  ['tests/e2e (Desktop)', f => /^tests\/e2e\/[^/]+\.e2e\.mjs$/.test(f)],
  ['tests/catalog-harness', f => /^tests\/catalog-harness\/[^/]+\.e2e\.mjs$/.test(f)],
  ['tests/playback-*', f => /^tests\/playback-[^/]+\/[^/]+\.test\.mjs$/.test(f)],
  ['tests/(root)', f => /^tests\/[^/]+\.(test\.(mjs|sh)|browser\.mjs)$/.test(f)],
  ['cloud-server/tests', f => /^cloud-server\/tests\/[^/]+\.(test|integration|runner)\.(cjs|mjs)$/.test(f)],
  ['cloud-server/tests/catalog', f => /^cloud-server\/tests\/catalog\/[^/]+\.(test|integration)\.cjs$/.test(f)],
  ['cloud-server/tests/catalog-harness', f => /^cloud-server\/tests\/catalog-harness\/[^/]+\.(test|integration)\.cjs$/.test(f)],
  ['scripts (guards)', f => /^scripts\/(regression-[^/]+|test-[^/]+|[^/]+\.test)\.(mjs|cjs|ts)$/.test(f) || f === 'scripts/run-regressions.mjs' || /^scripts\/catalog-bench\/[^/]+\.test\.cjs$/.test(f)],
];

const Q = '[\'"`]';
const READ_CALL = /\b(readFileSync|readFile)\s*\(/;
const RAW_IMPORT = new RegExp('\\?raw' + Q);
const IMPORT_LINE = new RegExp('^\\s*(import\\b|\\}?\\s*from\\s+' + Q + '|export\\b.*\\bfrom\\b|.*\\brequire\\s*\\(|.*\\bimport\\s*\\(|.*\\b(vi|jest)\\.(mock|doMock|importActual)\\s*\\()');
const SPAWN_LINE = /\b(spawnSync|execFileSync|execSync|spawn|fork|execFile)\s*\(/;
const TOP = '(?:\\.{1,2}/)*(?:src|cloud-server|src-tauri|\\.github|scripts|deploy|public|DESIGN|BLUEPRINT)/';
const CODE_EXT = '(?:tsx?|jsx?|cjs|mjs|rs|css|ya?ml|ps1|sh|html|toml|conf)';
const PRODUCT_LITERAL = new RegExp(Q + '(' + TOP + '[^\'"`\\n]*|index\\.html|vite\\.config\\.ts|package\\.json|VERSION)' + Q);
const ANY_CODE_LITERAL = new RegExp(Q + '[^\'"`\\n]*\\.' + CODE_EXT + Q);
const ENDS_CODE = new RegExp('\\.' + CODE_EXT + '$');
const JOIN_SEG = new RegExp(Q + '(src|cloud-server|src-tauri|\\.github|scripts|deploy|public)' + Q + '\\s*,');
const UP_DIR = new RegExp('__dirname\\s*,\\s*' + Q + '\\.\\.' + Q + '|require\\.resolve\\(|new URL\\(\\s*' + Q + '\\.\\.?/');
const TESTISH = /(\.worker\.|\.test\.|\.integration\.|\.e2e\.|fixtures?|helpers?\/|tmp|\.json['"`]|\.sql['"`])/i;
const IMPORT_PRODUCT = new RegExp(
  '(from\\s+' + Q + '(?:\\.\\./)+(?:src|cloud-server|scripts)/' +
  '|from\\s+' + Q + '@/' +
  '|from\\s+' + Q + '\\./(?!helpers)' +
  '|import\\(\\s*' + Q + '(?:\\.\\./)+(?:src|cloud-server|scripts)/' +
  '|import\\(\\s*' + Q + '@/' +
  '|require\\(\\s*' + Q + '\\.\\./(?:\\.\\./)*(?!tests/|helpers/|fixtures/|node_modules/)[^\'"`]+' + Q + '\\s*\\)' +
  '|require\\(\\s*path\\.(?:join|resolve)\\([^)]*\\.\\.[^)]*\\)\\s*\\))');
const SPAWN = SPAWN_LINE;
const WDIO = new RegExp('\\bbrowser\\.(url|execute|\\$)|\\$\\(\\s*' + Q);

// A path that is never read: (a) bound to a name whose every other use is inside a spawn/exec/fork call, or
// (b) passed as data to a function imported from product code (callee imported from a non-helper module).
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function notRead(l, ls) {
  const decl = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(l);
  if (decl) {
    const id = new RegExp('(?<![\\w$.])' + esc(decl[1]) + '(?![\\w$])');
    const uses = ls.filter(x => x !== l && id.test(x));
    if (uses.length && uses.every(x => SPAWN_LINE.test(x))) return true;
  }
  const call = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(\s*\[?\s*['"`]/.exec(l);
  if (call && !READ_CALL.test(l)) {
    const name = esc(call[1]);
    const imp = new RegExp('^\\s*(?:(?:const|let|var)\\s+\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s*=\\s*require|import\\s*\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s*from)');
    const src = ls.find(x => imp.test(x));
    if (src && !/helpers?\b|fixtures?\b/i.test(src)) return true;
  }
  return false;
}

function sourceEvidence(ls) {
  for (const l of ls) {
    if (RAW_IMPORT.test(l)) return l.trim();
    if (IMPORT_LINE.test(l) && !READ_CALL.test(l)) continue;
    if (SPAWN_LINE.test(l)) continue;
    if (READ_CALL.test(l)) {
      if (PRODUCT_LITERAL.test(l) || JOIN_SEG.test(l)) { if (!TESTISH.test(l)) return l.trim(); else continue; }
      if (UP_DIR.test(l) && !TESTISH.test(l)) return l.trim();
      if (ANY_CODE_LITERAL.test(l) && !TESTISH.test(l)) return l.trim();
      continue;
    }
    const m = PRODUCT_LITERAL.exec(l);
    if (m && notRead(l, ls)) continue;
    if (m && ENDS_CODE.test(m[1]) && !TESTISH.test(m[1])) return l.trim();
    if (m && /^(src|cloud-server)\/[a-z-]+$/.test(m[1])) return l.trim(); // walk("src/features")
    if (JOIN_SEG.test(l) && ANY_CODE_LITERAL.test(l) && !TESTISH.test(l) && !notRead(l, ls)) return l.trim();
  }
  return '';
}

// Subject of an F/M test (derived, fail-closed): "desktop" only when every product path it names is Desktop-only
// (src files reachable only through DesktopExperience per src-reach `desktop-only`, src-tauri/, DESIGN/, release/Desktop
// scripts and workflows). Any other or unrecognised code path, or no recognisable path at all, gives "v1".
const SEG = new RegExp(Q + '([^\'"`\\s,()]+)' + Q, 'g');
const RUN = new RegExp(Q + '[^\'"`\\s,()]+' + Q + '(?:\\s*,\\s*' + Q + '[^\'"`\\s,()]+' + Q + ')+', 'g');
const KNOWN_TOP = /^(src|cloud-server|src-tauri|\.github|scripts|deploy|public|DESIGN|BLUEPRINT)\//;
const ROOT_FILES = /^(index\.html|vite\.config\.ts|package\.json|VERSION)$/;
const DESKTOP_PATH = /^(src-tauri\/|DESIGN\/|\.github\/workflows\/release-desktop)|^scripts\/[^/]*(release|desktop|tauri|updater|authenticode|windows|macos|msi|nsis)[^/]*$/i;
let desktopSrc = null;
function desktopOnlySrc() {
  if (!desktopSrc) {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('src-reach.mjs', import.meta.url)), repo, 'desktop-only'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    desktopSrc = new Set(out.split(/\r?\n/).map(l => l.split('\t')[0]).filter(Boolean));
  }
  return desktopSrc;
}
export function namedPaths(text) {
  const cands = new Set();
  for (const l of text.split(/\r?\n/)) {
    if (IMPORT_LINE.test(l) && !READ_CALL.test(l)) continue;
    for (const m of l.matchAll(RUN)) {
      const segs = [...m[0].matchAll(SEG)].map(x => x[1]).filter(x => !/^(utf-?8|latin1|ascii|binary)$/i.test(x));
      if (segs.length > 1 && !segs[0].includes('/')) cands.add(segs.join('/'));
    }
    for (const m of l.matchAll(SEG)) cands.add(m[1]);
  }
  const known = [], unknown = [];
  for (const c of cands) {
    const n = c.replace(/^(\.{1,2}\/)+/, '');
    if (KNOWN_TOP.test(n) || ROOT_FILES.test(n)) known.push(n);
    else if (ENDS_CODE.test(c) && !TESTISH.test(c)) unknown.push(c);
  }
  return { known, unknown };
}
export function subjectOf(text, isDesktopSrc = f => desktopOnlySrc().has(f)) {
  const { known, unknown } = namedPaths(text);
  const product = known.filter(f => !TESTISH.test(f) || /^src\//.test(f));
  if (!product.length || unknown.length) return 'v1';
  const isDir = f => !/\.[a-z0-9]+$/i.test(f);
  return product.every(f => DESKTOP_PATH.test(f) || (/^src\//.test(f) && !isDir(f) && isDesktopSrc(f))) ? 'desktop' : 'v1';
}

const rows = [];
const files = tracked(repo, 'tests', 'cloud-server/tests', 'scripts');
for (const [dir, pred] of DIRS) {
  for (const f of files.filter(pred)) {
    const t = read(repo, f);
    const ls = t.split(/\r?\n/);
    const hasRead = READ_CALL.test(t) || RAW_IMPORT.test(t);
    const evidence = hasRead ? sourceEvidence(ls) : '';
    const readsSource = !!evidence;
    // import evidence must sit on a real import/require line, never inside an assertion string
    const importLines = ls.filter(l => /^\s*(import\b|\}\s*from\b|export\b)/.test(l) || (/\b(require|import)\s*\(/.test(l) && !/\b(expect|toContain|toMatch|includes)\b|assert\./.test(l)));
    const executes = importLines.some(l => IMPORT_PRODUCT.test(l)) || SPAWN.test(t) || WDIO.test(t);
    const kind = readsSource && executes ? 'M' : readsSource ? 'F' : executes ? 'C' : 'O';
    const reads = (t.match(/\b(readFileSync|readFile)\s*\(/g) || []).length;
    const subject = kind === 'F' || kind === 'M' ? subjectOf(t) : '';
    rows.push({ dir, file: f, kind, reads, evidence: evidence.slice(0, 140), subject });
  }
}
if (mode === 'json') { console.log(JSON.stringify(rows, null, 1)); }
else if (mode === 'files') { for (const r of rows) console.log([r.kind, r.file, r.reads, r.evidence, r.subject].join('\t')); }
else if ('FMOC'.includes(mode) && mode.length === 1) { for (const r of rows) if (r.kind === mode) console.log(r.file); }
else {
  console.log('HEAD ' + head(repo));
  console.log(['directory', 'files', 'C_behaviour', 'F_source_text', 'M_mixed', 'O_other'].join('\t'));
  const tot = { n: 0, C: 0, F: 0, M: 0, O: 0 };
  for (const [dir] of DIRS) {
    const rs = rows.filter(r => r.dir === dir);
    const c = k => rs.filter(r => r.kind === k).length;
    console.log([dir, rs.length, c('C'), c('F'), c('M'), c('O')].join('\t'));
    tot.n += rs.length; for (const k of 'CFMO') tot[k] += c(k);
  }
  console.log(['TOTAL', tot.n, tot.C, tot.F, tot.M, tot.O].join('\t'));
}
