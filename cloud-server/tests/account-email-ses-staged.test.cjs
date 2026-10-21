'use strict';

const assert = require('node:assert/strict');
const { renderAccountEmail, EMAIL_TEMPLATES } = require('../account-email-ses');

{
  const rendered = renderAccountEmail('email_change_confirmation', 'emc_secret', '2026-10-21T23:00:00.000Z');
  assert.equal(rendered.template_name, 'CONFIRM_EMAIL_CHANGE');
  assert.match(rendered.subject, /Confirm/i);
  assert.match(rendered.text, /emc_secret/);
  assert.match(rendered.html, /emc_secret/);
}

{
  const rendered = renderAccountEmail('email_changed_notice');
  assert.equal(rendered.template_name, 'EMAIL_CHANGED_NOTICE');
  assert.match(rendered.subject, /changed/i);
  assert.doesNotMatch(rendered.text, /undefined|null/);
  assert.doesNotMatch(rendered.html, /undefined|null/);
}

assert.equal(EMAIL_TEMPLATES.email_change_confirmation.requiresToken, true);
assert.equal(EMAIL_TEMPLATES.email_changed_notice.requiresToken, false);

console.log('account-email-ses staged templates tests: PASS');
