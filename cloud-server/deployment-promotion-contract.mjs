import assert from 'node:assert/strict';

const SHA_RE = /^[0-9a-f]{40}$/;

export function assertPublicHttpsOrigin(value, label = 'API origin') {
  assert.equal(typeof value, 'string', `${label} must be configured`);
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `${label} must use TLS (https)`);
  assert.ok(url.hostname, `${label} must include a hostname`);
  assert.ok(!['localhost', '127.0.0.1', '::1'].includes(url.hostname), `${label} must not use a local fallback`);
  assert.ok(!url.hostname.endsWith('.ts.net'), `${label} must not use a Tailscale fallback`);
  assert.equal(url.username, '', `${label} must not embed credentials`);
  assert.equal(url.password, '', `${label} must not embed credentials`);
  return url.origin;
}

export function validatePromotion(input) {
  const { sourceSha, artifactSha, target, trigger, approved = false, apiOrigin, requiredHeaders = {} } = input;
  assert.match(sourceSha ?? '', SHA_RE, 'sourceSha must be an exact 40-char git SHA');
  assert.equal(artifactSha, sourceSha, 'promotion must deploy the same source SHA');
  assert.ok(['preview', 'staging', 'production'].includes(target), 'unknown deployment target');
  if (target === 'preview') assert.equal(trigger, 'pull_request', 'preview must be PR-triggered');
  if (target === 'staging') assert.equal(trigger, 'candidate_tag', 'staging must be candidate-tag-triggered');
  if (target === 'production') {
    assert.equal(trigger, 'approval', 'production must be approval-triggered');
    assert.equal(approved, true, 'production promotion requires explicit approval');
  }
  const origin = assertPublicHttpsOrigin(apiOrigin);
  for (const [name, value] of Object.entries(requiredHeaders)) {
    assert.ok(name.trim(), 'required header name must be non-empty');
    assert.equal(typeof value, 'string', `required header ${name} must be injectable text`);
    assert.ok(value.length > 0, `required header ${name} must be configured`);
  }
  return { sourceSha, target, origin, requiredHeaders: { ...requiredHeaders } };
}

export function validateRollback(input) {
  const { currentSha, previousSha, databaseCompatibility, smokePassed } = input;
  assert.match(currentSha ?? '', SHA_RE, 'currentSha must be exact');
  assert.match(previousSha ?? '', SHA_RE, 'previousSha must be exact');
  assert.notEqual(previousSha, currentSha, 'rollback target must be a previous artifact');
  assert.equal(databaseCompatibility, 'compatible', 'rollback must fail closed without DB compatibility evidence');
  assert.equal(smokePassed, true, 'rollback target must have a passing smoke result');
  return { rollbackTo: previousSha };
}
