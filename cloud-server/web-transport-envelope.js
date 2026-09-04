"use strict";

/**
 * Legacy call-site compatibility only.
 *
 * Productive transport authentication is now transformed by
 * productive-temp-auth-boundary.js after the authenticated route has selected
 * a transport lease. This function must never encrypt or expose bot tokens,
 * API hashes, or permanent auth material for a client. The controlled boundary
 * may expose the numeric application id required by MTProto initConnection;
 * that identifier is not sufficient to authorize/login without the API hash.
 */
function wrapWebTransportSession(session) {
  return session;
}

module.exports = { wrapWebTransportSession };
