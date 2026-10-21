'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createStagedEmailChange,
  sha256,
} = require('../staged-email-change');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fakeDatabase() {
  const state = {
    user: { id: 'usr_1', email: 'old@example.com', username: 'tester#0001', username_source: 'beatgaler' },
    change: null,
    conflictEmail: null,
  };
  const events = [];
  let txSnapshot = null;

  function restore(snapshot) {
    state.user = snapshot.user;
    state.change = snapshot.change;
    state.conflictEmail = snapshot.conflictEmail;
  }

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    events.push(['sql', text, clone(params)]);
    if (text === 'BEGIN') {
      txSnapshot = clone(state);
      return { rows: [] };
    }
    if (text === 'COMMIT') {
      txSnapshot = null;
      return { rows: [] };
    }
    if (text === 'ROLLBACK') {
      if (txSnapshot) restore(txSnapshot);
      txSnapshot = null;
      return { rows: [] };
    }
    if (text.startsWith('SELECT id,email,username,username_source FROM users WHERE id=$1')) {
      return { rows: String(params[0]) === state.user.id ? [clone(state.user)] : [] };
    }
    if (text.startsWith('SELECT id FROM users WHERE lower(email)=lower($1) AND id<>$2')) {
      const target = String(params[0] || '').toLowerCase();
      const conflict = state.conflictEmail && String(state.conflictEmail).toLowerCase() === target;
      return { rows: conflict ? [{ id: 'usr_conflict' }] : [] };
    }
    if (text.startsWith('INSERT INTO auth_email_changes(')) {
      state.change = {
        user_id: String(params[0]),
        request_id: String(params[1]),
        old_email: String(params[2]),
        new_email: String(params[3]),
        token_hash: String(params[4]),
        state: 'PENDING',
        attempt_count: 0,
        delivery_count: 0,
        last_delivery_at: null,
        old_notice_attempts: 0,
        old_notice_sent_at: null,
        expires_at: new Date(params[5]).toISOString(),
        confirmed_at: null,
      };
      return { rows: [clone(state.change)] };
    }
    if (text.startsWith('UPDATE auth_email_changes SET delivery_count=delivery_count+1')) {
      if (state.change) {
        state.change.delivery_count += 1;
        state.change.last_delivery_at = new Date().toISOString();
      }
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM auth_email_changes WHERE user_id=$1 FOR UPDATE')) {
      return { rows: state.change && String(params[0]) === state.change.user_id ? [clone(state.change)] : [] };
    }
    if (text.startsWith("UPDATE auth_email_changes SET state='EXPIRED'")) {
      if (state.change) state.change.state = 'EXPIRED';
      return { rows: [] };
    }
    if (text.startsWith('UPDATE auth_email_changes SET request_id=$2,token_hash=$3,attempt_count=0,expires_at=$4')) {
      state.change.request_id = String(params[1]);
      state.change.token_hash = String(params[2]);
      state.change.attempt_count = 0;
      state.change.expires_at = new Date(params[3]).toISOString();
      return { rows: [clone(state.change)] };
    }
    if (text.startsWith('UPDATE auth_email_changes SET attempt_count=$2,state=CASE WHEN $2 >= $3')) {
      state.change.attempt_count = Number(params[1]);
      if (Number(params[1]) >= Number(params[2])) state.change.state = 'FAILED';
      return { rows: [] };
    }
    if (text.startsWith("UPDATE auth_email_changes SET state='CONFLICT'")) {
      state.change.state = 'CONFLICT';
      return { rows: [] };
    }
    if (text.startsWith('UPDATE users SET email=$2,updated_at=now() WHERE id=$1')) {
      events.push(['email-swap', String(params[0]), String(params[1])]);
      state.user.email = String(params[1]);
      return { rows: [] };
    }
    if (text.startsWith("UPDATE auth_email_changes SET state='CONFIRMED',confirmed_at=now()")) {
      state.change.state = 'CONFIRMED';
      state.change.confirmed_at = new Date().toISOString();
      return { rows: [] };
    }
    if (text.startsWith('UPDATE auth_email_changes SET old_notice_attempts=old_notice_attempts+1,old_notice_sent_at=now()')) {
      state.change.old_notice_attempts += 1;
      state.change.old_notice_sent_at = new Date().toISOString();
      return { rows: [] };
    }
    if (text.startsWith('UPDATE auth_email_changes SET old_notice_attempts=old_notice_attempts+1,updated_at=now()')) {
      state.change.old_notice_attempts += 1;
      return { rows: [] };
    }
    if (text.startsWith('SELECT user_id,old_email FROM auth_email_changes WHERE state=')) {
      const eligible = state.change?.state === 'CONFIRMED' && !state.change.old_notice_sent_at && state.change.old_notice_attempts < 10;
      return { rows: eligible ? [{ user_id: state.change.user_id, old_email: state.change.old_email }] : [] };
    }
    throw new Error(`Unexpected SQL in staged-email test: ${text}`);
  }

  const client = { query, release() {} };
  return {
    state,
    events,
    pool: {
      query,
      async connect() { return client; },
    },
  };
}

