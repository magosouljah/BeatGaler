'use strict';

const { createPortalService } = require('./billing-web-portal-route');

let service = null;
let failureCode = 'BILLING_PORTAL_NOT_INITIALIZED';

function configure(options) {
  service = null;
  failureCode = 'BILLING_PORTAL_UNAVAILABLE';
  try {
    service = createPortalService(options);
    failureCode = null;
  } catch (error) {
    if (error?.message === 'BILLING_CHECKOUT_ORIGIN_INVALID') failureCode = 'BILLING_PORTAL_ORIGIN_INVALID';
  }
  return status();
}

function status() { return Object.freeze({ ready: Boolean(service), failureCode }); }
function current() { return service; }

module.exports = { configure, status, current };
