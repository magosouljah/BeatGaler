'use strict';

/**
 * Deprecated compatibility stub.
 *
 * Public signup activation must use signup-activation-coordinator.js, which
 * operates on stable user.id, PostgreSQL authority and the in-process core
 * bridge. Re-entering /auth/register or /auth/login from activation is
 * intentionally forbidden.
 */
function createPendingSignupActivation() {
  const error = new Error('Legacy-handler signup activation is disabled. Use createSignupActivationCoordinator instead.');
  error.code = 'LEGACY_SIGNUP_ACTIVATION_DISABLED';
  throw error;
}

module.exports = {
  createPendingSignupActivation,
};