function harness({ nowMs = Date.parse('2026-10-21T22:30:00Z'), noticeFails = false } = {}) {
  const db = fakeDatabase();
  let clock = nowMs;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-email-change-'));
  const lifecycleState = { email_verified: {} };
  const stateFile = path.join(tmp, 'account-lifecycle-state.json');
  fs.writeFileSync(stateFile, JSON.stringify(lifecycleState));
  const deliveries = [];
  const localCommits = [];
  let flushes = 0;
  let revocations = 0;
  let failOldNotice = noticeFails;

  const user = { id: 'usr_1', email: 'old@example.com', username: 'tester#0001', usernameSource: 'beatgaler' };
  const runtime = {
    _test: {
      sessionInfoFromRequest(req) {
        return req?.session === false ? null : { userId: user.id, user, sessionHash: 'session_hash' };
      },
      consumeReauth(_req, token) {
        return token === 'reauth_good'
          ? { ok: true, info: { userId: user.id, user }, method: 'password' }
          : { ok: false, code: 'REAUTH_REQUIRED' };
      },
      async revokeUserSessions(userId, reason) {
        revocations += 1;
        db.events.push(['revoke', String(userId), String(reason)]);
        return 2;
      },
      stateSnapshot() { return lifecycleState; },
      stateFile,
    },
  };

  let randomCounter = 1;
  const service = createStagedEmailChange({
    pool: db.pool,
    runtime,
    emailNotifier: async input => {
      deliveries.push({ ...input });
      if (input.kind === 'email_changed_notice' && failOldNotice) {
        const error = new Error('notice failed');
        error.code = 'SES_SEND_FAILED';
        throw error;
      }
      return { delivered: true };
    },
    commitLocalEmail: async (userId, email) => {
      localCommits.push([userId, email]);
      user.email = email;
    },
    flushAuthority: async () => { flushes += 1; },
    now: () => clock,
    randomBytes: size => Buffer.alloc(size, (randomCounter++ % 250) + 1),
  });

  return {
    db,
    service,
    runtime,
    deliveries,
    localCommits,
    lifecycleState,
    stateFile,
    get revocations() { return revocations; },
    get flushes() { return flushes; },
    advance(ms) { clock += ms; },
    allowOldNotice() { failOldNotice = false; },
    req(reauth = 'reauth_good') { return { body: { reauthToken: reauth }, headers: {} }; },
  };
}

