'use strict';

const { EventEmitter } = require('node:events');
const { publicRegistrationOpen } = require('./auth-public-registration-hardening');
const SIGNUP_COOKIE = '__Host-beatgaler_signup';

function webSignupRequest(req) {
  return String(req?.headers?.['x-beatgaler-client'] || '').toLowerCase() === 'web';
}

function appendCookie(res, value) {
  const previous = res.getHeader?.('Set-Cookie');
  const values = previous == null ? [] : Array.isArray(previous) ? previous : [previous];
  res.setHeader('Set-Cookie', [...values, value]);
}

function signupCookie(req) {
  if (!webSignupRequest(req)) return null;
  const part = String(req?.headers?.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(`${SIGNUP_COOKIE}=`));
  if (!part) return null;
  let raw;
  try { raw = decodeURIComponent(part.slice(SIGNUP_COOKIE.length + 1)); }
  catch { return null; }
  const separator = raw.indexOf('.');
  if (separator < 1) return null;
  return { signupId: raw.slice(0, separator), continuationSecret: raw.slice(separator + 1) };
}

function signupInput(req) {
  if (webSignupRequest(req)) return signupCookie(req) || { signupId: '', continuationSecret: '' };
  return {
    signupId: String(req?.body?.signup_id || ''),
    continuationSecret: String(req?.body?.continuation_secret || ''),
  };
}

function setSignupCookie(res, result) {
  const expires = new Date(result.expires_at).getTime();
  const seconds = Number.isFinite(expires)
    ? Math.max(60, Math.min(86_400, Math.ceil((expires - Date.now()) / 1000)))
    : 86_400;
  const value = encodeURIComponent(`${result.signup_id}.${result.continuation_secret}`);
  appendCookie(res, `${SIGNUP_COOKIE}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`);
}

