'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');

const FETCH_PATCH = Symbol.for('beatgaler.authPublicRegistration.fetchPatch');
const FS_PATCH = Symbol.for('beatgaler.authPublicRegistration.fsPatch');
const TRACE_PATCH = Symbol.for('beatgaler.authPublicRegistration.tracePatch');
const ACCOUNT_HANDLER_PATCH = Symbol.for('beatgaler.authPublicRegistration.accountHandlerPatch');
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function publicRegistrationOpen(env = process.env) {
  return String(env.NODE_ENV || '') !== 'production' || String(env.BEATGALER_PUBLIC_REGISTRATION || '') === '1';
}

function providerSubject(user, provider) {
  return String(user?.providers?.[provider]?.id || '');
}

function cloneUser(user) {
  return user && typeof user === 'object' ? JSON.parse(JSON.stringify(user)) : user;
}

function normalUsernameBase(value) {
  let base = normalizeUsername(value).replace(/#[0-9]{4}$/i, '').replace(/[^a-z0-9._]/g, '').slice(0, 20);
  if (base.length < 3) base = 'user';
  return base;
}

function temporaryUsername(value, userId, used) {
  const base = normalUsernameBase(value);
  const seed = Number.parseInt(crypto.createHash('sha256').update(String(userId || value || base)).digest('hex').slice(0, 8), 16) % 10_000;
  for (let offset = 0; offset < 10_000; offset += 1) {
    const suffix = String((seed + offset) % 10_000).padStart(4, '0');
    const candidate = `${base}#${suffix}`;
    if (!used.has(normalizeUsername(candidate))) return candidate;
  }
  throw new Error('No temporary BeatGaler username is available.');
}

function preserveUsersByStableId(nextUsers, previousUsers, deletedUserIds = new Set()) {
  const deleted = deletedUserIds instanceof Set ? deletedUserIds : new Set(deletedUserIds || []);
  const output = [];
  const byId = new Set();
  const usedNames = new Set();

  for (const raw of Array.isArray(nextUsers) ? nextUsers : []) {
    const id = String(raw?.id || '').trim();
    if (!id || deleted.has(id) || byId.has(id)) continue;
    const user = cloneUser(raw);
    const nameKey = normalizeUsername(user?.username);
    if (nameKey && usedNames.has(nameKey)) {
      user.username = temporaryUsername(user.username, id, usedNames);
      user.usernameSource = 'beatgaler';
      user.usernameReconciliation = 'snapshot_collision';
    }
    byId.add(id);
    if (user?.username) usedNames.add(normalizeUsername(user.username));
    output.push(user);
  }

  for (const raw of Array.isArray(previousUsers) ? previousUsers : []) {
    const id = String(raw?.id || '').trim();
    if (!id || deleted.has(id) || byId.has(id)) continue;
    const user = cloneUser(raw);
    const nameKey = normalizeUsername(user?.username);
    if (nameKey && usedNames.has(nameKey)) {
      user.username = temporaryUsername(user.username, id, usedNames);
      user.usernameSource = 'beatgaler';
      user.usernameReconciliation = 'snapshot_preserved';
    }
    byId.add(id);
    if (user?.username) usedNames.add(normalizeUsername(user.username));
    output.push(user);
  }

  return output;
}

function oauthDecision({ provider, identity, users, link, registrationOpen }) {
  const subject = String(identity?.id || '');
  const rows = Array.isArray(users) ? users : [];
  const existing = rows.find(user => providerSubject(user, provider) === subject) || null;

  if (provider === 'google' && identity?.email_verified !== true) {
    return { allow: false, code: 'GOOGLE_EMAIL_NOT_VERIFIED', message: 'Google did not confirm this email address.' };
  }

  if (!existing && !link && !registrationOpen) {
    return { allow: false, code: 'PUBLIC_REGISTRATION_CLOSED', message: 'Public registration is temporarily unavailable.' };
  }

  if (provider === 'google' && !existing && identity?.email) {
    const email = normalizeEmail(identity.email);
    const emailOwner = rows.find(user => normalizeEmail(user?.email) === email) || null;
    if (emailOwner) {
      return {
        allow: false,
        code: 'GOOGLE_EMAIL_CONFLICT',
        message: 'Sign in to the existing BeatGaler account, then connect Google from Settings.',
      };
    }
  }

  if (provider === 'x' && identity?.username) {
    const handle = normalizeUsername(identity.username);
    const handleOwner = rows.find(user => normalizeUsername(user?.username) === handle) || null;
    if (handleOwner && providerSubject(handleOwner, 'x') !== subject) {
      return {
        allow: false,
        code: 'X_HANDLE_RECONCILIATION_REQUIRED',
        message: 'This X handle changed owners. BeatGaler must reconcile the previous display name before sign-in can continue.',
      };
    }
  }

  return { allow: true, existing };
}

function oauthAuthorityError(error) {
  const code = String(error?.code || 'OAUTH_IDENTITY_AUTHORITY_UNAVAILABLE');
  const messages = new Map([
    ['PUBLIC_REGISTRATION_CLOSED', 'Public registration is temporarily unavailable.'],
    ['GOOGLE_EMAIL_NOT_VERIFIED', 'Google did not confirm this email address.'],
    ['GOOGLE_EMAIL_CONFLICT', 'Sign in to the existing BeatGaler account, then connect Google from Settings.'],
    ['PROVIDER_ALREADY_CONNECTED', 'That provider account is already connected to another BeatGaler account.'],
    ['X_HANDLE_CASEFOLD_COLLISION', 'This username needs migration before X sign-in can continue.'],
    ['X_HANDLE_INVALID', 'X returned an invalid username.'],
    ['X_USERNAME_SPACE_EXHAUSTED', 'A temporary BeatGaler username could not be allocated.'],
  ]);
  const conflictCodes = new Set(['GOOGLE_EMAIL_CONFLICT', 'PROVIDER_ALREADY_CONNECTED', 'X_HANDLE_CASEFOLD_COLLISION']);
  const deniedCodes = new Set(['PUBLIC_REGISTRATION_CLOSED', 'GOOGLE_EMAIL_NOT_VERIFIED', 'X_HANDLE_INVALID']);
  return {
    code,
    message: messages.get(code) || 'Authentication service is temporarily unavailable. Please try again.',
    status: conflictCodes.has(code) ? 409 : (deniedCodes.has(code) ? 403 : 503),
  };
}

function authErrorLooksInternal(value) {
  return /(storage account|not configured|postgres|telegram|master|secret|access[_ -]?token|refresh[_ -]?token|econn|enotfound|stack|aws|ses|database|sqlstate)/i.test(String(value || ''));
}

function installAuthPublicRegistrationHardening(express, {
  env = process.env,
  getAccountLifecycle = () => express?.application?.__beatgalerAccountLifecycleRuntime || null,
  getProviderIdentityAuthority = () => null,
  now = () => Date.now(),
} = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerAuthPublicRegistrationHardeningInstalled) return;
  application.__beatgalerAuthPublicRegistrationHardeningInstalled = true;

  const oauthContext = new AsyncLocalStorage();
  const oauthFlows = new Map();

  function lifecycle() {
    try { return getAccountLifecycle?.() || null; } catch { return null; }
  }

  function accountsSnapshot() {
    try { return lifecycle()?._test?.accountsSnapshot?.() || { users: [], sessions: {} }; }
    catch { return { users: [], sessions: {} }; }
  }

  function deletedUserIds() {
    try { return lifecycle()?._test?.deletedUserIds || new Set(); }
    catch { return new Set(); }
  }

  function sessionInfo(req) {
    try { return lifecycle()?._test?.sessionInfoFromRequest?.(req) || null; }
    catch { return null; }
  }

  function cleanupFlows() {
    const stamp = now();
    for (const [state, flow] of oauthFlows) if (Number(flow?.expiresAt || 0) <= stamp) oauthFlows.delete(state);
  }

  function emailOnlyLogin(req, res, next) {
    const raw = req?.body?.email ?? req?.body?.identifier ?? req?.body?.username;
    const email = normalizeEmail(raw);
    if (!validEmail(email)) return res.status(401).json({ error: 'Invalid email or password.', code: 'EMAIL_LOGIN_REQUIRED' });
    req.body = req.body || {};
    req.body.email = email;
    req.body.identifier = email;
    delete req.body.username;
    next();
  }

  function decorateOAuthStart(req, res, next) {
    cleanupFlows();
    const provider = String(req?.body?.provider || '').toLowerCase();
    const linkedInfo = sessionInfo(req);
    const linked = Boolean(linkedInfo);
    const linkUserId = linkedInfo?.userId ? String(linkedInfo.userId) : null;
    const originalJson = res.json.bind(res);
    res.json = payload => {
      let nextPayload = payload;
      if (Number(res.statusCode || 200) < 300 && payload?.authorization_url) {
        try {
          const url = new URL(payload.authorization_url);
          const state = String(url.searchParams.get('state') || '');
          if (state) oauthFlows.set(state, { provider, link: linked, linkUserId, expiresAt: now() + OAUTH_FLOW_TTL_MS });
          if (provider === 'x') {
            const scope = String(url.searchParams.get('scope') || '')
              .split(/\s+/).filter(Boolean).filter(value => value !== 'offline.access');
            url.searchParams.set('scope', scope.join(' '));
            nextPayload = { ...payload, authorization_url: url.toString() };
          }
        } catch {}
      }
      return originalJson(nextPayload);
    };
    next();
  }

  function oauthCallbackContext(req, _res, next) {
    cleanupFlows();
    const state = String(req?.query?.state || '');
    const remembered = oauthFlows.get(state) || null;
    if (remembered) oauthFlows.delete(state);
    const provider = String(req?.params?.provider || remembered?.provider || '').toLowerCase();
    oauthContext.run({
      provider,
      state,
      link: Boolean(remembered?.link),
      linkUserId: remembered?.linkUserId ? String(remembered.linkUserId) : null,
      registrationOpen: publicRegistrationOpen(env),
    }, next);
  }

  function sanitizeAuthJson(routePath, req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = payload => {
      const status = Number(res.statusCode || 200);
      if (routePath === '/auth/login' && status === 401) {
        return originalJson({ ...(payload || {}), error: 'Invalid email or password.' });
      }
      if (status >= 500 && String(payload?.error || '') === 'Public registration is temporarily unavailable.') {
        return originalJson(payload);
      }
      if (status >= 500 || authErrorLooksInternal(payload?.error)) {
        const requestId = String(req?.beatgalerRequestId || '');
        return originalJson({
          error: 'Authentication service is temporarily unavailable. Please try again.',
          code: 'AUTH_SERVICE_UNAVAILABLE',
          ...(requestId ? { request_id: requestId } : {}),
        });
      }
      return originalJson(payload);
    };
    next();
  }

  function sanitizeOAuthHtml(req, res, next) {
    const originalSend = res.send.bind(res);
    res.send = body => {
      const status = Number(res.statusCode || 200);
      if (status >= 400 && authErrorLooksInternal(body)) {
        const requestId = String(req?.beatgalerRequestId || '');
        const suffix = requestId ? ` (${requestId})` : '';
        return originalSend(`<html><body style="background:#0b0b0b;color:#ddd;font-family:system-ui;padding:40px"><h2>BeatGaler sign-in failed</h2><p>Authentication service is temporarily unavailable. Please try again.${suffix}</p></body></html>`);
      }
      return originalSend(body);
    };
    next();
  }

  const previousPost = application.post;
  const previousGet = application.get;

  application.post = function hardenedAuthPost(routePath, ...handlers) {
    const pathName = String(routePath || '');
    const extras = [];
    if (pathName.startsWith('/auth/')) extras.push((req, res, next) => sanitizeAuthJson(pathName, req, res, next));
    if (pathName === '/auth/login') extras.push(emailOnlyLogin);
    if (pathName === '/auth/oauth/start') extras.push(decorateOAuthStart);
    return previousPost.call(this, routePath, ...extras, ...handlers);
  };

  application.get = function hardenedAuthGet(routePath, ...handlers) {
    const pathName = String(routePath || '');
    if (pathName === '/auth/oauth/:provider/callback') {
      return previousGet.call(this, routePath, oauthCallbackContext, sanitizeOAuthHtml, ...handlers);
    }
    return previousGet.call(this, routePath, ...handlers);
  };

  if (!globalThis[FETCH_PATCH] && typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis[FETCH_PATCH] = { originalFetch, oauthContext, accountsSnapshot };
    globalThis.fetch = async function beatGalerAuthFetch(input, init) {
      const response = await originalFetch(input, init);
      const ctx = oauthContext.getStore();
      if (!ctx?.provider) return response;
      const url = String(typeof input === 'string' || input instanceof URL ? input : input?.url || '');
      const isGoogleIdentity = ctx.provider === 'google' && /openidconnect\.googleapis\.com\/v1\/userinfo/i.test(url);
      const isXIdentity = ctx.provider === 'x' && /api\.x\.com\/2\/users\/me/i.test(url);
      if (!isGoogleIdentity && !isXIdentity) return response;
      let body = null;
      try { body = await response.clone().json(); } catch { return response; }
      if (!response.ok) return response;
      const identity = ctx.provider === 'google'
        ? {
            id: body?.sub ? String(body.sub) : '',
            email: body?.email || null,
            email_verified: body?.email_verified === true,
            name: body?.name || null,
          }
        : {
            id: body?.data?.id ? String(body.data.id) : '',
            username: body?.data?.username || null,
            name: body?.data?.name || null,
          };
      if (!identity.id) return response;

      let authority = null;
      try { authority = getProviderIdentityAuthority?.() || null; } catch {}
      if (authority && typeof authority.prepare === 'function') {
        try {
          await authority.prepare({
            provider: ctx.provider,
            identity,
            linkUserId: ctx.linkUserId || null,
            registrationOpen: ctx.registrationOpen,
          });
          return response;
        } catch (error) {
          const safe = oauthAuthorityError(error);
          return new Response(JSON.stringify({ error: safe.code, error_description: safe.message }), {
            status: safe.status,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
        }
      }

      const decision = oauthDecision({
        provider: ctx.provider,
        identity,
        users: accountsSnapshot().users,
        link: ctx.link,
        registrationOpen: ctx.registrationOpen,
      });
      if (decision.allow) return response;
      return new Response(JSON.stringify({ error: decision.code, error_description: decision.message }), {
        status: decision.code === 'GOOGLE_EMAIL_CONFLICT' || decision.code === 'X_HANDLE_RECONCILIATION_REQUIRED' ? 409 : 403,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    };
  }

  const trace = require('./stage1-critical-path-trace');
  if (!trace[TRACE_PATCH] && typeof trace.step === 'function') {
    const originalStep = trace.step.bind(trace);
    trace[TRACE_PATCH] = { originalStep };
    trace.step = function hardenedTraceStep(req, stage, work) {
      if (String(stage) === 'auth_sync_identity') return Promise.resolve(false);
      return originalStep(req, stage, work);
    };
  }

  const consumers = require('./access-consumer-handlers');
  if (!consumers[ACCOUNT_HANDLER_PATCH] && typeof consumers.createAccountHandler === 'function') {
    const originalCreateAccountHandler = consumers.createAccountHandler;
    consumers[ACCOUNT_HANDLER_PATCH] = { originalCreateAccountHandler };
    consumers.createAccountHandler = deps => originalCreateAccountHandler({ ...deps, syncIdentity: async () => false });
  }

  if (!fs[FS_PATCH]) {
    const originalWriteFileSync = fs.writeFileSync;
    fs[FS_PATCH] = { originalWriteFileSync };
    fs.writeFileSync = function preserveStableUsersAndScrubOAuthTokens(file, data, ...rest) {
      let next = data;
      try {
        const name = String(file || '').replace(/\\/g, '/');
        if (typeof data === 'string' && name.endsWith('/accounts-data.json.tmp')) {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed?.users)) {
            parsed.users = preserveUsersByStableId(parsed.users, accountsSnapshot().users, deletedUserIds());
            for (const user of parsed.users) {
              if (!user?.providers?.x) continue;
              delete user.providers.x.accessToken;
              delete user.providers.x.refreshToken;
              delete user.providers.x.tokenExpiresAt;
            }
          }
          next = JSON.stringify(parsed, null, 2);
        }
      } catch (error) {
        console.error('[auth] stable-id snapshot preservation failed:', error?.message || String(error));
      }
      return originalWriteFileSync.call(fs, file, next, ...rest);
    };
  }
}

module.exports = {
  installAuthPublicRegistrationHardening,
  normalizeEmail,
  validEmail,
  normalizeUsername,
  normalUsernameBase,
  temporaryUsername,
  preserveUsersByStableId,
  publicRegistrationOpen,
  oauthDecision,
  oauthAuthorityError,
  authErrorLooksInternal,
};