(async () => {
  // A stolen/ordinary session cannot even create a pending email change.
  {
    const h = harness();
    await assert.rejects(
      h.service.start(h.req('bad'), 'new@example.com'),
      error => error?.code === 'REAUTH_REQUIRED',
    );
    assert.equal(h.db.state.user.email, 'old@example.com');
    assert.equal(h.db.state.change, null);
    assert.equal(h.deliveries.length, 0);
  }

  // Start keeps the old email authoritative and stores only a token hash.
  {
    const h = harness();
    const started = await h.service.start(h.req(), 'NEW@example.com');
    assert.equal(started.pending, true);
    assert.equal(h.db.state.user.email, 'old@example.com');
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0].kind, 'email_change_confirmation');
    assert.equal(h.deliveries[0].to, 'new@example.com');
    const rawToken = h.deliveries[0].token;
    assert.ok(rawToken.startsWith('emc_'));
    assert.equal(h.db.state.change.token_hash, sha256(rawToken));
    assert.notEqual(h.db.state.change.token_hash, rawToken);

    await assert.rejects(
      h.service.confirm(h.req(), 'emc_wrong'),
      error => error?.code === 'EMAIL_CHANGE_INVALID',
    );
    assert.equal(h.db.state.user.email, 'old@example.com');
    assert.equal(h.revocations, 0);
    assert.equal(h.db.state.change.attempt_count, 1);
  }

  // Expiration leaves the old email untouched and never revokes sessions.
  {
    const h = harness();
    await h.service.start(h.req(), 'new@example.com');
    const token = h.deliveries[0].token;
    h.advance(16 * 60 * 1000);
    await assert.rejects(
      h.service.confirm(h.req(), token),
      error => error?.code === 'EMAIL_CHANGE_EXPIRED',
    );
    assert.equal(h.db.state.user.email, 'old@example.com');
    assert.equal(h.revocations, 0);
    assert.equal(h.db.state.change.state, 'EXPIRED');
  }

  // A second start invalidates the first token without touching the old email.
  {
    const h = harness();
    await h.service.start(h.req(), 'first@example.com');
    const first = h.deliveries.at(-1).token;
    await h.service.start(h.req(), 'second@example.com');
    const second = h.deliveries.at(-1).token;
    assert.notEqual(first, second);
    assert.equal(h.db.state.user.email, 'old@example.com');
    await assert.rejects(h.service.confirm(h.req(), first), error => error?.code === 'EMAIL_CHANGE_INVALID');
    assert.equal(h.db.state.user.email, 'old@example.com');
  }

  // A live uniqueness conflict appearing after start must not swap email.
  {
    const h = harness();
    await h.service.start(h.req(), 'new@example.com');
    const token = h.deliveries[0].token;
    h.db.state.conflictEmail = 'new@example.com';
    await assert.rejects(
      h.service.confirm(h.req(), token),
      error => error?.code === 'EMAIL_CHANGE_CONFLICT',
    );
    assert.equal(h.db.state.user.email, 'old@example.com');
  }

  // Successful confirm revokes before swap, changes the email once, marks the
  // new email verified, flushes authority, and notifies the previous address.
  {
    const h = harness();
    await h.service.start(h.req(), 'new@example.com');
    const token = h.deliveries[0].token;
    const result = await h.service.confirm(h.req(), token);
    assert.equal(result.ok, true);
    assert.equal(result.email, 'new@example.com');
    assert.equal(result.sessions_revoked, true);
    assert.equal(h.db.state.user.email, 'new@example.com');
    assert.equal(h.db.state.change.state, 'CONFIRMED');
    assert.equal(h.localCommits.length, 1);
    assert.equal(h.flushes, 1);
    const revokeIndex = h.db.events.findIndex(event => event[0] === 'revoke');
    const swapIndex = h.db.events.findIndex(event => event[0] === 'email-swap');
    assert.ok(revokeIndex >= 0 && swapIndex > revokeIndex);
    assert.equal(h.deliveries.at(-1).kind, 'email_changed_notice');
    assert.equal(h.deliveries.at(-1).to, 'old@example.com');
    assert.equal(h.lifecycleState.email_verified.usr_1.email_hash, sha256('new@example.com'));
    const persisted = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
    assert.equal(persisted.email_verified.usr_1.email_hash, sha256('new@example.com'));
  }

  // Failure to notify the old email must not roll back a confirmed identity;
  // the durable worker can deliver that warning later.
  {
    const h = harness({ noticeFails: true });
    await h.service.start(h.req(), 'new@example.com');
    const token = h.deliveries[0].token;
    const result = await h.service.confirm(h.req(), token);
    assert.equal(result.ok, true);
    assert.equal(result.old_email_notified, false);
    assert.equal(h.db.state.user.email, 'new@example.com');
    assert.equal(h.db.state.change.state, 'CONFIRMED');
    assert.equal(h.db.state.change.old_notice_sent_at, null);
    h.allowOldNotice();
    const delivered = await h.service.deliverPendingOldNotices();
    assert.equal(delivered, 1);
    assert.ok(h.db.state.change.old_notice_sent_at);
  }

  console.log('staged-email-change tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
