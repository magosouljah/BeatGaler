'use strict';

const { normalizeEmail } = require('../email-verification-authority');

function createEmailVerificationFakePool(initialUsers = []) {
  const users = new Map(initialUsers.map(user => [String(user.id), { ...user }]));
  const verifications = new Map();
  const statements = [];

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    statements.push({ text, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [], rowCount: 0 };
    if (text.includes('FROM users u LEFT JOIN user_email_verifications v')) {
      const user = users.get(String(params[0]));
      if (!user) return { rows: [], rowCount: 0 };
      const verification = verifications.get(String(params[0])) || {};
      const uniqueEmail = [...users.values()].filter(row => normalizeEmail(row.email) === normalizeEmail(user.email)).length === 1;
      return { rows: [{ email: user.email, ...verification, unique_email: uniqueEmail }], rowCount: 1 };
    }
    if (text === 'SELECT email FROM users WHERE id=$1 FOR UPDATE' || text === 'SELECT email FROM users WHERE id=$1') {
      const user = users.get(String(params[0]));
      return { rows: user ? [{ email: user.email }] : [], rowCount: user ? 1 : 0 };
    }
    if (text.startsWith('INSERT INTO user_email_verifications')) {
      const id = String(params[0]);
      if (text.includes('ON CONFLICT(user_id) DO NOTHING') && verifications.has(id)) return { rows: [], rowCount: 0 };
      const previous = verifications.get(id);
      const verifiedAt = new Date(params[2]);
      const date = previous?.email_hash === params[1] && text.includes('LEAST(')
        ? new Date(Math.min(new Date(previous.verified_at).getTime(), verifiedAt.getTime()))
        : verifiedAt;
      verifications.set(id, { email_hash: String(params[1]), verified_at: date });
      return { rows: [{ user_id: id }], rowCount: 1 };
    }
    if (text === 'DELETE FROM user_email_verifications WHERE user_id=$1') {
      const removed = verifications.delete(String(params[0]));
      return { rows: [], rowCount: removed ? 1 : 0 };
    }
    if (text === 'SELECT session_key_hash FROM auth_sessions WHERE user_id=$1'
      || text.startsWith('UPDATE direct_capabilities SET status=')) return { rows: [], rowCount: 0 };
    if (text === 'DELETE FROM auth_sessions WHERE user_id=$1') return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected email verification SQL: ${text}`);
  }

  const client = { query, release() {} };
  return { users, verifications, statements, query, async connect() { return client; } };
}

module.exports = { createEmailVerificationFakePool };
