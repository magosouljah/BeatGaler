'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_COOKIE = '__Host-beatgaler_session';
const CSRF_COOKIE = '__Host-beatgaler_csrf';
const WEB_CLIENT = 'web';
const BROWSER_SESSION_SENTINEL = 'browser-cookie-session';
const ROTATED_TOKEN_PREFIX = 'sessr_';
const STATE_VERSION = 1;
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const STATE_FILE_NAME = 'session-security-state.json';
const ACCOUNTS_FILE_NAME = 'accounts-data.json';
const PUBLIC_LOGIN_ROUTES = new Set(['/auth/login', '/auth/register']);
const CSRF_EXEMPT_ROUTES = new Set(['/auth/login', '/auth/register', '/auth/session']);
const RESPONSE_AUTH_ROUTES = new Set([
  '/auth/register',
  '/auth/login',
  '/auth/session',
  '/auth/account',
  '/auth/email/change',
  '/auth/password/change',
  '/auth/mfa/setup',
  '/auth/mfa/enable',
  '/auth/mfa/disable',
  '/auth/oauth/start',
  '/auth/oauth/poll',
  '/auth/oauth/disconnect',
  '/auth/logout',
  '/auth/account/delete',
  '/plans/dev-switch',
]);
const SENSITIVE_ROTATION_ROUTES = new Set(['/auth/password/change']);
const CLEAR_SESSION_ROUTES = new Set(['/auth/logout', '/auth/account/delete']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const raw = String(req?.headers?.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function parseCookies(req) {
  const raw = String(req?.headers?.cookie || '');
  const out = Object.create(null);
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(value); }
    catch { out[name] = value; }
  }
  return out;
}

function appendSetCookie(res, value) {
  const previous = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  const items = previous == null ? [] : (Array.isArray(previous) ? previous.slice() : [String(previous)]);
  items.push(value);
  res.setHeader('Set-Cookie', items);
}

function requestHost(req) {
  return String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').trim().toLowerCase();
}

function cookieSameSite(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return 'Strict';
  try {
    const host = requestHost(req);
    const originHost = new URL(origin).host.toLowerCase();
    return host && originHost === host ? 'Strict' : 'None';
  } catch {
    return 'None';
  }
}

