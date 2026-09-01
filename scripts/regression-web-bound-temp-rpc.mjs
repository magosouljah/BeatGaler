import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../src/features/cloud/webTransport.worker.ts', import.meta.url), 'utf8');
const protocol = await readFile(new URL('../src/features/cloud/webTransportWorkerProtocol.ts', import.meta.url), 'utf8');
const session = await readFile(new URL('../src/features/cloud/webTransportSession.ts', import.meta.url), 'utf8');

assert.match(worker, /apiId:\s*0\b/, 'Web worker must not receive a permanent application API id.');
assert.match(worker, /apiHash:\s*""/, 'Web worker must not receive a permanent application API hash.');
assert.doesNotMatch(worker, /telegram_api_id|telegram_api_hash/i, 'Permanent application credentials must not enter the Web worker contract.');
assert.doesNotMatch(protocol, /telegram_api_id|telegram_api_hash|api_hash/i, 'Permanent application credentials must not enter the browser worker protocol.');

assert.match(protocol, /temp_session_id/, 'Worker protocol must preserve the bound temporary MTProto session id.');
assert.match(session, /temp_session_id:\s*prepared\.metadata\.tempSessionId/, 'Session bridge must retain the exact id used by auth.bindTempAuthKey.');
assert.match(worker, /installBoundTempConnectHook\(temp_session_id, primaryDcId\);[\s\S]*await next\.connect\(\);/, 'Bound session id hook must be installed before opening the socket.');
assert.match(worker, /session\._sessionId = new LongCtor\(sessionId\.low, sessionId\.high, sessionId\.unsigned\)/, 'Primary connection must reuse the session id that was cryptographically bound.');
assert.match(worker, /session\.resetState = \(\.\.\.args: any\[\]\) =>/, 'Session resets must restore the bound temporary session id.');
assert.match(worker, /session\.initConnectionCalled = true/, 'Bound temporary sessions must suppress mtcute initConnection wrapping.');
assert.match(worker, /markBoundTempPool\(manager\.main, sessionId\)/, 'Only the bound primary MAIN pool may inherit this temporary-session seam.');
assert.match(worker, /pool\.onUsable\?\.add/, 'Reconnects must re-apply the bound-temp seam.');

console.log('WEB_BOUND_TEMP_RPC_REGRESSION=PASS');
