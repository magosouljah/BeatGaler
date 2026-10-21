'use strict';

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function passwordMaterial(runtime, info) {
  if (!info?.userId || !info?.user) return null;
  if (info.user.passwordHash) return info.user.passwordHash;
  try { return runtime?.passwordOverrideForUser?.(info.userId)?.passwordHash || null; }
  catch { return null; }
}

function hasVerifiedUniqueEmail(runtime, info) {
  if (!info?.userId || !info?.user) return false;
  const email = normalizedEmail(info.user.email);
  if (!email) return false;
  let verified = false;
  try { verified = runtime?._test?.publicStatusForUser?.(info.user)?.email_verified === true; }
  catch { return false; }
  if (!verified) return false;
  try {
    const users = runtime?._test?.accountsSnapshot?.()?.users || [];
    const owners = users.filter(user => normalizedEmail(user?.email) === email);
    return owners.length === 1 && String(owners[0]?.id || '') === String(info.userId);
  } catch {
    return false;
  }
}

function hasUsablePassword(runtime, info) {
  return Boolean(passwordMaterial(runtime, info)) && hasVerifiedUniqueEmail(runtime, info);
}

function reauthToken(req) {
  return String(req?.body?.reauthToken || req?.body?.reauth_token || req?.headers?.['x-beatgaler-reauth'] || '');
}

function consumeStrongReauth(runtime, req) {
  try { return runtime?._test?.consumeReauth?.(req, reauthToken(req)) || { ok: false, code: 'REAUTH_REQUIRED' }; }
  catch { return { ok: false, code: 'REAUTH_REQUIRED' }; }
}

function installSensitiveAuthContainment(express, runtime) {
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

  function protectPasswordChange(req, res, next) {
    const info = sessionInfo(req);
    if (!info) return next();
    if (hasUsablePassword(runtime, info)) return next();
    if (!hasVerifiedUniqueEmail(runtime, info)) {
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

  function protectProviderUnlink(req, res, next) {
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
    if (remainingProviders === 0 && !hasUsablePassword(runtime, info)) {
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
  reauthToken,
  consumeStrongReauth,
  installSensitiveAuthContainment,
};