function sessionCookie(token, req, maxAge = SESSION_COOKIE_MAX_AGE_SECONDS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(String(token || ''))}; Path=/; Max-Age=${Math.max(0, Number(maxAge) || 0)}; HttpOnly; Secure; SameSite=${cookieSameSite(req)}`;
}

function csrfCookie(token, req, maxAge = SESSION_COOKIE_MAX_AGE_SECONDS) {
  return `${CSRF_COOKIE}=${encodeURIComponent(String(token || ''))}; Path=/; Max-Age=${Math.max(0, Number(maxAge) || 0)}; Secure; SameSite=${cookieSameSite(req)}`;
}

function clearBrowserCookies(req, res) {
  appendSetCookie(res, sessionCookie('', req, 0));
  appendSetCookie(res, csrfCookie('', req, 0));
}

function isWebClient(req) {
  const explicit = String(req?.headers?.['x-beatgaler-client'] || '').trim().toLowerCase();
  if (explicit === WEB_CLIENT) return true;
  const cookies = parseCookies(req);
  return Boolean(cookies[SESSION_COOKIE]);
}

function publicSessionId(sessionHash) {
  return `ses_${String(sessionHash || '').slice(0, 24)}`;
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, value) {
  ensureDirectory(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function normalizePersistentState(input) {
  const state = input && typeof input === 'object' ? input : {};
  return {
    version: STATE_VERSION,
    revoked_session_hashes: Array.isArray(state.revoked_session_hashes)
      ? state.revoked_session_hashes.filter(item => /^[0-9a-f]{64}$/.test(String(item)))
      : [],
    managed_session_hashes: Array.isArray(state.managed_session_hashes)
      ? state.managed_session_hashes.filter(item => /^[0-9a-f]{64}$/.test(String(item)))
      : [],
    session_meta: state.session_meta && typeof state.session_meta === 'object' && !Array.isArray(state.session_meta)
      ? state.session_meta
      : {},
  };
}

function createSessionSecurityRuntime({
  dataDir = __dirname,
  now = () => Date.now(),
  randomBytes = size => crypto.randomBytes(size),
  getCapabilityStore = () => null,
} = {}) {
  const stateFile = path.join(dataDir, STATE_FILE_NAME);
  const accountsFile = path.join(dataDir, ACCOUNTS_FILE_NAME);
  const persisted = normalizePersistentState(readJsonFile(stateFile, {}));
  const revokedSessionHashes = new Set(persisted.revoked_session_hashes);
  const managedSessionHashes = new Set(persisted.managed_session_hashes);
  const sessionMeta = new Map(Object.entries(persisted.session_meta || {}));
  const rotatedAliases = new Map();

  function saveState() {
    const meta = {};
    for (const [sessionHash, value] of sessionMeta) {
      if (!/^[0-9a-f]{64}$/.test(sessionHash) || !value || typeof value !== 'object') continue;
      meta[sessionHash] = {
        session_id: publicSessionId(sessionHash),
        user_id: String(value.user_id || ''),
        client_kind: String(value.client_kind || 'unknown'),
        installation_id: value.installation_id ? String(value.installation_id) : null,
        last_seen_at: Number(value.last_seen_at || 0) || null,
      };
    }
    atomicWriteJson(stateFile, {
      version: STATE_VERSION,
      revoked_session_hashes: [...revokedSessionHashes].sort(),
      managed_session_hashes: [...managedSessionHashes].sort(),
      session_meta: meta,
    });
  }

  function accountsSnapshot() {
    const parsed = readJsonFile(accountsFile, {});
    return {
      users: Array.isArray(parsed?.users) ? parsed.users : [],
      sessions: parsed?.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? parsed.sessions
        : {},
    };
  }

  function sessionRecord(sessionHash, snapshot = accountsSnapshot()) {
    return snapshot.sessions?.[sessionHash] || null;
  }

  function userIdForHash(sessionHash, snapshot = accountsSnapshot()) {
    const record = sessionRecord(sessionHash, snapshot);
    return String(record?.userId || record?.user_id || sessionMeta.get(sessionHash)?.user_id || '').trim();
  }

  function recordSessionMeta(sessionHash, req, userId = '') {
    if (!/^[0-9a-f]{64}$/.test(sessionHash)) return;
    const current = sessionMeta.get(sessionHash) || {};
    const installationId = String(req?.body?.beatgalerUserId || req?.headers?.['x-beatgaler-installation-id'] || current.installation_id || '').trim();
    const next = {
      ...current,
      session_id: publicSessionId(sessionHash),
      user_id: String(userId || current.user_id || userIdForHash(sessionHash) || ''),
      client_kind: isWebClient(req) ? 'web' : String(req?.headers?.['x-beatgaler-client'] || current.client_kind || 'desktop'),
      installation_id: installationId || null,
      last_seen_at: now(),
    };
    sessionMeta.set(sessionHash, next);
  }

  function augmentCorsHeaders(res) {
    if (!res || res.__beatgalerSessionCorsWrapped || typeof res.setHeader !== 'function') return;
    res.__beatgalerSessionCorsWrapped = true;
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      const lower = String(name || '').toLowerCase();
      if (lower === 'access-control-allow-headers') {
        const requested = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
        for (const extra of ['X-BeatGaler-Client', 'X-BeatGaler-CSRF']) {
          if (!requested.some(item => item.toLowerCase() === extra.toLowerCase())) requested.push(extra);
        }
        return originalSetHeader(name, requested.join(', '));
      }
      const result = originalSetHeader(name, value);
      if (lower === 'access-control-allow-origin' && String(value || '') && String(value || '') !== '*') {
        originalSetHeader('Access-Control-Allow-Credentials', 'true');
      }
      return result;
    };
  }

  function reject(res, status, code, message) {
    return res.status(status).json({ error: message, code });
  }

  function resolvePresentedCredential(req) {
    const cookies = parseCookies(req);
    const cookieToken = String(cookies[SESSION_COOKIE] || '').trim();
    const bearer = bearerToken(req);
    let presentedToken = cookieToken || bearer;
    let source = cookieToken ? 'cookie' : (bearer ? 'bearer' : 'none');
    if (source === 'bearer' && presentedToken === BROWSER_SESSION_SENTINEL) {
      return { ok: false, missing: true, source, cookies };
    }
    if (!presentedToken) return { ok: false, missing: true, source, cookies };

    const presentedHash = sha256(presentedToken);
    let innerToken = presentedToken;
    let innerHash = presentedHash;
    let rotated = false;

    if (presentedToken.startsWith(ROTATED_TOKEN_PREFIX)) {
      const alias = rotatedAliases.get(presentedHash);
      if (!alias) {
        return { ok: false, status: 401, code: 'SESSION_ROTATION_EXPIRED', message: 'Session rotation requires sign-in again.', source, cookies };
      }
      innerToken = alias.innerToken;
      innerHash = alias.innerHash;
      rotated = true;
    }

    if (revokedSessionHashes.has(innerHash)) {
      return { ok: false, status: 401, code: 'SESSION_REVOKED', message: 'Session revoked. Sign in again.', source, cookies };
    }
    if (!rotated && managedSessionHashes.has(innerHash)) {
      return { ok: false, status: 401, code: 'SESSION_ROTATED', message: 'Session was rotated. Sign in again.', source, cookies };
    }

    const snapshot = accountsSnapshot();
    const record = sessionRecord(innerHash, snapshot);
    if (!record || Number(record.expiresAt || record.expires_at || 0) <= now()) {
      return { ok: false, status: 401, code: 'SESSION_EXPIRED', message: 'Session expired. Sign in again.', source, cookies };
    }

    const userId = userIdForHash(innerHash, snapshot);
    if (!userId) {
      return { ok: false, status: 401, code: 'SESSION_INVALID', message: 'Session invalid. Sign in again.', source, cookies };
    }

    return {
      ok: true,
      source,
      cookies,
      presentedToken,
      presentedHash,
      innerToken,
      innerHash,
      userId,
      rotated,
      record,
    };
  }

  function csrfRequired(req, credential) {
    if (!credential?.ok || credential.source !== 'cookie') return false;
    const method = String(req?.method || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return false;
    const route = String(req?.path || req?.url || '').split('?')[0];
    return !CSRF_EXEMPT_ROUTES.has(route);
  }

  function validCsrf(req, credential) {
    const header = String(req?.headers?.['x-beatgaler-csrf'] || '').trim();
    const cookie = String(credential?.cookies?.[CSRF_COOKIE] || '').trim();
    return timingSafeTextEqual(header, cookie);
  }

  function requestMiddleware(req, res, next) {
    augmentCorsHeaders(res);
    const route = String(req?.path || req?.url || '').split('?')[0];
    const web = isWebClient(req);

    if (PUBLIC_LOGIN_ROUTES.has(route)) {
      req.beatgalerSessionSecurity = null;
      return next();
    }

    const hasCredential = Boolean(parseCookies(req)[SESSION_COOKIE] || bearerToken(req));
    if (!hasCredential) {
      req.beatgalerSessionSecurity = null;
      return next();
    }

    const credential = resolvePresentedCredential(req);
    if (!credential.ok) {
      if (web) clearBrowserCookies(req, res);
      return reject(res, credential.status || 401, credential.code || 'SESSION_INVALID', credential.message || 'Session invalid. Sign in again.');
    }

    if (csrfRequired(req, credential) && !validCsrf(req, credential)) {
      return reject(res, 403, 'CSRF_REQUIRED', 'CSRF validation failed. Refresh the session and retry.');
    }

    req.beatgalerSessionSecurity = credential;
    req.headers.authorization = `Bearer ${credential.innerToken}`;
    recordSessionMeta(credential.innerHash, req, credential.userId);
    return next();
  }

  function issueBrowserCookies(req, res, token) {
    const csrf = randomBytes(24).toString('base64url');
    appendSetCookie(res, sessionCookie(token, req));
    appendSetCookie(res, csrfCookie(csrf, req));
    return csrf;
  }

  function rotateSensitiveSession(req, res, payload) {
    const credential = req.beatgalerSessionSecurity;
    if (!credential?.ok) return payload;
    const alias = `${ROTATED_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const aliasHash = sha256(alias);
    const expiresAt = Number(credential.record?.expiresAt || credential.record?.expires_at || 0);
    rotatedAliases.set(aliasHash, {
      innerToken: credential.innerToken,
      innerHash: credential.innerHash,
      userId: credential.userId,
      expiresAt,
      createdAt: now(),
    });
    managedSessionHashes.add(credential.innerHash);
    if (credential.rotated) rotatedAliases.delete(credential.presentedHash);
    recordSessionMeta(credential.innerHash, req, credential.userId);
    saveState();

    const nextPayload = { ...(payload || {}), session_rotated: true };
    if (isWebClient(req)) {
      nextPayload.csrf_token = issueBrowserCookies(req, res, alias);
      delete nextPayload.token;
      nextPayload.session_transport = 'cookie';
    } else {
      nextPayload.token = alias;
    }
    return nextPayload;
  }

  function decorateResponse(routePath, req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = payload => {
      const success = Number(res.statusCode || 200) >= 200 && Number(res.statusCode || 200) < 300;
      let nextPayload = payload;
      if (success && SENSITIVE_ROTATION_ROUTES.has(routePath)) {
        nextPayload = rotateSensitiveSession(req, res, nextPayload);
      }

      const returnedToken = success && nextPayload && typeof nextPayload.token === 'string' && nextPayload.token
        ? nextPayload.token
        : '';
      if (returnedToken && !returnedToken.startsWith(ROTATED_TOKEN_PREFIX)) {
        const sessionHash = sha256(returnedToken);
        const userId = String(nextPayload?.user?.id || userIdForHash(sessionHash) || '');
        recordSessionMeta(sessionHash, req, userId);
        saveState();
        if (isWebClient(req)) {
          const csrf = issueBrowserCookies(req, res, returnedToken);
          nextPayload = { ...nextPayload, csrf_token: csrf, session_transport: 'cookie' };
          delete nextPayload.token;
        }
      } else if (success && routePath === '/auth/session' && isWebClient(req) && req.beatgalerSessionSecurity?.ok) {
        const csrf = issueBrowserCookies(req, res, req.beatgalerSessionSecurity.presentedToken);
        nextPayload = { ...nextPayload, csrf_token: csrf, session_transport: 'cookie' };
        delete nextPayload.token;
      }

      if (success && CLEAR_SESSION_ROUTES.has(routePath) && req.beatgalerSessionSecurity?.ok) {
        const hash = req.beatgalerSessionSecurity.innerHash;
        revokedSessionHashes.add(hash);
        managedSessionHashes.delete(hash);
        if (req.beatgalerSessionSecurity.rotated) rotatedAliases.delete(req.beatgalerSessionSecurity.presentedHash);
        saveState();
        if (isWebClient(req)) clearBrowserCookies(req, res);
      }

      if (!success && Number(res.statusCode || 0) === 401 && isWebClient(req) && !PUBLIC_LOGIN_ROUTES.has(routePath)) {
        clearBrowserCookies(req, res);
      }
      if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
      return originalJson(nextPayload);
    };
    next();
  }

  function userSessions(userId) {
    const snapshot = accountsSnapshot();
    const currentTime = now();
    const sessions = [];
    for (const [sessionHash, record] of Object.entries(snapshot.sessions || {})) {
      const recordUserId = String(record?.userId || record?.user_id || '');
      const expiresAt = Number(record?.expiresAt || record?.expires_at || 0);
      if (recordUserId !== String(userId) || expiresAt <= currentTime || revokedSessionHashes.has(sessionHash)) continue;
      const meta = sessionMeta.get(sessionHash) || {};
      sessions.push({
        id: publicSessionId(sessionHash),
        sessionHash,
        created_at: new Date(Number(record?.createdAt || record?.created_at || 0) || currentTime).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        last_seen_at: meta.last_seen_at ? new Date(Number(meta.last_seen_at)).toISOString() : null,
        client_kind: String(meta.client_kind || 'unknown'),
        installation_id: meta.installation_id ? String(meta.installation_id) : null,
      });
    }
    sessions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return sessions;
  }

  function requireManagedRequest(req, res) {
    const credential = req.beatgalerSessionSecurity;
    if (!credential?.ok) {
      reject(res, 401, 'SESSION_REQUIRED', 'Session expired. Sign in again.');
      return null;
    }
    return credential;
  }

  function listSessions(req, res) {
    const credential = requireManagedRequest(req, res);
    if (!credential) return;
    const sessions = userSessions(credential.userId).map(item => ({
      id: item.id,
      current: item.sessionHash === credential.innerHash,
      created_at: item.created_at,
      expires_at: item.expires_at,
      last_seen_at: item.last_seen_at,
      client_kind: item.client_kind,
      installation_id: item.installation_id,
    }));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, sessions });
  }

  async function revokeCapabilitySession(sessionHash, reason) {
    const store = getCapabilityStore?.();
    if (!store || typeof store.revokeAuthSession !== 'function') {
      const error = new Error('Capability revocation store is unavailable.');
      error.code = 'DIRECT_CAPABILITY_REVOKE_FAILED';
      throw error;
    }
    await store.revokeAuthSession({ authSessionHash: sessionHash, reason });
  }

  async function revokeOne(req, res) {
    const credential = requireManagedRequest(req, res);
    if (!credential) return;
    const targetId = String(req?.body?.session_id || req?.body?.sessionId || '').trim();
    const target = userSessions(credential.userId).find(item => item.id === targetId);
    if (!target) return reject(res, 404, 'SESSION_NOT_FOUND', 'Session was not found.');
    try {
      await revokeCapabilitySession(target.sessionHash, 'session_revoke_one');
    } catch {
      return reject(res, 503, 'DIRECT_CAPABILITY_REVOKE_FAILED', 'Session revocation could not safely revoke active capabilities.');
    }
    revokedSessionHashes.add(target.sessionHash);
    managedSessionHashes.delete(target.sessionHash);
    for (const [aliasHash, alias] of rotatedAliases) if (alias.innerHash === target.sessionHash) rotatedAliases.delete(aliasHash);
    saveState();
    const currentRevoked = target.sessionHash === credential.innerHash;
    if (currentRevoked && isWebClient(req)) clearBrowserCookies(req, res);
    return res.json({ ok: true, revoked_session_id: target.id, current_revoked: currentRevoked });
  }

  async function revokeAll(req, res) {
    const credential = requireManagedRequest(req, res);
    if (!credential) return;
    const targets = userSessions(credential.userId);
    try {
      for (const target of targets) await revokeCapabilitySession(target.sessionHash, 'session_revoke_all');
    } catch {
      return reject(res, 503, 'DIRECT_CAPABILITY_REVOKE_FAILED', 'Session revocation could not safely revoke all active capabilities.');
    }
    for (const target of targets) {
      revokedSessionHashes.add(target.sessionHash);
      managedSessionHashes.delete(target.sessionHash);
    }
    for (const [aliasHash, alias] of rotatedAliases) if (revokedSessionHashes.has(alias.innerHash)) rotatedAliases.delete(aliasHash);
    saveState();
    if (isWebClient(req)) clearBrowserCookies(req, res);
    return res.json({ ok: true, revoked_count: targets.length, current_revoked: true });
  }

  return {
    requestMiddleware,
    decorateResponse,
    listSessions,
    revokeOne,
    revokeAll,
    publicSessionId,
    _test: {
      accountsSnapshot,
      clearBrowserCookies,
      resolvePresentedCredential,
      rotateSensitiveSession,
      stateFile,
      revokedSessionHashes,
      managedSessionHashes,
      rotatedAliases,
      sessionMeta,
      saveState,
    },
  };
}

