'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

function d8LifecycleEnv(env = process.env) {
  return { ...env, BEATGALER_ACCOUNT_TOMBSTONE_RETENTION_DAYS: '0' };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ro-d8-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function purgeRecoverableTombstones(runtime) {
  const state = runtime?._test?.stateSnapshot?.();
  const deletedIds = runtime?._test?.deletedUserIds;
  const stateFile = runtime?._test?.stateFile;
  if (!state || !deletedIds || !stateFile) return;
  const legacyIds = Object.keys(state.tombstones || {});
  for (const userId of legacyIds) deletedIds.add(String(userId));
  state.tombstones = {};
  atomicWriteJson(stateFile, state);
  runtime._test.scrubAccountsFile?.();
  runtime._test.scrubCloudFile?.();
}

function installImmediateAccountDeletion(runtime, { randomBytes = size => crypto.randomBytes(size), now = () => Date.now() } = {}) {
  if (!runtime?._test || runtime.__beatgalerD8ImmediateDeleteInstalled) return runtime;
  runtime.__beatgalerD8ImmediateDeleteInstalled = true;
  purgeRecoverableTombstones(runtime);
  runtime.retentionConfigured = true;

  runtime._test.deleteAccount = async function deleteAccountImmediate(req, res) {
    const grant = runtime._test.consumeReauth(req, String(req?.body?.reauthToken || req?.headers?.['x-beatgaler-reauth'] || ''));
    if (!grant.ok) return res.status(401).json({ error: 'Recent reauthentication is required.', code: grant.code });
    const userId = grant.info.userId;
    try {
      await runtime._test.revokeUserSessions(userId, 'account_delete');
    } catch {
      return res.status(503).json({ error: 'Account deletion could not safely revoke active sessions.', code: 'DIRECT_CAPABILITY_REVOKE_FAILED' });
    }

    const deletedAt = now();
    const receiptId = `delete_${randomBytes(12).toString('hex')}`;
    runtime._test.deletedUserIds.add(userId);
    const state = runtime._test.stateSnapshot();
    delete state.tombstones[userId];
    delete state.email_verified[userId];
    delete state.recovery[userId];
    delete state.password_overrides[userId];
    delete state.notifications[userId];
    for (const [hash, entry] of Object.entries(state.reauth || {})) if (entry?.user_id === userId) delete state.reauth[hash];
    for (const [hash, entry] of Object.entries(state.tokens || {})) if (entry?.user_id === userId) delete state.tokens[hash];
    atomicWriteJson(runtime._test.stateFile, state);
    runtime._test.scrubAccountsFile();
    runtime._test.scrubCloudFile();

    const timestamp = new Date(deletedAt).toISOString();
    return res.json({
      ok: true,
      deleted: true,
      receipt: {
        id: receiptId,
        deleted_at: timestamp,
        purge_at: timestamp,
        retention_days: 0,
        recoverable_tombstone: false,
        provider_cleanup: 'local_credentials_removed',
      },
    });
  };
  return runtime;
}

function resolveReauthTtlMs(env) {
  const parsed = Number(env.BEATGALER_REAUTH_TTL_MS);
  const picked = Number.isFinite(parsed) ? parsed : 5 * 60 * 1000;
  return Math.max(60 * 1000, Math.min(15 * 60 * 1000, picked));
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'google' || provider === 'x') return provider;
  return '';
}

function oauthProviderConfig(env, provider) {
  const base = String(env.BEATGALER_OAUTH_PUBLIC_BASE || env.BEATGALER_PUBLIC_BASE || '').replace(/\/$/, '');
  if (!base) throw Object.assign(new Error('BeatGaler OAuth public base is not configured.'), { code: 'OAUTH_CONFIG_REQUIRED' });
  if (provider === 'google') {
    const clientId = String(env.GOOGLE_CLIENT_ID || '');
    const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '');
    if (!clientId || !clientSecret) throw Object.assign(new Error('Google OAuth is not configured.'), { code: 'OAUTH_CONFIG_REQUIRED' });
    return {
      clientId,
      clientSecret,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      identityUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      callbackUrl: `${base}/auth/oauth/google/callback`,
    };
  }
  if (provider === 'x') {
    const clientId = String(env.X_CLIENT_ID || '');
    const clientSecret = String(env.X_CLIENT_SECRET || '');
    if (!clientId) throw Object.assign(new Error('X OAuth is not configured.'), { code: 'OAUTH_CONFIG_REQUIRED' });
    return {
      clientId,
      clientSecret,
      authUrl: 'https://x.com/i/oauth2/authorize',
      tokenUrl: 'https://api.x.com/2/oauth2/token',
      identityUrl: 'https://api.x.com/2/users/me?user.fields=name,username,profile_image_url',
      callbackUrl: `${base}/auth/oauth/x/callback`,
    };
  }
  throw Object.assign(new Error('Unsupported OAuth provider.'), { code: 'PROVIDER_REAUTH_UNAVAILABLE' });
}

