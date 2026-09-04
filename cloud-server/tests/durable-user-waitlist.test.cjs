'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDurableUserWaitlist } = require('../durable-user-waitlist');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-waitlist-'));
const file = path.join(dir, 'waitlist.json');
let clock = 1_800_000_000_000;
const make = () => createDurableUserWaitlist({ file, now: () => ++clock });

const first = make();
const a = first.enqueue({ tenantId: 'tenant-a', userId: 'user-1' });
const duplicate = first.enqueue({ tenantId: 'tenant-a', userId: 'user-1' });
const b = first.enqueue({ tenantId: 'tenant-a', userId: 'user-2' });
first.enqueue({ tenantId: 'tenant-b', userId: 'user-1' });
assert.equal(a.inserted, true);
assert.equal(duplicate.inserted, false);
assert.equal(duplicate.entry.id, a.entry.id);
assert.deepEqual(first.list({ tenantId: 'tenant-a' }).map(x => x.user_id), ['user-1', 'user-2']);

const restarted = make();
assert.deepEqual(restarted.list({ tenantId: 'tenant-a' }).map(x => x.user_id), ['user-1', 'user-2']);
assert.deepEqual(restarted.list({ tenantId: 'tenant-b' }).map(x => x.user_id), ['user-1']);
const claimed = restarted.claimNext({ tenantId: 'tenant-a' });
assert.equal(claimed.id, a.entry.id);
assert.equal(restarted.claimNext({ tenantId: 'tenant-a' }).id, b.entry.id);
assert.equal(restarted.dequeue({ id: claimed.id, tenantId: 'tenant-b' }), false);
assert.equal(restarted.dequeue({ id: claimed.id, tenantId: 'tenant-a' }), true);
assert.equal(restarted.recoverClaims({ olderThanMs: 0 }), 1);
assert.equal(restarted.claimNext({ tenantId: 'tenant-a' }).id, b.entry.id);

const persisted = fs.readFileSync(file, 'utf8');
for (const forbidden of ['token', 'secret', 'media', 'payload', 'storageChatId']) assert.equal(persisted.includes(forbidden), false);

fs.writeFileSync(file, '{broken', 'utf8');
assert.throws(() => make().list({ tenantId: 'tenant-a' }), err => err.code === 'WAITLIST_CORRUPT');

fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ id: 'x', tenant_id: 't', user_id: 'u', enqueued_at: 1, claimed_at: null, token: 'nope' }] }), 'utf8');
assert.throws(() => make().readState(), err => err.code === 'WAITLIST_UNSAFE_RECORD');

console.log('durable-user-waitlist: PASS');
