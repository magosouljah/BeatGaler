'use strict';

const assert = require('node:assert/strict');
const { renderAccountEmail, EMAIL_TEMPLATES } = require('../account-email-ses');

{
  const expiresAt = '2026-10-21T23:00:00.000Z';
  const rendered = renderAccountEmail('email_verification', '123-123', expiresAt);
  const expectedText = `BeatGaler

Confirm your email address

Use this verification code to continue:

123-123

This code expires in 10 minutes.

If you didn’t request this, you can ignore this email.

Thanks,
BeatGaler`;

  assert.equal(rendered.template_name, 'VERIFY_EMAIL');
  assert.equal(rendered.subject, 'Your BeatGaler verification code');
  assert.equal(rendered.text, expectedText);
  assert.match(rendered.html, /Confirm your email address/);
  assert.match(rendered.html, /Use this verification code to continue:/);
  assert.match(rendered.html, />123-123</);
  assert.match(rendered.html, /This code expires in 10 minutes\./);
  assert.match(rendered.html, /If you didn’t request this, you can ignore this email\./);
  assert.match(rendered.html, /text-align:center/);
  assert.match(rendered.html, /max-width:460px/);
  assert.match(rendered.html, /font-size:42px/);
  assert.match(rendered.html, /letter-spacing:6px/);
  assert.doesNotMatch(rendered.text, new RegExp(expiresAt));
  assert.doesNotMatch(rendered.html, new RegExp(expiresAt));
  assert.doesNotMatch(rendered.html, /<a\b|href\s*=|<button\b/i);
}

{
  const rendered = renderAccountEmail('password_reset', 'reset_secret', '2026-10-21T23:00:00.000Z');
  assert.equal(rendered.template_name, 'RESET_PASSWORD');
  assert.match(rendered.text, /reset_secret/);
  assert.match(rendered.text, /Expires: 2026-10-21T23:00:00\.000Z/);
  assert.match(rendered.html, /reset_secret/);
}

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
