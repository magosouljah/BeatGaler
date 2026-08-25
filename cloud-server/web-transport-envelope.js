"use strict";

/**
 * Legacy call-site compatibility only.
 *
 * Productive transport authentication is now transformed by
 * productive-temp-auth-boundary.js after the authenticated route has selected
 * a transport lease. This function must never encrypt or expose bot tokens,
 * API hashes, API IDs, or permanent auth material for a client.
 */
function wrapWebTransportSession(session) {
  return session;
}

module.exports = { wrapWebTransportSession };
