import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../src/features/cloud/webTransport.worker.ts', import.meta.url), 'utf8');
const protocol = await readFile(new URL('../src/features/cloud/webTransportWorkerProtocol.ts', import.meta.url), 'utf8');
const session = await readFile(new URL('../src/features/cloud/webTransportSession.ts', import.meta.url), 'utf8');
const tempAuth = await readFile(new URL('../src/features/cloud/webTempAuth.ts', import.meta.url), 'utf8');
const boundary = await readFile(new URL('../cloud-server/productive-temp-auth-boundary.js', import.meta.url), 'utf8');

assert.match(worker, /apiId:\s*temp_api_id\b/, 'Web worker must use the controlled public application id for post-bind initConnection.');
assert.match(worker, /apiHash:\s*""/, 'Application API hash must not enter the Web worker.');
assert.doesNotMatch(worker, /telegram_api_hash|bot_token|permanentKeyBytes/i, 'Permanent secrets must not enter the Web worker contract.');
assert.doesNotMatch(protocol, /telegram_api_hash|api_hash|bot_token/i, 'Permanent secrets must not enter the browser worker protocol.');
assert.match(boundary, /telegram_api_hash:\s*_apiHash/, 'Controlled boundary must continue stripping the API hash.');
assert.match(boundary, /api_id:\s*state\.apiId/, 'Controlled boundary must provide only the numeric application id needed by initConnection.');

assert.match(protocol, /temp_session_id/, 'Worker protocol must preserve the bound temporary MTProto session id.');
assert.match(protocol, /temp_session_state/, 'Worker protocol must carry the bound MTProto session state.');
assert.match(protocol, /temp_api_id/, 'Worker protocol must carry the numeric application id without the API hash.');
assert.match(session, /temp_session_id:\s*prepared\.metadata\.tempSessionId/, 'Session bridge must retain the exact id used by auth.bindTempAuthKey.');
assert.match(session, /temp_session_state:\s*imported\.sessionState/, 'Session bridge must retain the protocol state created by auth.bindTempAuthKey.');

for (const field of ['seqNo', 'lastMessageId', 'timeOffset', 'serverSalt', 'queuedAcks', 'bindMsgId']) {
  assert.match(tempAuth, new RegExp(`${field}:`), `Temporary-auth binder must export ${field}.`);
}
assert.match(worker, /applyBoundTempSessionState\(/, 'Worker must restore the bound MTProto state before connecting.');
assert.match(worker, /session\._sessionId\s*=\s*restoreLong/, 'Worker must restore the cryptographically bound session id.');
assert.match(worker, /session\._seqNo\s*=\s*state\.seqNo/, 'Worker must continue the bound content-related sequence counter.');
assert.match(worker, /session\._lastMessageId\s*=\s*restoreLong/, 'Worker must continue the bound outgoing message-id floor.');
assert.match(worker, /session\._timeOffset\s*=\s*state\.timeOffset/, 'Worker must retain the authorization time offset.');
assert.match(worker, /salts\.currentSalt\s*=\s*restoreLong/, 'Worker must restore the temporary-key server salt.');
assert.match(worker, /session\.queuedAcks\s*=\s*state\.queuedAcks/, 'Worker must carry the bind-result acknowledgement across the Worker handoff.');
assert.match(worker, /session\.initConnectionCalled\s*=\s*false/, 'Bound temporary sessions must issue initConnection after binding.');
assert.match(worker, /installBoundTempConnectHook\(temp_session_id, temp_session_state, primaryDcId\);[\s\S]*await next\.connect\(\);/, 'Bound session state must be installed before opening the productive socket.');
assert.doesNotMatch(worker, /session\.resetState\s*=\s*\(/, 'Worker must not override resetState to reuse a session id queued for destruction.');
assert.doesNotMatch(worker, /initConnectionCalled\s*=\s*true/, 'Worker must not suppress post-bind initConnection.');

console.log('WEB_BOUND_TEMP_RPC_REGRESSION=PASS');
