'use strict';

const crypto = require('node:crypto');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function shortFingerprint(kind, value) {
  return `${kind}:${sha256(`${kind}\0${String(value || '')}`).slice(0, 16)}`;
}

function usablePassword(user, lifecycleState = {}) {
  const direct = String(user?.password_hash || user?.passwordHash || '').trim();
  const override = lifecycleState?.password_overrides?.[String(user?.id || '')];
  return Boolean(direct || String(override?.passwordHash || override?.password_hash || '').trim());
}

function verifiedEmail(user) {
  const email = normalizeEmail(user?.email);
  if (!email) return false;
  return Boolean(user?.verified_email_hash && user.verified_email_hash === sha256(email));
}

function groupDuplicates(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const current = groups.get(key) || [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups.entries()].filter(([, group]) => group.length > 1);
}

function analyzeIdentityPreflight({ users = [], providers = [], lifecycleState = {} } = {}) {
  const liveUsers = Array.isArray(users) ? users.filter(Boolean) : [];
  const identities = Array.isArray(providers) ? providers.filter(Boolean) : [];
  const usernameCollisions = groupDuplicates(liveUsers, row => normalizeUsername(row.username));
  const emailCollisions = groupDuplicates(liveUsers, row => normalizeEmail(row.email));
  const providerSubjectCollisions = groupDuplicates(identities, row => {
    const provider = String(row?.provider || '').trim().toLowerCase();
    const subject = String(row?.provider_subject || row?.providerSubject || '').trim();
    return provider && subject ? `${provider}\0${subject}` : '';
  });
  const userProviderMultiples = groupDuplicates(identities, row => {
    const userId = String(row?.user_id || row?.userId || '').trim();
    const provider = String(row?.provider || '').trim().toLowerCase();
    return userId && provider ? `${userId}\0${provider}` : '';
  });

  const passwordUsers = liveUsers.filter(user => usablePassword(user, lifecycleState));
  const passwordWithoutEmail = passwordUsers.filter(user => !normalizeEmail(user.email));
  const passwordUnverifiedEmail = passwordUsers.filter(user => normalizeEmail(user.email) && !verifiedEmail(user));
  const xTokenRows = identities.filter(row => String(row?.provider || '').toLowerCase() === 'x'
    && (row?.access_token_ciphertext != null || row?.refresh_token_ciphertext != null));

  const blockers = [];
  for (const [key, group] of usernameCollisions) blockers.push({
    code: 'USERNAME_CASEFOLD_COLLISION',
    fingerprint: shortFingerprint('username', key),
    user_ids: group.map(row => String(row.id)).sort(),
  });
  for (const [key, group] of emailCollisions) blockers.push({
    code: 'EMAIL_CASEFOLD_COLLISION',
    fingerprint: shortFingerprint('email', key),
    user_ids: group.map(row => String(row.id)).sort(),
  });
  for (const [key, group] of providerSubjectCollisions) blockers.push({
    code: 'PROVIDER_SUBJECT_COLLISION',
    fingerprint: shortFingerprint('provider-subject', key),
    user_ids: [...new Set(group.map(row => String(row.user_id || row.userId)))].sort(),
  });
  for (const user of passwordWithoutEmail) blockers.push({
    code: 'PASSWORD_WITHOUT_EMAIL',
    user_ids: [String(user.id)],
  });
  for (const user of passwordUnverifiedEmail) blockers.push({
    code: 'PASSWORD_EMAIL_UNVERIFIED',
    user_ids: [String(user.id)],
  });

  const warnings = [];
  for (const [key, group] of userProviderMultiples) warnings.push({
    code: 'MULTIPLE_PROVIDER_IDENTITIES_FOR_USER',
    fingerprint: shortFingerprint('user-provider', key),
    user_ids: [...new Set(group.map(row => String(row.user_id || row.userId)))].sort(),
    identity_count: group.length,
  });
  if (xTokenRows.length) warnings.push({
    code: 'LEGACY_X_TOKENS_PRESENT',
    user_ids: [...new Set(xTokenRows.map(row => String(row.user_id || row.userId)))].sort(),
    identity_count: xTokenRows.length,
  });

  const passwordReady = passwordUsers.length - passwordWithoutEmail.length - passwordUnverifiedEmail.length;
  return {
    schema: 'beatgaler-auth-identity-preflight/v1',
    ready: blockers.length === 0,
    counts: {
      users: liveUsers.length,
      provider_identities: identities.length,
      password_users: passwordUsers.length,
      password_email_ready: Math.max(0, passwordReady),
      username_casefold_collision_groups: usernameCollisions.length,
      email_casefold_collision_groups: emailCollisions.length,
      provider_subject_collision_groups: providerSubjectCollisions.length,
      user_provider_multiple_groups: userProviderMultiples.length,
      password_without_email: passwordWithoutEmail.length,
      password_email_unverified: passwordUnverifiedEmail.length,
      legacy_x_token_identities: xTokenRows.length,
    },
    blockers,
    warnings,
  };
}

module.exports = {
  normalizeEmail,
  normalizeUsername,
  sha256,
  shortFingerprint,
  usablePassword,
  verifiedEmail,
  groupDuplicates,
  analyzeIdentityPreflight,
};
