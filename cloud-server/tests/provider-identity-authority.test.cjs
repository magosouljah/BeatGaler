'use strict';

const assert = require('node:assert/strict');
const { createProviderIdentityAuthority } = require('../provider-identity-authority');

function fakeDatabase() {
  const users = new Map([
    ['usr_a', { id: 'usr_a', username: 'pepito', username_source: 'x', email: null, password_hash: null, password_salt: null, created_at: new Date('2026-01-01T00:00:00Z') }],
    ['usr_b', { id: 'usr_b', username: 'other#1234', username_source: 'beatgaler', email: null, password_hash: null, password_salt: null, created_at: new Date('2026-01-02T00:00:00Z') }],
  ]);
  const providers = new Map([
    ['x:x-a', { user_id: 'usr_a', provider: 'x', provider_subject: 'x-a', profile: { id: 'x-a', username: 'pepito' } }],
    ['x:x-b', { user_id: 'usr_b', provider: 'x', provider_subject: 'x-b', profile: { id: 'x-b', username: 'other' } }],
  ]);
  const queries = [];

  function providerRow(provider, subject) {
    const p = providers.get(`${provider}:${subject}`);
    if (!p) return null;
    const u = users.get(p.user_id);
    return u ? { ...u, telegram_chat_id: null, vault_title: null, vault_created_at: null, profile: { ...p.profile } } : null;
  }

  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      queries.push([text, params]);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('FROM provider_identities p') && text.includes('JOIN users u')) {
        const row = providerRow(String(params[0]), String(params[1]));
        return { rows: row ? [row] : [] };
      }
      if (text.startsWith('SELECT id,username,username_source,email,password_hash,password_salt,created_at FROM users')) {
        const handle = String(params[0]).toLowerCase();
        return { rows: [...users.values()].filter(user => String(user.username || '').toLowerCase() === handle).map(user => ({ ...user })) };
      }
      if (text.startsWith("SELECT provider_subject FROM provider_identities WHERE user_id=$1 AND provider='x'")) {
        return { rows: [...providers.values()].filter(p => p.user_id === String(params[0]) && p.provider === 'x').map(p => ({ provider_subject: p.provider_subject })) };
      }
      if (text.startsWith('SELECT id FROM users WHERE lower(username)=lower($1) AND id<>$2')) {
        const candidate = String(params[0]).toLowerCase();
        const except = String(params[1]);
        return { rows: [...users.values()].filter(user => user.id !== except && String(user.username || '').toLowerCase() === candidate).map(user => ({ id: user.id })) };
      }
      if (text.startsWith("UPDATE users SET username=$2,username_source='beatgaler'")) {
        const user = users.get(String(params[0]));
        user.username = String(params[1]);
        user.username_source = 'beatgaler';
        return { rows: [] };
      }
      if (text.startsWith("UPDATE users SET username=$2,username_source='x'")) {
        const user = users.get(String(params[0]));
        user.username = String(params[1]);
        user.username_source = 'x';
        return { rows: [] };
      }
      if (text.startsWith('UPDATE provider_identities SET profile=')) {
        const p = providers.get(`${params[0]}:${params[1]}`);
        p.profile = { ...(p.profile || {}), ...JSON.parse(String(params[2])) };
        return { rows: [] };
      }
      if (text.startsWith('SELECT id FROM users WHERE lower(email)=lower($1)')) return { rows: [] };
      throw new Error(`Unexpected SQL in test: ${text}`);
    },
    release() {},
  };

  return {
    users,
    providers,
    queries,
    pool: { async connect() { return client; } },
  };
}

(async () => {
  {
    const db = fakeDatabase();
    const bridgeCalls = [];
    const authority = createProviderIdentityAuthority({
      pool: db.pool,
      getBridge: () => ({
        setUsernameByUserId(userId, username, source) { bridgeCalls.push(['rename', userId, username, source]); },
        adoptIdentityUser(input) { bridgeCalls.push(['adopt', input.id, input.username, input.usernameSource, input.providerSubject]); },
      }),
    });

    const result = await authority.prepareX({
      identity: { id: 'x-b', username: 'pepito', name: 'B' },
      registrationOpen: false,
    });

    assert.equal(result.allow, true);
    assert.equal(result.existingUserId, 'usr_b');
    assert.match(db.users.get('usr_a').username, /^pepito#\d{4}$/);
    assert.equal(db.users.get('usr_a').username_source, 'beatgaler');
    assert.equal(db.users.get('usr_b').username, 'pepito');
    assert.equal(db.users.get('usr_b').username_source, 'x');
    assert.equal(db.providers.get('x:x-b').profile.username, 'pepito');
    assert.deepEqual(bridgeCalls[0].slice(0, 2), ['rename', 'usr_a']);
    assert.deepEqual(bridgeCalls[1], ['adopt', 'usr_b', 'pepito', 'x', 'x-b']);
    assert.equal(db.users.has('usr_a'), true);
    assert.equal(db.users.has('usr_b'), true);
    assert.equal(db.queries.some(([sql]) => sql === 'COMMIT'), true);
  }

  {
    const db = fakeDatabase();
    const authority = createProviderIdentityAuthority({ pool: db.pool });
    await assert.rejects(
      authority.prepareX({ identity: { id: 'x-new', username: 'fresh' }, registrationOpen: false }),
      error => error?.code === 'PUBLIC_REGISTRATION_CLOSED',
    );
    assert.equal(db.queries.some(([sql]) => sql === 'ROLLBACK'), true);
  }

  console.log('provider-identity-authority tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
