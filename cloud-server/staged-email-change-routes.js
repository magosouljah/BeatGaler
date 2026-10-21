'use strict';

function statusForEmailChangeError(error) {
  const code = String(error?.code || 'EMAIL_CHANGE_UNAVAILABLE');
  if (code === 'SESSION_REQUIRED' || code.startsWith('REAUTH_')) return 401;
  if (code === 'EMAIL_CHANGE_CONFLICT' || code === 'EMAIL_CHANGE_STALE') return 409;
  if (code === 'EMAIL_CHANGE_DELIVERY_UNAVAILABLE' || code === 'EMAIL_CHANGE_DELIVERY_FAILED'
      || code === 'EMAIL_VERIFICATION_AUTHORITY_UNAVAILABLE' || code === 'EMAIL_CHANGE_LOCAL_COMMIT_UNAVAILABLE'
      || code === 'EMAIL_CHANGE_NOTICE_PENDING') return 503;
  return 400;
}

function publicEmailChangeError(error) {
  const code = String(error?.code || 'EMAIL_CHANGE_UNAVAILABLE');
  const safe = new Map([
    ['SESSION_REQUIRED', 'Session expired. Sign in again.'],
    ['REAUTH_REQUIRED', 'Recent reauthentication is required.'],
    ['REAUTH_SCOPE_DENIED', 'Recent reauthentication belongs to a different session.'],
    ['EMAIL_INVALID', 'Enter a valid email address.'],
    ['EMAIL_CHANGE_OLD_EMAIL_REQUIRED', 'This account needs a sign-in email before it can be changed.'],
    ['EMAIL_CHANGE_SAME_EMAIL', 'The new email must be different from the current email.'],
    ['EMAIL_CHANGE_CONFLICT', 'That email is already attached to another BeatGaler account.'],
    ['EMAIL_CHANGE_NOT_PENDING', 'No email change is waiting for confirmation.'],
    ['EMAIL_CHANGE_EXPIRED', 'This email-change request expired. Start again.'],
    ['EMAIL_CHANGE_INVALID', 'Email-change code is invalid or expired.'],
    ['EMAIL_CHANGE_LOCKED', 'Too many invalid email-change attempts. Start again.'],
    ['EMAIL_CHANGE_STALE', 'The account email changed while this request was pending. Start again.'],
    ['EMAIL_CHANGE_DELIVERY_UNAVAILABLE', 'Email delivery is temporarily unavailable.'],
    ['EMAIL_CHANGE_DELIVERY_FAILED', 'The verification message could not be delivered. Retry safely.'],
    ['EMAIL_CHANGE_NOTICE_PENDING', 'The previous email-change notice is still being delivered. Try again shortly.'],
  ]);
  return { error: safe.get(code) || 'Email change is temporarily unavailable.', code };
}

function installStagedEmailChangeRoutes(express, service) {
  const application = express?.application;
  if (!application || !service || application.__beatgalerStagedEmailChangeRoutesInstalled) return;
  application.__beatgalerStagedEmailChangeRoutesInstalled = true;
  const previousPost = application.post;
  let routesInstalled = false;
  let routesInstalling = false;

  function fail(res, error) {
    return res.status(statusForEmailChangeError(error)).json(publicEmailChangeError(error));
  }

  function ensureRoutes(app) {
    if (routesInstalled || routesInstalling) return;
    routesInstalling = true;
    try {
      app.post('/auth/email/change/start', (req, res) => {
        void service.start(req, req?.body?.email)
          .then(result => res.status(202).json(result))
          .catch(error => fail(res, error));
      });
      app.post('/auth/email/change/resend', (req, res) => {
        void service.resend(req)
          .then(result => res.status(202).json(result))
          .catch(error => fail(res, error));
      });
      app.post('/auth/email/change/confirm', (req, res) => {
        void service.confirm(req, req?.body?.token || req?.body?.code)
          .then(result => res.json(result))
          .catch(error => fail(res, error));
      });
      routesInstalled = true;
    } finally {
      routesInstalling = false;
    }
  }

  application.post = function stagedEmailChangeRoutesPost(routePath, ...handlers) {
    if (!routesInstalling) ensureRoutes(this);
    return previousPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  statusForEmailChangeError,
  publicEmailChangeError,
  installStagedEmailChangeRoutes,
};
