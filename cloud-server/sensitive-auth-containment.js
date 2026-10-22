'use strict';

const { statusForUser } = require('./email-verification-authority');

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function passwordMaterial(runtime, info) {
  if (!info?.userId || !info?.user) return null;
  if (info.user.passwordHash) return info.user.passwordHash;
  try { return runtime?.passwordOverrideForUser?.(info.userId)?.passwordHash || null; }
  catch { return null; }
}

async function hasVerifiedUniqueEmail(_runtime, info, pool) {
  if (!info?.userId || !info?.user) return false;
  return (await statusForUser(pool, info.userId)).email_verified;
}

async function hasUsablePassword(runtime, info, pool) {
  return Boolean(passwordMaterial(runtime, info)) && await hasVerifiedUniqueEmail(runtime, info, pool);
}

async function hasVerifiedEmailShared(runtime, info, pool) {
  return hasVerifiedUniqueEmail(runtime, info, pool);
}

async function hasUsablePasswordShared(runtime, info, pool) {
  return hasUsablePassword(runtime, info, pool);
}

function reauthToken(req) {
  return String(req?.body?.reauthToken || req?.body?.reauth_token || req?.headers?.['x-beatgaler-reauth'] || '');
}

function consumeStrongReauth(runtime, req) {
  try { return runtime?._test?.consumeReauth?.(req, reauthToken(req)) || { ok: false, code: 'REAUTH_REQUIRED' }; }
  catch { return { ok: false, code: 'REAUTH_REQUIRED' }; }
}

function installSensitiveAuthContainment(express, runtime, { pool = null } = {}) {
  const application = express?.application;
  if (!application || !runtime || application.__beatgalerSensitiveAuthContainmentInstalled) return;
  application.__beatgalerSensitiveAuthContainmentInstalled = true;
  const previousPost = application.post;

  function sessionInfo(req) {
    try { return runtime._test.sessionInfoFromRequest(req); }
    catch { return null; }
  }

  function blockLegacyEmailChange(_req, res) {
    return res.status(409).json({
      error: 'Email changes require confirmation of the new address. Use the staged email-change flow.',
      code: 'EMAIL_CHANGE_STAGED_REQUIRED',
    });
  }

  async function protectPasswordChange(req, res, next) {
    const info = sessionInfo(req);
    if (!info) return next();
    let usable;
    let verified;
    try {
      usable = await hasUsablePasswordShared(runtime, info, pool);
      verified = usable || await hasVerifiedEmailShared(runtime, info, pool);
    } catch {
      return res.status(503).json({ error: 'Authentication service is temporarily unavailable.', code: 'AUTH_SERVICE_UNAVAILABLE' });
    }
    if (usable) return next();
    if (!verified) {
      return res.status(409).json({
        error: 'A unique verified email is required before password can be used as a sign-in method.',
        code: 'PASSWORD_VERIFIED_EMAIL_REQUIRED',
      });
    }
    const grant = consumeStrongReauth(runtime, req);
    if (!grant.ok) {
      return res.status(401).json({
        error: 'Recent reauthentication is required before adding or replacing this credential.',
        code: grant.code || 'REAUTH_REQUIRED',
      });
    }
    next();
  }

  function protectProviderLink(req, res, next) {
    if (String(req?.body?.purpose || '').toLowerCase() === 'reauth') return next();
    const info = sessionInfo(req);
    if (!info) return next();
    const provider = String(req?.body?.provider || '').toLowerCase();
    if (!provider) return next();
    if (info.user?.providers?.[provider]?.id) {
      return res.status(409).json({
        error: 'That provider is already connected. Replacing a provider identity is not implicit.',
        code: 'PROVIDER_REPLACEMENT_REAUTH_REQUIRED',
      });
    }
    const grant = consumeStrongReauth(runtime, req);
    if (!grant.ok) {
      return res.status(401).json({
        error: 'Recent reauthentication is required before connecting a sign-in provider.',
        code: grant.code || 'REAUTH_REQUIRED',
      });
    }
    next();
  }

  async function protectProviderUnlink(req, res, next) {
    const info = sessionInfo(req);
    if (!info) return next();
    const provider = String(req?.body?.provider || '').toLowerCase();
    if (!provider) return next();
    const grant = consumeStrongReauth(runtime, req);
    if (!grant.ok) {
      return res.status(401).json({
        error: 'Recent reauthentication is required before disconnecting a sign-in provider.',
        code: grant.code || 'REAUTH_REQUIRED',
      });
    }
    const remainingProviders = Object.keys(info.user.providers || {})
      .filter(key => key !== provider && info.user.providers?.[key]?.id).length;
    let usable = false;
    try { usable = await hasUsablePasswordShared(runtime, info, pool); }
    catch { return res.status(503).json({ error: 'Authentication service is temporarily unavailable.', code: 'AUTH_SERVICE_UNAVAILABLE' }); }
    if (remainingProviders === 0 && !usable) {
      return res.status(409).json({
        error: 'Add another usable sign-in method before disconnecting this provider.',
        code: 'LAST_SIGNIN_METHOD_REQUIRED',
      });
    }
    next();
  }

  application.post = function sensitiveAuthPost(routePath, ...handlers) {
    const pathName = String(routePath || '');
    if (pathName === '/auth/email/change') {
      return previousPost.call(this, routePath, blockLegacyEmailChange, ...handlers);
    }
    if (pathName === '/auth/password/change') {
      return previousPost.call(this, routePath, protectPasswordChange, ...handlers);
    }
    if (pathName === '/auth/oauth/start') {
      return previousPost.call(this, routePath, protectProviderLink, ...handlers);
    }
    if (pathName === '/auth/oauth/disconnect') {
      return previousPost.call(this, routePath, protectProviderUnlink, ...handlers);
    }
    return previousPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  normalizedEmail,
  passwordMaterial,
  hasVerifiedUniqueEmail,
  hasUsablePassword,
  hasVerifiedEmailShared,
  hasUsablePasswordShared,
  reauthToken,
  consumeStrongReauth,
  installSensitiveAuthContainment,
};
