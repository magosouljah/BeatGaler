// Shared read-only helpers. Never writes into the repo.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function repoArg() {
  const r = process.argv[2];
  if (!r) { console.error('usage: node <script> <repo-path> [options]'); process.exit(2); }
  return path.resolve(r);
}
export function tracked(repo, ...pathspecs) {
  const out = execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', 'ls-files', '-z', '--', ...pathspecs], { maxBuffer: 1 << 28 });
  return out.toString('utf8').split('\0').filter(Boolean);
}
const BIN = /\.(png|jpe?g|gif|webp|ico|icns|mp3|wav|flac|ogg|woff2?|ttf|otf|zip|gz|wasm|pdf|exe|dll|bin|lockb|mp4|mov|psd)$/i;
export function isText(f) { return !BIN.test(f); }
export function read(repo, f) {
  // Refuses credential-like files by name; only tracked files are ever passed in.
  if (/(^|\/)\.env($|\.(?!example))/.test(f) || /master-session|transport-bots\.local/.test(f)) return '';
  try { return readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; }
}
export function lines(s) {
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n + (s.endsWith('\n') ? 0 : 1);
}
export function head(repo) { return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).toString().trim(); }
export function stripComments(s) {
  // Crude: removes /* */ blocks and whole-line // comments. Good enough for counting, not for parsing.
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
