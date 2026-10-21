'use strict';

function hasUsablePassword(runtime, info) {
  if (!info?.userId || !info?.user) return false;
  if (info.user.passwordHash) return true;
  try { return Boolean(runtime?.passwordOverrideForUser?.(info.userId)?.passwordHash); }
  catch { return false; }
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
      error: 'Email changes require confirmation of the new address. This legacy route is disabled until the staged email-change flow completes.',
      code: 'EMAIL_CHANGE_STAGED_REQUIRED',
    });
  }

  function blockOAuthOnlyPasswordBootstrap(req, res, next) {
    const info = sessionInfo(req);
    if (!info) return next();
    if (hasUsablePassword(runtime, info)) return next();
    return res.status(409).json({
      error: 'Provider reauthentication and a verified email are required before adding a password.',
      code: 'PASSWORD_BOOTSTRAP_REAUTH_REQUIRED',
    });
  }

  function preventImplicitProviderReplacement(req, res, next) {
    if (String(req?.body?.purpose || '').toLowerCase() === 'reauth') return next();
    const info = sessionInfo(req);
    if (!info) return next();
    const provider = String(req?.body?.provider || '').toLowerCase();
    if (!provider || !info.user?.providers?.[provider]?.id) return next();
    return res.status(409).json({
      error: 'That provider is already connected. Replacing a provider identity requires explicit reauthentication.',
      code: 'PROVIDER_REPLACEMENT_REAUTH_REQUIRED',
    });
  }

  application.post = function sensitiveAuthPost(routePath, ...handlers) {
    const pathName = String(routePath || '');
    if (pathName === '/auth/email/change') {
      return previousPost.call(this, routePath, blockLegacyEmailChange, ...handlers);
    }
    if (pathName === '/auth/password/change') {
      return previousPost.call(this, routePath, blockOAuthOnlyPasswordBootstrap, ...handlers);
    }
    if (pathName === '/auth/oauth/start') {
      return previousPost.call(this, routePath, preventImplicitProviderReplacement, ...handlers);
    }
    return previousPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  installSensitiveAuthContainment,
  hasUsablePassword,
};
