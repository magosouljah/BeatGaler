'use strict';

const { publicRegistrationOpen } = require('./auth-public-registration-hardening');

function statusForError(error) {
  const code = String(error?.code || '');
  if (code === 'SIGNUP_RESEND_COOLDOWN' || code === 'SIGNUP_RESEND_LIMIT' || code === 'SIGNUP_CHALLENGE_LOCKED') return 429;
  if (code === 'EMAIL_INVALID' || code === 'USERNAME_BASE_INVALID' || code === 'PASSWORD_POLICY'
    || code === 'SIGNUP_CONTINUATION_INVALID' || code === 'SIGNUP_CHALLENGE_INVALID'
    || code === 'SIGNUP_CHALLENGE_EXPIRED' || code === 'SIGNUP_NOT_ACTIVE' || code === 'SIGNUP_RESEND_NOT_ALLOWED') return 400;
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
  ]);
  return { error: safeMessages.get(code) || 'Account creation is temporarily unavailable.', code };
}

function installPendingSignupBoundary(express, {
  service = null,
  env = process.env,
  activation = null,
} = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerPendingSignupBoundaryInstalled) return;
  application.__beatgalerPendingSignupBoundaryInstalled = true;
  const previousPost = application.post;
  let routesInstalled = false;
  let routesInstalling = false;

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

  async function register(req, res) {
    if (!registrationAllowed(res) || !runtimeReady(res)) return;
    try {
      const result = await service.begin({
        email: req?.body?.email,
        usernameBase: req?.body?.username_base ?? req?.body?.username,
        password: req?.body?.password,
        installationId: req?.body?.installationId ?? req?.body?.installation_id ?? null,
      });
      if (!result.created) {
        return res.status(202).json({
          ok: true,
          signup_pending: true,
          status: 'CHECK_EMAIL',
          message: 'If this address can be used, verification instructions will be sent.',
        });
      }
      return res.status(202).json({
        ok: true,
        signup_pending: true,
        signup_id: result.signup_id,
        continuation_secret: result.continuation_secret,
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
      const continuationSecret = String(req?.body?.continuation_secret || '');
      const result = await service.verify({
        signupId: req?.body?.signup_id,
        continuationSecret,
        challenge: req?.body?.code ?? req?.body?.challenge,
      });
      let activationResult = null;
      if (result?.verified && typeof activation === 'function') {
        activationResult = await activation({ signupId: req?.body?.signup_id, continuationSecret });
      }
      const status = activationResult?.status || result?.status || 'VERIFIED';
      return res.status(status === 'ACTIVE' ? 200 : 202).json({
        ok: true,
        signup_pending: status !== 'ACTIVE',
        ...result,
        ...(activationResult && typeof activationResult === 'object' ? activationResult : {}),
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
      const result = await service.resend({
        signupId: req?.body?.signup_id,
        continuationSecret: String(req?.body?.continuation_secret || ''),
      });
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
      const result = await service.status({
        signupId: req?.body?.signup_id,
        continuationSecret: String(req?.body?.continuation_secret || ''),
      });
      if (!result) return res.status(404).json({ error: 'Signup session was not found.', code: 'SIGNUP_NOT_FOUND' });
      return res.json({ ok: true, signup_pending: result.status !== 'ACTIVE', ...result });
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

  application.post = function pendingSignupPost(routePath, ...handlers) {
    if (!routesInstalling) ensureRoutes(this);
    const pathName = String(routePath || '');
    if (pathName === '/auth/register') {
      return previousPost.call(this, routePath, (req, res) => { void register(req, res); }, ...handlers);
    }
    return previousPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  statusForError,
  publicError,
  installPendingSignupBoundary,
};
