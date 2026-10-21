'use strict';

const assert = require('node:assert/strict');
const { installStagedEmailChangeRoutes } = require('../staged-email-change-routes');

function fakeExpress() {
  const routes = new Map();
  const application = {
    post(routePath, ...handlers) {
      routes.set(String(routePath), handlers);
      return application;
    },
  };
  return { application, routes };
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
  assert.equal(express.routes.has('/auth/login'), true);

  const before = express.routes.size;
  express.application.post('/auth/session', () => {});
  assert.equal(express.routes.size, before + 1, 'staged routes must be installed only once');
}

console.log('staged-email-change-routes tests: PASS');
