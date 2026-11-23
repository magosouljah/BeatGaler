'use strict';

const assert = require('node:assert/strict');
const { installStagedEmailChangeRoutes, statusForEmailChangeError, publicEmailChangeError } = require('../staged-email-change-routes');

assert.equal(statusForEmailChangeError({ code: 'EMAIL_CHANGE_RESEND_COOLDOWN' }), 429);
assert.equal(statusForEmailChangeError({ code: 'EMAIL_CHANGE_RESEND_LIMIT' }), 429);
assert.equal(publicEmailChangeError({ code: 'EMAIL_CHANGE_RESEND_COOLDOWN' }).error,
  'Wait before requesting another confirmation message.');

function fakeExpress() {
  const routes = new Map();
  const application = {
    post(routePath, ...handlers) {
      routes.set(String(routePath), handlers);
      return application;
    },
  };
  return { application, routes, json: () => function bodyJson() {} };
}

{
  const express = fakeExpress();
  const service = {
    async start() { return { ok: true }; },
    async resend() { return { ok: true }; },
    async confirm() { return { ok: true }; },
  };
  installStagedEmailChangeRoutes(express, service);
  express.application.post('/auth/login', () => {});

  assert.equal(express.routes.has('/auth/email/change/start'), true);
  assert.equal(express.routes.has('/auth/email/change/resend'), true);
  assert.equal(express.routes.has('/auth/email/change/confirm'), true);
  // X76: parser JSON propio antes del handler (se registran antes del express.json() global).
  for (const route of ['start', 'resend', 'confirm']) {
    const handlers = express.routes.get(`/auth/email/change/${route}`);
    assert.equal(handlers.length, 2, route);
    assert.equal(handlers[0].name, 'bodyJson', route);
  }
  assert.equal(express.routes.has('/auth/login'), true);

  const before = express.routes.size;
  express.application.post('/auth/session', () => {});
  assert.equal(express.routes.size, before + 1, 'staged routes must be installed only once');
}

console.log('staged-email-change-routes tests: PASS');