function clearSignupCookie(res) {
  appendCookie(res, `${SIGNUP_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

function statusForError(error) {
  const code = String(error?.code || '');
  if (code === 'SIGNUP_RESEND_COOLDOWN' || code === 'SIGNUP_RESEND_LIMIT' || code === 'SIGNUP_CHALLENGE_LOCKED') return 429;
  if (code === 'EMAIL_INVALID' || code === 'USERNAME_BASE_INVALID' || code === 'PASSWORD_POLICY'
    || code === 'SIGNUP_CONTINUATION_INVALID' || code === 'SIGNUP_CHALLENGE_INVALID'
    || code === 'SIGNUP_CHALLENGE_EXPIRED' || code === 'SIGNUP_NOT_ACTIVE' || code === 'SIGNUP_RESEND_NOT_ALLOWED'
    || code === 'INSTALLATION_REQUIRED') return 400;
  if (code === 'INSTALLATION_CONFLICT' || code === 'INSTALLATION_CLAIM_BUSY'
    || code === 'ACCOUNT_ACTIVATION_PENDING' || code === 'SIGNUP_ACTIVATION_PENDING') return 409;
  if (code === 'SIGNUP_EXPIRED') return 410;
  return 503;
}

function publicError(error) {
  const code = String(error?.code || 'SIGNUP_UNAVAILABLE');
  const safeMessages = new Map([
    ['EMAIL_INVALID', 'Enter a valid email address.'],
    ['USERNAME_BASE_INVALID', 'Username must be 3-20 lowercase letters, digits, dots or underscores.'],
    ['PASSWORD_POLICY', 'Password must be between 8 and 200 characters.'],
    ['SIGNUP_CONTINUATION_INVALID', 'This signup session is no longer valid. Start again.'],
    ['SIGNUP_CHALLENGE_INVALID', 'That verification code is not valid.'],
    ['SIGNUP_CHALLENGE_EXPIRED', 'That verification challenge expired. Request a new code.'],
    ['SIGNUP_CHALLENGE_LOCKED', 'Too many verification attempts. Request a new code later.'],
    ['SIGNUP_RESEND_COOLDOWN', 'Please wait before requesting another verification email.'],
    ['SIGNUP_RESEND_LIMIT', 'Verification email limit reached. Try again later.'],
    ['SIGNUP_RESEND_NOT_ALLOWED', 'A verification email cannot be resent in the current signup state.'],
    ['SIGNUP_EXPIRED', 'This signup expired. Start again.'],
    ['SIGNUP_NOT_ACTIVE', 'This signup is no longer active.'],
    ['INSTALLATION_REQUIRED', 'A BeatGaler installation id is required to finish signup.'],
    ['INSTALLATION_CONFLICT', 'This BeatGaler installation already belongs to another account.'],
    ['INSTALLATION_CLAIM_BUSY', 'This BeatGaler installation is already being claimed. Try again.'],
    ['ACCOUNT_ACTIVATION_PENDING', 'Account setup is still being completed.'],
    ['SIGNUP_ACTIVATION_PENDING', 'Account setup is still being completed.'],
  ]);
  return { error: safeMessages.get(code) || 'Account creation is temporarily unavailable.', code };
}

function shouldOwnRegister(env = process.env) {
  // The legacy handler creates a permanent user and vault before verification.
  // It must never be reachable, including in development with the flag off.
  return true;
}

function createHandlerResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.locals = {};
  res.writableEnded = false;
  res.status = code => { res.statusCode = Number(code); return res; };
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
  res.getHeader = name => res.headers[String(name).toLowerCase()];
  res.json = body => { res.body = body; res.writableEnded = true; res.emit('finish'); return res; };
  res.send = body => { res.body = body; res.writableEnded = true; res.emit('finish'); return res; };
  return res;
}

async function invokeCapturedHandler(handler, body, { headers = {} } = {}) {
  if (typeof handler !== 'function') {
    throw Object.assign(new Error('Legacy authentication primitive is unavailable.'), { code: 'LEGACY_AUTH_PRIMITIVE_UNAVAILABLE' });
  }
  const req = {
    body: { ...(body || {}) },
    headers: { ...headers },
    query: {},
    params: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = createHandlerResponse();
  let nextError = null;
  const next = error => { if (error) nextError = error; };
  await Promise.resolve(handler(req, res, next));
  if (nextError) throw nextError;
  return { statusCode: Number(res.statusCode || 200), body: res.body, headers: res.headers };
}

function installPendingSignupBoundary(express, {
  service = null,
  env = process.env,
  activation = null,
} = {}) {
  const application = express?.application;
  if (!application) return null;
  if (application.__beatgalerPendingSignupBoundaryInstalled) return application.__beatgalerPendingSignupBoundaryRuntime || null;
  application.__beatgalerPendingSignupBoundaryInstalled = true;
  const previousPost = application.post;
  let routesInstalled = false;
  let routesInstalling = false;
  let legacyRegisterHandler = null;
  let legacyLoginHandler = null;

  function runtimeReady(res) {
    if (service) return true;
    res.status(503).json({ error: 'Account creation is temporarily unavailable.', code: 'PENDING_SIGNUP_RUNTIME_UNAVAILABLE' });
    return false;
  }

  function registrationAllowed(res) {
    if (publicRegistrationOpen(env)) return true;
    res.status(503).json({ error: 'Public registration is temporarily unavailable.', code: 'PUBLIC_REGISTRATION_CLOSED' });
    return false;
  }

  async function passwordLoginGate(req, res, next) {
    if (!service?.loginGate) return next();
    try {
      const gate = await service.loginGate(req?.body?.email ?? req?.body?.identifier ?? req?.body?.username);
      if (!gate?.blocked) return next();
      return res.status(409).json({
        error: 'Account activation is still finishing. Try again shortly.',
        code: 'ACCOUNT_ACTIVATION_PENDING',
        activation_status: gate.status,
      });
    } catch (error) {
      console.error('[auth] activation login gate failed:', error?.message || String(error));
      return res.status(503).json({ error: 'Authentication service is temporarily unavailable.', code: 'AUTH_ACTIVATION_GATE_UNAVAILABLE' });
    }
  }

  async function register(req, res) {
    if (!registrationAllowed(res) || !runtimeReady(res)) return;
    try {
      const result = await service.begin({
        email: req?.body?.email,
        usernameBase: req?.body?.username_base ?? req?.body?.usernameBase ?? req?.body?.username,
        password: req?.body?.password,
        installationId: req?.body?.beatgalerUserId ?? req?.body?.installationId ?? req?.body?.installation_id ?? null,
      });
      if (!result.created) {
        return res.status(202).json({
          ok: true,
          signup_pending: true,
          status: 'CHECK_EMAIL',
          message: 'If this address can be used, verification instructions will be sent.',
        });
      }
      if (webSignupRequest(req)) setSignupCookie(res, result);
      return res.status(202).json({
        ok: true,
        signup_pending: true,
        signup_id: result.signup_id,
        ...(result.recovered ? { recovered: true } : {}),
        ...(!webSignupRequest(req) ? { continuation_secret: result.continuation_secret } : {}),
        status: result.status,
        expires_at: result.expires_at,
        challenge_expires_at: result.challenge_expires_at,
      });
    } catch (error) {
      if (String(error?.code || '') === 'EMAIL_CONFLICT') {
        return res.status(202).json({
          ok: true,
          signup_pending: true,
          status: 'CHECK_EMAIL',
          message: 'If this address can be used, verification instructions will be sent.',
        });
      }
      return res.status(statusForError(error)).json(publicError(error));
    }
  }

  async function verify(req, res) {
    if (!runtimeReady(res)) return;
    try {
      const { signupId, continuationSecret } = signupInput(req);
      const result = await service.verify({
        signupId,
        continuationSecret,
        challenge: req?.body?.code ?? req?.body?.challenge,
      });
      let activationResult = null;
      if (result?.verified && typeof activation === 'function') {
        activationResult = await activation({ signupId, continuationSecret });
      }
      const status = activationResult?.status || result?.status || 'VERIFIED';
      if (status === 'ACTIVE' && webSignupRequest(req)) clearSignupCookie(res);
      return res.status(status === 'ACTIVE' ? 200 : 202).json({
        ok: true,
        signup_pending: status !== 'ACTIVE',
        ...result,
        ...(activationResult && typeof activationResult === 'object' ? activationResult : {}),
        ...(activationResult?.account && typeof activationResult.account === 'object' ? activationResult.account : {}),
      });
    } catch (error) {
      const status = statusForError(error);
      if (status === 429 && Number(error?.retryAfterMs) > 0) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(Number(error.retryAfterMs) / 1000))));
      }
      return res.status(status).json(publicError(error));
    }
  }

  async function resend(req, res) {
    if (!runtimeReady(res)) return;
    try {
      const result = await service.resend(signupInput(req));
      return res.status(202).json({ ok: true, signup_pending: true, ...result });
    } catch (error) {
      const status = statusForError(error);
      if (status === 429 && Number(error?.retryAfterMs) > 0) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(Number(error.retryAfterMs) / 1000))));
      }
      return res.status(status).json(publicError(error));
    }
  }

  async function signupStatus(req, res) {
    if (!runtimeReady(res)) return;
    try {
      const { signupId, continuationSecret } = signupInput(req);
      const result = await service.status({ signupId, continuationSecret });
      if (!result) return res.status(404).json({ error: 'Signup session was not found.', code: 'SIGNUP_NOT_FOUND' });
      // The coordinator decides whether an in-progress claim is still fresh or
      // stale enough to recover. Polling must reach it after a process crash.
      const retryable = ['VERIFIED', 'RETRYABLE', 'ACTIVATING', 'PROVISIONING'].includes(result.status);
      const activationResult = retryable && typeof activation === 'function'
        ? await activation({ signupId, continuationSecret })
        : null;
      const status = activationResult?.status || result.status;
      if (status === 'ACTIVE' && webSignupRequest(req)) clearSignupCookie(res);
      return res.json({
        ok: true,
        signup_pending: status !== 'ACTIVE',
        ...result,
        ...(activationResult && typeof activationResult === 'object' ? activationResult : {}),
        ...(activationResult?.account && typeof activationResult.account === 'object' ? activationResult.account : {}),
      });
    } catch (error) {
      return res.status(statusForError(error)).json(publicError(error));
    }
  }

  function ensureRoutes(app) {
    if (routesInstalled || routesInstalling) return;
    routesInstalling = true;
    try {
      app.post('/auth/signup/verify', (req, res) => { void verify(req, res); });
      app.post('/auth/signup/resend', (req, res) => { void resend(req, res); });
      app.post('/auth/signup/status', (req, res) => { void signupStatus(req, res); });
      routesInstalled = true;
    } finally {
      routesInstalling = false;
    }
  }

  const runtimeApi = {
    invokeLegacyRegister(body) { return invokeCapturedHandler(legacyRegisterHandler, body); },
    invokeLegacyLogin(body) { return invokeCapturedHandler(legacyLoginHandler, body); },
    captured() { return { register: Boolean(legacyRegisterHandler), login: Boolean(legacyLoginHandler) }; },
    _test: { createHandlerResponse, invokeCapturedHandler },
  };
  application.__beatgalerPendingSignupBoundaryRuntime = runtimeApi;

  application.post = function pendingSignupPost(routePath, ...handlers) {
    if (!routesInstalling) ensureRoutes(this);
    const pathName = String(routePath || '');
    const lastHandler = [...handlers].reverse().find(handler => typeof handler === 'function') || null;
    if (pathName === '/auth/register' && lastHandler) legacyRegisterHandler = lastHandler;
    if (pathName === '/auth/login' && lastHandler) legacyLoginHandler = lastHandler;

    if (pathName === '/auth/register' && shouldOwnRegister(env)) {
      return previousPost.call(this, routePath, (req, res) => { void register(req, res); }, ...handlers);
    }
    if (pathName === '/auth/login' && service?.loginGate) {
      return previousPost.call(this, routePath, (req, res, next) => { void passwordLoginGate(req, res, next); }, ...handlers);
    }
    return previousPost.call(this, routePath, ...handlers);
  };

  return runtimeApi;
}

module.exports = {
  statusForError,
  publicError,
  shouldOwnRegister,
  createHandlerResponse,
  invokeCapturedHandler,
  installPendingSignupBoundary,
};