function installSessionSecurity(express, options = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerSessionSecurityInstalled) return application?.__beatgalerSessionSecurityRuntime || null;
  application.__beatgalerSessionSecurityInstalled = true;
  const runtime = createSessionSecurityRuntime(options);
  application.__beatgalerSessionSecurityRuntime = runtime;
  const originalUse = application.use;
  const originalPost = application.post;

  application.use = function patchedSessionSecurityUse(...handlers) {
    if (!this.__beatgalerSessionSecurityMiddlewareAttached) {
      this.__beatgalerSessionSecurityMiddlewareAttached = true;
      originalUse.call(this, runtime.requestMiddleware);
    }
    return originalUse.call(this, ...handlers);
  };

  function ensureManagementRoutes(app) {
    if (app.__beatgalerSessionSecurityRoutesInstalled) return;
    app.__beatgalerSessionSecurityRoutesInstalled = true;
    originalPost.call(app, '/auth/sessions', runtime.listSessions);
    originalPost.call(app, '/auth/sessions/revoke', (req, res) => { void runtime.revokeOne(req, res); });
    originalPost.call(app, '/auth/sessions/revoke-all', (req, res) => { void runtime.revokeAll(req, res); });
  }

  application.post = function patchedSessionSecurityPost(routePath, ...handlers) {
    ensureManagementRoutes(this);
    if (RESPONSE_AUTH_ROUTES.has(routePath)) {
      return originalPost.call(this, routePath, (req, res, next) => runtime.decorateResponse(routePath, req, res, next), ...handlers);
    }
    return originalPost.call(this, routePath, ...handlers);
  };

  return runtime;
}

module.exports = {
  installSessionSecurity,
  createSessionSecurityRuntime,
  SESSION_COOKIE,
  CSRF_COOKIE,
  BROWSER_SESSION_SENTINEL,
  ROTATED_TOKEN_PREFIX,
};
