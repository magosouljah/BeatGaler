'use strict';

const { requiredEnv } = require('./runtime-env');
const { normalizeEmail, validEmailAfterNormalization: validEmail, ACCOUNTS_FILE_NAME } = require('./auth-helpers');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { hasUsablePasswordShared } = require('./sensitive-auth-containment');

const FETCH_PATCH = Symbol.for('beatgaler.authPublicRegistration.fetchPatch');
const FS_PATCH = Symbol.for('beatgaler.authPublicRegistration.fsPatch');
const TRACE_PATCH = Symbol.for('beatgaler.authPublicRegistration.tracePatch');
const ACCOUNT_HANDLER_PATCH = Symbol.for('beatgaler.authPublicRegistration.accountHandlerPatch');
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function publicRegistrationOpen(env = requiredEnv()) {
  return String(env.BEATGALER_PUBLIC_REGISTRATION || '') === '1';
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
  return preserveUsers(nextUsers, previousUsers, deletedUserIds, cloneUser);
}

// M7.4e: cuando nextUsers forma parte de un árbol JSON canónico, propio y sin alias, su clon JSON
// sería un objeto igual e independiente; se usa el propio objeto.
const ownedUser = user => user;

function preserveUsers(nextUsers, previousUsers, deletedUserIds, cloneNextUser) {
  const deleted = deletedUserIds instanceof Set ? deletedUserIds : new Set(deletedUserIds || []);
  const output = [];
  const byId = new Set();
  const usedNames = new Set();

  for (const raw of Array.isArray(nextUsers) ? nextUsers : []) {
    const id = String(raw?.id || '').trim();
    if (!id || deleted.has(id) || byId.has(id)) continue;
    const user = cloneNextUser(raw);
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

  // M7.4f: `previousUsers` puede ser un selector que recibe `keep(clave de id)` y devuelve copias, en
  // orden, de al menos los previos que `keep` acepta. El bucle vuelve a aplicar las mismas reglas, así
  // que el resultado es el de recorrer la lista completa.
  const previous = typeof previousUsers === 'function'
    ? previousUsers(key => { const id = key.trim(); return Boolean(id) && !deleted.has(id) && !byId.has(id); })
    : previousUsers;
  for (const raw of Array.isArray(previous) ? previous : []) {
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
    ['X_HANDLE_NOT_RECLAIMABLE', 'This username belongs to another BeatGaler account.'],
    ['X_HANDLE_ATOMIC_CLAIM_REQUIRED', 'This X handle is being reconciled. Please try again later.'],
    ['X_HANDLE_INVALID', 'X returned an invalid username.'],
    ['X_USERNAME_SPACE_EXHAUSTED', 'A temporary BeatGaler username could not be allocated.'],
  ]);
  const conflictCodes = new Set(['GOOGLE_EMAIL_CONFLICT', 'PROVIDER_ALREADY_CONNECTED', 'X_HANDLE_CASEFOLD_COLLISION', 'X_HANDLE_NOT_RECLAIMABLE', 'X_HANDLE_ATOMIC_CLAIM_REQUIRED']);
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

function installAuthPublicRegistrationHardening(ctx, {
  env = requiredEnv(),
  // Installed before the lifecycle: resolved lazily from the context on each use.
  getAccountLifecycle = () => ctx?.entries?.accountLifecycle?.runtime || null,
  getProviderIdentityAuthority = () => null,
  getAuthPool = () => null,
  now = () => Date.now(),
} = {}) {
  if (!ctx?.entries || ctx.entries.authPublicRegistrationHardening) return;
  const entry = ctx.entries.authPublicRegistrationHardening = {};

  const oauthContext = new AsyncLocalStorage();
  const oauthFlows = new Map();

  function lifecycle() {
    try { return getAccountLifecycle?.() || null; } catch { return null; }
  }

  function accountsSnapshot() {
    try { return lifecycle()?.api?.state?.accountsSnapshot?.() || { users: [], sessions: {} }; }
    catch { return { users: [], sessions: {} }; }
  }

  // M7.4f: previos para el filtro de escritura; copia solo los que `keep` acepta en vez del índice entero.
  function previousUsersWhere(keep) {
    let state = null;
    try { state = lifecycle()?.api?.state || null; } catch {}
    if (typeof state?.accountsUsersWhere !== 'function') return accountsSnapshot().users;
    // Como antes: un fallo al leer el índice da `[]` (el `catch` de accountsSnapshot), pero un fallo de
    // las reglas de conservación (`keep`, p. ej. la lápida) se propaga y el filtro falla cerrado
    // (AUTH_REGISTRATION_FILTER_FAILED), igual que cuando el bucle recorría la copia completa.
    let ruleFailure = null;
    const guardedKeep = key => {
      try { return keep(key); } catch (error) { ruleFailure ||= { error }; throw error; }
    };
    let users;
    try { users = state.accountsUsersWhere(guardedKeep); } catch { users = []; }
    if (ruleFailure) throw ruleFailure.error;
    return users;
  }

  function deletedUserIds() {
    try { return lifecycle()?.api?.state?.deletedUserIds || new Set(); }
    catch { return new Set(); }
  }

  function sessionInfo(req) {
    try { return lifecycle()?.api?.session?.sessionInfoFromRequest?.(req) || null; }
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
    const pool = getAuthPool?.();
    if (!pool) return next();
    // A process with an old local snapshot must not authenticate the previous
    // email after another process committed a staged email change.
    void pool.query('SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1', [email]).then(result => {
      const local = accountsSnapshot().users.find(user => normalizeEmail(user?.email) === email);
      if (!local || String(local.id) !== String(result.rows[0]?.id || '')) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      next();
    }).catch(() => res.status(503).json({ error: 'Authentication service is temporarily unavailable.' }));
  }

  function disconnectProvider(req, res, next) {
    const info = sessionInfo(req);
    if (!info) return next();
    const authority = getProviderIdentityAuthority?.();
    if (!authority?.prepareDisconnect) {
      if (String(env.NODE_ENV || '') !== 'production') return next();
      return res.status(503).json({ error: 'Authentication service is temporarily unavailable.', code: 'AUTH_SERVICE_UNAVAILABLE' });
    }
    void hasUsablePasswordShared(lifecycle(), info, getAuthPool?.()).then(usablePassword => authority.prepareDisconnect({
      provider: req?.body?.provider,
      userId: info.userId,
      usablePassword,
    })).then(() => next()).catch(error => {
      const code = String(error?.code || 'OAUTH_IDENTITY_AUTHORITY_UNAVAILABLE');
      const status = code === 'LAST_SIGNIN_METHOD_REQUIRED' ? 409 : code === 'OAUTH_PROVIDER_UNSUPPORTED' ? 400 : 503;
      res.status(status).json({ error: status === 409 ? 'Add another usable sign-in method before disconnecting this provider.' : 'Authentication service is temporarily unavailable.', code });
    });
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

  entry.post = function hardenedAuthPost(routePath, handlers) {
    const { next } = this;
    const pathName = String(routePath || '');
    const extras = [];
    if (pathName.startsWith('/auth/')) extras.push((req, res, next) => sanitizeAuthJson(pathName, req, res, next));
    if (pathName === '/auth/login') extras.push(emailOnlyLogin);
    if (pathName === '/auth/oauth/start') extras.push(decorateOAuthStart);
    if (pathName === '/auth/oauth/disconnect') extras.push(disconnectProvider);
    return next(routePath, ...extras, ...handlers);
  };

  entry.get = function hardenedAuthGet(routePath, handlers) {
    const { next } = this;
    const pathName = String(routePath || '');
    if (pathName === '/auth/oauth/:provider/callback') {
      return next(routePath, oauthCallbackContext, sanitizeOAuthHtml, ...handlers);
    }
    return next(routePath, ...handlers);
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
    const filterAccounts = (parsed, cloneNextUser) => {
      if (Array.isArray(parsed?.users)) {
        parsed.users = preserveUsers(parsed.users, previousUsersWhere, deletedUserIds(), cloneNextUser);
        for (const user of parsed.users) {
          if (!user?.providers?.x) continue;
          delete user.providers.x.accessToken;
          delete user.providers.x.refreshToken;
          delete user.providers.x.tokenExpiresAt;
        }
      }
      return JSON.stringify(parsed, null, 2);
    };
    const failClosed = error => {
      console.error('[auth] stable-id snapshot preservation failed:', error?.message || String(error));
      // Fail closed: nunca persistir el contenido original (tokens OAuth de X, sin preservación de ids).
      const failure = new Error('Auth registration persistence filter failed; write aborted.');
      failure.code = 'AUTH_REGISTRATION_FILTER_FAILED';
      return failure;
    };
    const wrapper = function preserveStableUsersAndScrubOAuthTokens(file, data, ...rest) {
      let next = data;
      try {
        const name = String(file || '').replace(/\\/g, '/');
        if (typeof data === 'string' && name.endsWith(`/${ACCOUNTS_FILE_NAME}.tmp`)) {
          next = filterAccounts(JSON.parse(data), cloneUser);
        }
      } catch (error) {
        throw failClosed(error);
      }
      return originalWriteFileSync.call(fs, file, next, ...rest);
    };
    // M7.4e: el filtro de ciclo de vida (account-lifecycle.js), cuando envuelve directamente a `wrapper`,
    // entrega aquí su valor ya filtrado en vez de serializarlo para que `wrapper` lo vuelva a parsear.
    // Solo lo hace con una ruta `/accounts-data.json.tmp` y un árbol JSON canónico, propio y sin alias,
    // así que equivale a `wrapper(file, JSON.stringify(value, null, 2), ...rest)`: mismos bytes y mismo
    // fallo cerrado.
    const writeCanonicalAccounts = (file, value, ...rest) => {
      let next;
      try {
        next = filterAccounts(value, ownedUser);
      } catch (error) {
        throw failClosed(error);
      }
      return originalWriteFileSync.call(fs, file, next, ...rest);
    };
    fs[FS_PATCH] = { originalWriteFileSync, wrapper, writeCanonicalAccounts };
    fs.writeFileSync = wrapper;
  }
}

function wrapAuthPublicRegistrationPost(routePath, handlers) {
  const register = this.ctx?.entries.authPublicRegistrationHardening?.post;
  return register ? register.call(this, routePath, handlers) : this.next(routePath, ...handlers);
}

function wrapAuthPublicRegistrationGet(routePath, handlers) {
  const register = this.ctx?.entries.authPublicRegistrationHardening?.get;
  return register ? register.call(this, routePath, handlers) : this.next(routePath, ...handlers);
}

module.exports = {
  wrapAuthPublicRegistrationGet,
  wrapAuthPublicRegistrationPost,
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