async function postForm(fetchImpl, url, values, headers = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(values).toString(),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw Object.assign(new Error('OAuth token exchange failed.'), { code: 'PROVIDER_REAUTH_FAILED' });
  return body;
}

async function fetchIdentity(fetchImpl, provider, cfg, accessToken) {
  const response = await fetchImpl(cfg.identityUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await response.json();
  if (provider === 'google') {
    if (!response.ok || !body?.sub) throw Object.assign(new Error('Google identity could not be verified.'), { code: 'PROVIDER_REAUTH_FAILED' });
    return { id: String(body.sub) };
  }
  if (!response.ok || !body?.data?.id) throw Object.assign(new Error('X identity could not be verified.'), { code: 'PROVIDER_REAUTH_FAILED' });
  return { id: String(body.data.id) };
}

function createProviderReauthCoordinator(runtime, {
  env = process.env,
  fetchImpl = global.fetch,
  now = () => Date.now(),
  randomBytes = size => crypto.randomBytes(size),
} = {}) {
  const pending = new Map();
  const completed = new Map();
  const reauthTtlMs = resolveReauthTtlMs(env);

  function cleanup() {
    const current = now();
    for (const [key, value] of pending) if (Number(value?.expiresAt || 0) <= current) pending.delete(key);
    for (const [key, value] of completed) if (Number(value?.expiresAt || 0) <= current) completed.delete(key);
  }

  function start(req, res, next) {
    if (String(req?.body?.purpose || '').toLowerCase() !== 'reauth') return next();
    cleanup();
    const info = runtime._test.sessionInfoFromRequest(req);
    if (!info) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'SESSION_REQUIRED' });
    const provider = normalizeProvider(req?.body?.provider);
    const providerRecord = provider ? info.user?.providers?.[provider] : null;
    if (!providerRecord?.id) {
      return res.status(409).json({ error: 'The requested provider is not connected to this account.', code: 'PROVIDER_REAUTH_UNAVAILABLE' });
    }

    let cfg;
    try { cfg = oauthProviderConfig(env, provider); }
    catch (error) { return res.status(503).json({ error: 'Provider reauthentication is unavailable.', code: error.code || 'OAUTH_CONFIG_REQUIRED' }); }

    const flowId = randomBytes(24).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const flow = {
      flowId,
      state,
      provider,
      userId: info.userId,
      sessionHash: info.sessionHash,
      expectedProviderId: String(providerRecord.id),
      expiresAt: now() + OAUTH_FLOW_TTL_MS,
    };
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.callbackUrl,
      response_type: 'code',
      state,
    });
    if (provider === 'google') {
      params.set('scope', 'openid email profile');
      params.set('prompt', 'login');
    } else {
      const verifier = randomBytes(48).toString('base64url');
      flow.codeVerifier = verifier;
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      params.set('scope', 'tweet.read users.read offline.access');
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
      // X OAuth 2.0 reauth uses a fresh PKCE authorization-code round trip.
      // Do not invent unsupported force-login parameters.
    }
    pending.set(state, flow);
    return res.json({ ok: true, purpose: 'reauth', flow_id: flowId, authorization_url: `${cfg.authUrl}?${params.toString()}` });
  }

  async function callback(req, res, next) {
    cleanup();
    const provider = normalizeProvider(req?.params?.provider);
    const state = String(req?.query?.state || '');
    const flow = pending.get(state);
    if (!flow) return next();
    pending.delete(state);
    if (!provider || provider !== flow.provider) return res.status(400).send('BeatGaler reauthentication request is invalid.');
    try {
      if (req?.query?.error) throw Object.assign(new Error('Provider reauthentication was not completed.'), { code: 'PROVIDER_REAUTH_FAILED' });
      const code = String(req?.query?.code || '');
      if (!code) throw Object.assign(new Error('Provider reauthentication code is missing.'), { code: 'PROVIDER_REAUTH_FAILED' });
      const cfg = oauthProviderConfig(env, provider);
      const form = { grant_type: 'authorization_code', code, redirect_uri: cfg.callbackUrl, client_id: cfg.clientId };
      const headers = {};
      if (provider === 'google') form.client_secret = cfg.clientSecret;
      if (provider === 'x') {
        form.code_verifier = flow.codeVerifier;
        if (cfg.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
      }
      const tokenBody = await postForm(fetchImpl, cfg.tokenUrl, form, headers);
      const identity = await fetchIdentity(fetchImpl, provider, cfg, String(tokenBody.access_token || ''));
      const user = runtime._test.userById(flow.userId);
      const currentProviderId = String(user?.providers?.[provider]?.id || '');
      if (!user || !currentProviderId || currentProviderId !== flow.expectedProviderId || identity.id !== flow.expectedProviderId) {
        throw Object.assign(new Error('Provider identity did not match the account.'), { code: 'PROVIDER_REAUTH_MISMATCH' });
      }
      completed.set(flow.flowId, {
        ok: true,
        provider,
        userId: flow.userId,
        sessionHash: flow.sessionHash,
        providerIdentityId: identity.id,
        expiresAt: now() + OAUTH_FLOW_TTL_MS,
      });
      return res.status(200).send('<html><body><h2>BeatGaler reauthentication complete</h2><p>You can close this window and return to BeatGaler.</p></body></html>');
    } catch (error) {
      completed.set(flow.flowId, {
        ok: false,
        code: error?.code === 'PROVIDER_REAUTH_MISMATCH' ? 'PROVIDER_REAUTH_MISMATCH' : 'PROVIDER_REAUTH_FAILED',
        expiresAt: now() + OAUTH_FLOW_TTL_MS,
      });
      return res.status(400).send('<html><body><h2>BeatGaler reauthentication failed</h2><p>Return to BeatGaler and try again.</p></body></html>');
    }
  }

  function poll(req, res, next) {
    cleanup();
    const flowId = String(req?.body?.flowId || '');
    const result = completed.get(flowId);
    if (!result) return next();
    completed.delete(flowId);
    if (!result.ok) return res.status(401).json({ error: 'Provider reauthentication failed.', code: result.code || 'PROVIDER_REAUTH_FAILED' });
    const info = runtime._test.sessionInfoFromRequest(req);
    if (!info) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'SESSION_REQUIRED' });
    if (info.userId !== result.userId || info.sessionHash !== result.sessionHash) {
      return res.status(401).json({ error: 'Provider reauthentication belongs to a different session.', code: 'REAUTH_SCOPE_DENIED' });
    }
    const currentProviderId = String(info.user?.providers?.[result.provider]?.id || '');
    if (!currentProviderId || currentProviderId !== result.providerIdentityId) {
      return res.status(401).json({ error: 'Provider identity no longer matches this account.', code: 'PROVIDER_REAUTH_MISMATCH' });
    }
    const grant = runtime._test.issueReauth(info.userId, info.sessionHash, `oauth:${result.provider}`);
    return res.json({ ok: true, purpose: 'reauth', provider: result.provider, reauth_token: grant, expires_in_ms: reauthTtlMs });
  }

  return { start, callback, poll, _test: { pending, completed, cleanup } };
}

