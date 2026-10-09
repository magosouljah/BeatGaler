'use strict';

function createPlanMeHandler({ getUser, bearerToken, resolveUserPlan }) {
  return async (req, res) => {
    const user = getUser(bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    return res.json({ ok: true, plan: await resolveUserPlan(user) });
  };
}

async function accountPublicPayload(user, token, { resolveUserPlan, userProvider }) {
  const plan = await resolveUserPlan(user);
  const google = userProvider(user, 'google');
  const x = userProvider(user, 'x');
  return {
    ok: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      username_source: user.usernameSource || 'beatgaler',
      official_username: user.usernameSource === 'x',
      email: user.email || null,
      storage_ready: !!user.storageChatId,
      has_password: !!user.passwordHash,
      mfa_enabled: !!user.mfaSecret,
      plan,
      providers: {
        google: google ? { connected: true, email: google.email || null, name: google.name || null } : { connected: false },
        x: x ? { connected: true, username: x.username || null, name: x.name || null } : { connected: false },
      },
    },
  };
}

function createAccountHandler({ getUser, bearerToken, resolveUserPlan, userProvider, syncIdentity = async () => {} }) {
  return async (req, res) => {
    const token = bearerToken(req);
    const user = getUser(token);
    if (!user) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    await syncIdentity(user).catch(() => false);
    return res.json(await accountPublicPayload(user, token, { resolveUserPlan, userProvider }));
  };
}

module.exports = { createPlanMeHandler, createAccountHandler, accountPublicPayload };
