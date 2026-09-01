import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../src/features/cloud/webTransport.worker.ts', import.meta.url), 'utf8');
const protocol = await readFile(new URL('../src/features/cloud/webTransportWorkerProtocol.ts', import.meta.url), 'utf8');

assert.match(worker, /apiId:\s*0\b/, 'Web worker must not receive a permanent application API id.');
assert.match(worker, /apiHash:\s*""/, 'Web worker must not receive a permanent application API hash.');
assert.doesNotMatch(worker, /telegram_api_id|telegram_api_hash/i, 'Permanent application credentials must not enter the Web worker contract.');
assert.doesNotMatch(protocol, /telegram_api_id|telegram_api_hash|api_hash/i, 'Permanent application credentials must not enter the browser worker protocol.');

assert.match(worker, /await next\.connect\(\);\s*\n\s*installBoundTempRpcSeam\(next\);\s*\n\s*const self = await next\.getMe\(\);/, 'Bound-temp seam must be installed before the first application RPC.');
assert.match(worker, /connection\._session\.initConnectionCalled = true/, 'Bound temporary sessions must suppress mtcute initConnection wrapping.');
assert.match(worker, /network\._getOtherDc = async/, 'Additional DC managers must inherit the bound-temp seam.');
assert.match(worker, /network\.changePrimaryDc = async/, 'Primary DC changes must re-apply the bound-temp seam.');
assert.match(worker, /pool\.onUsable\?\.add/, 'Reconnects must re-apply the bound-temp seam.');

console.log('WEB_BOUND_TEMP_RPC_REGRESSION=PASS');
