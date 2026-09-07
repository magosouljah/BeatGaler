import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = readFileSync(path.join(root, 'src-tauri', 'direct-transport', 'transport-helper.source.mjs'), 'utf8');
const fail = (message) => { console.error(`FAIL direct peer bootstrap: ${message}`); process.exit(1); };

const bindStart = helper.indexOf('async function bindFreshTemporarySession(reason)');
const bindEnd = helper.indexOf('async function ensureFreshTemporarySession', bindStart);
if (bindStart < 0 || bindEnd <= bindStart) fail('temporary-session bind block is missing.');
const bindBlock = helper.slice(bindStart, bindEnd);

if (!helper.includes('const transportStorage = new MemoryStorage();')) fail('Desktop no longer keeps one in-memory peer cache across temporary-auth renewals.');
if ((helper.match(/new MemoryStorage\(\)/g) || []).length !== 1) fail('Desktop recreates MemoryStorage instead of preserving the learned vault peer.');
if (!bindBlock.includes('storage: transportStorage')) fail('temporary clients do not share the peer cache.');
if (!/disableUpdates:\s*false/.test(bindBlock)) fail('temporary client disables the membership update needed to learn the private vault peer.');
if (!bindBlock.includes('await next.startUpdatesLoop()')) fail('temporary client does not start mtcute update processing before activation.');
if (bindBlock.includes('next.getChat(Number(session.chat_id))')) fail('vault resolution happens before Cloud activation can add the bot.');

const mainStart = helper.indexOf('async function main()');
if (mainStart < 0) fail('helper main lifecycle is missing.');
const mainBlock = helper.slice(mainStart);
const bound = mainBlock.indexOf('await bindFreshTemporarySession("initial")');
const listening = mainBlock.indexOf('op: "listening"');
const activated = mainBlock.indexOf('await nextControlCommand("activate_ready")');
const resolved = mainBlock.indexOf('getChat(Number(session.chat_id))');
if (!(bound >= 0 && bound < listening && listening < activated && activated < resolved)) {
  fail('vault peer must be resolved only after listening -> Cloud activation -> activate_ready.');
}
if (!/authKey:\s*imported\.authKey\.slice\(\)/.test(bindBlock)) fail('temporary auth-key ownership regression returned.');
if (!bindBlock.includes('imported.authKey.fill(0)')) fail('temporary auth handoff buffer is no longer zeroed.');

console.log('PASS direct peer bootstrap: updates learn the vault after activation and the peer cache survives temporary-auth renewal.');
