'use strict';

const { wrapRuntimeUse } = require('./runtime-operability');
const { wrapSecurityHeadersUse } = require('./security-headers');
const { wrapSessionSecurityUse, wrapSessionSecurityPost } = require('./session-security');
const { wrapLifecycleRequestGuardUse } = require('./account-lifecycle-request-guard');
const { wrapHttpContainmentPost, wrapHttpContainmentGet } = require('./http-containment');
const { wrapDirectCapabilityPost } = require('./direct-capability-boundary');
const { wrapSensitiveAuthCapabilityRevocationPost } = require('./sensitive-auth-capability-revocation');
const { wrapDurableAuthAbusePost } = require('./auth-durable-abuse-controls');
const { wrapAuthAbusePost } = require('./auth-abuse-controls');
const { wrapProductiveTempAuthPost } = require('./productive-temp-auth-boundary');

// Each wrap delegates to the entries installed before it. The POST/GET suffix
// delegates to the earlier prototype guards through the original app methods.
const ROUTE_GUARD_TABLE = Object.freeze([
  { id: 'runtime-operability', method: 'use', wrap: wrapRuntimeUse },
  { id: 'security-headers', method: 'use', wrap: wrapSecurityHeadersUse },
  { id: 'session-security', method: 'use', wrap: wrapSessionSecurityUse },
  { id: 'account-lifecycle-request-guard', method: 'use', wrap: wrapLifecycleRequestGuardUse },
  { id: 'session-security', method: 'post', wrap: wrapSessionSecurityPost },
  { id: 'http-containment', method: 'post', wrap: wrapHttpContainmentPost },
  { id: 'http-containment', method: 'get', wrap: wrapHttpContainmentGet },
  { id: 'direct-capability-boundary', method: 'post', wrap: wrapDirectCapabilityPost },
  { id: 'sensitive-auth-capability-revocation', method: 'post', wrap: wrapSensitiveAuthCapabilityRevocationPost },
  { id: 'auth-durable-abuse-controls', method: 'post', wrap: wrapDurableAuthAbusePost },
  { id: 'auth-abuse-controls', method: 'post', wrap: wrapAuthAbusePost },
  { id: 'productive-temp-auth-boundary', method: 'post', wrap: wrapProductiveTempAuthPost },
]);

// These routes are registered on the first app.post(), by the earlier prototype
// guards and the session-security table entry.
const SELF_REGISTERED_ROUTES = Object.freeze([
  '/auth/signup/verify',
  '/auth/signup/resend',
  '/auth/signup/status',
  '/auth/email/verification/request',
  '/auth/email/verification/confirm',
  '/auth/password/reset/request',
  '/auth/password/reset/complete',
  '/auth/reauth',
  '/auth/mfa/recovery/regenerate',
  '/auth/security/notifications',
  '/auth/lifecycle/status',
  '/auth/account/export',
  '/auth/account/delete',
  '/auth/email/change/start',
  '/auth/email/change/resend',
  '/auth/email/change/confirm',
  '/auth/sessions',
  '/auth/sessions/revoke',
  '/auth/sessions/revoke-all',
]);

function mountAccountRouteGuards(app, table = ROUTE_GUARD_TABLE) {
  const methods = new Map();
  for (const { method, wrap } of table) {
    const previous = methods.get(method) || app[method];
    methods.set(method, function guardedRouteRegistration(routePathOrHandlers, ...handlers) {
      return wrap.call({ app: this, next: previous.bind(this) }, routePathOrHandlers, handlers);
    });
  }
  for (const [method, register] of methods) app[method] = register;
}

module.exports = { ROUTE_GUARD_TABLE, SELF_REGISTERED_ROUTES, mountAccountRouteGuards };
