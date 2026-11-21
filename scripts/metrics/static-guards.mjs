// static-guards.mjs <repo>
// Statically evaluates (string/regex inclusion only) the assertions of three source-text guards that run ONLY in
// pull_request workflows, WITHOUT executing them:
//   scripts/regression-direct-manager-only.test.mjs   (mutation anchors)      -> direct-persistent-vault-assignment.yml
//   scripts/regression-web-startup-bridge.mjs         (includes needles)      -> web-production-build.yml
//   scripts/regression-web-bound-temp-rpc.mjs         (regex match/doesNotMatch) -> web-production-build.yml, probe-task-5.1
// Read-only. It PARSES array/regex/string LITERALS from those tracked files (no eval/Function/vm); a non-literal is reported as "no evaluable". It never imports them.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { repoArg, head } from './lib.mjs';
const repo = repoArg();
const rd = f => readFileSync(path.join(repo, f), 'utf8');
const has = f => existsSync(path.join(repo, f));
// Literal-only parser (no eval/Function/vm): arrays, '...' / "..." strings, /re/flags, comments, trailing commas.
// Anything else throws NotLiteral; callers report it as "no evaluable" instead of executing it.
class NotLiteral extends Error {}
const ESC = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
function lit(src) {
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; }
      else if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); if (e < 0) throw new NotLiteral('comment'); i = e + 2; }
      else return;
    }
  };
  const str = q => {
    let o = ''; i++;
    for (;;) {
      const c = src[i++];
      if (c === undefined) throw new NotLiteral('string');
      if (c === q) return o;
      if (c === '\\') {
        const d = src[i++];
        if (d === 'x') { o += String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2; }
        else if (d === 'u') { if (src[i] === '{') throw new NotLiteral('u{}'); o += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; }
        else if (d === '\n') { /* line continuation */ }
        else o += d in ESC ? ESC[d] : d;
      } else if (c === '\n') throw new NotLiteral('newline in string');
      else o += c;
    }
  };
  const val = () => {
    ws(); const c = src[i];
    if (c === '[') {
      i++; const a = [];
      for (;;) {
        ws(); if (src[i] === ']') { i++; return a; }
        a.push(val()); ws();
        if (src[i] === ',') i++; else if (src[i] !== ']') throw new NotLiteral('array');
      }
    }
    if (c === "'" || c === '"') return str(c);
    if (c === '/') {
      let j = i + 1, cls = false;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === '\\') j++; else if (d === '[') cls = true; else if (d === ']') cls = false;
        else if (d === '/' && !cls) break; else if (d === '\n') throw new NotLiteral('regex');
      }
      const body = src.slice(i + 1, j); i = j + 1;
      const m = /^[a-z]*/.exec(src.slice(i)); i += m[0].length;
      try { return new RegExp(body, m[0]); } catch { throw new NotLiteral('regex'); }
    }
    throw new NotLiteral('token ' + JSON.stringify(src.slice(i, i + 12)));
  };
  const v = val(); ws();
  if (i !== src.length) throw new NotLiteral('trailing');
  return v;
}
const noEval = (what, e) => console.log(what + ': no evaluable (' + (e && e.message) + ')');
console.log('HEAD ' + head(repo));

{ // 1) mutation anchors
  const t = rd('scripts/regression-direct-manager-only.test.mjs');
  const a = t.indexOf('const mutations = ['), b = t.indexOf('\n];', a);
  let arr = null; try { arr = lit(t.slice(a + 'const mutations = '.length, b + 2)); } catch (e) { noEval('regression-direct-manager-only.test.mjs', e); }
  if (arr) {
  const missing = arr.filter(([, file, orig]) => !(has(file) && rd(file).includes(orig)));
  console.log('regression-direct-manager-only.test.mjs: anchors=' + arr.length + ' missing=' + missing.length);
  for (const [label, file] of missing) console.log('  MISSING ANCHOR: ' + label + '  [' + file + ']');
  }
}
{ // 2) includes needles
  const s = rd('scripts/regression-web-startup-bridge.mjs');
  const vars = {};
  for (const m of s.matchAll(/^const (\w+) = fs\.readFileSync\("([^"]+)"/gm)) vars[m[1]] = m[2];
  let n = 0; const bad = [];
  for (const m of s.matchAll(/^expect\((\w+), ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"), /gm)) {
    n++; let needle; try { needle = lit(m[2]); } catch (e) { bad.push('no evaluable needle: ' + m[2].slice(0, 50)); continue; } const f = vars[m[1]];
    if (!has(f)) bad.push('file missing: ' + f); else if (!rd(f).includes(needle)) bad.push(f + ' lacks: ' + needle.slice(0, 70).replace(/\n/g, '\\n'));
  }
  console.log('regression-web-startup-bridge.mjs: needles=' + n + ' missing=' + bad.length + '  (checkout line endings matter: needles contain \\n)');
  bad.forEach(x => console.log('  ' + x));
  for (const f of Object.values(vars)) if (has(f)) console.log('  ' + f + ' CRLF=' + /\r\n/.test(rd(f)));
}
{ // 3) regex assertions
  const s = rd('scripts/regression-web-bound-temp-rpc.mjs');
  const vars = {};
  for (const m of s.matchAll(/^const (\w+) = await readFile\(new URL\('\.\.\/([^']+)'/gm)) vars[m[1]] = m[2];
  let n = 0; const bad = [];
  for (const m of s.matchAll(/^assert\.(match|doesNotMatch)\((\w+), (\/.*\/[a-z]*), '/gm)) {
    n++; let re; try { re = lit(m[3]); } catch (e) { bad.push('no evaluable regex: ' + m[3].slice(0, 50)); continue; } const f = vars[m[2]];
    if (!has(f)) { bad.push('file missing: ' + f); continue; }
    if ((m[1] === 'match') !== re.test(rd(f))) bad.push(m[1] + ' ' + f + ' ' + m[3].slice(0, 70));
  }
  const fields = /for \(const field of (\[[^\]]+\])\)/.exec(s);
  let fl = []; if (fields) { try { fl = lit(fields[1]); } catch (e) { bad.push('no evaluable field list'); } }
  for (const field of fl) { n++; if (!new RegExp(field + ':').test(rd(vars.tempAuth))) bad.push('tempAuth lacks ' + field); }
  console.log('regression-web-bound-temp-rpc.mjs: assertions=' + n + ' failing=' + bad.length);
  bad.forEach(x => console.log('  ' + x));
}