function installProviderReauthRoutes(express, coordinator) {
  const application = express?.application;
  if (!application || application.__beatgalerD8ProviderReauthRoutesInstalled) return;
  application.__beatgalerD8ProviderReauthRoutesInstalled = true;
  const previousPost = application.post;
  const previousGet = application.get;

  application.post = function patchedD8ProviderReauthPost(routePath, ...handlers) {
    const pathName = String(routePath || '');
    if (pathName === '/auth/oauth/start') return previousPost.call(this, routePath, coordinator.start, ...handlers);
    if (pathName === '/auth/oauth/poll') return previousPost.call(this, routePath, coordinator.poll, ...handlers);
    return previousPost.call(this, routePath, ...handlers);
  };
  application.get = function patchedD8ProviderReauthGet(routePath, ...handlers) {
    const pathName = String(routePath || '');
    if (pathName === '/auth/oauth/:provider/callback') return previousGet.call(this, routePath, coordinator.callback, ...handlers);
    return previousGet.call(this, routePath, ...handlers);
  };
}

function applyD8RoResolutions(express, runtime, options = {}) {
  if (!runtime) return null;
  installImmediateAccountDeletion(runtime, options);
  const coordinator = createProviderReauthCoordinator(runtime, options);
  installProviderReauthRoutes(express, coordinator);
  return { runtime, coordinator };
}

module.exports = {
  d8LifecycleEnv,
  installImmediateAccountDeletion,
  createProviderReauthCoordinator,
  installProviderReauthRoutes,
  applyD8RoResolutions,
  OAUTH_FLOW_TTL_MS,
};
