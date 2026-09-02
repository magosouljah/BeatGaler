import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const checkDist = process.argv.includes('--dist');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const securityPath = 'public/.well-known/security.txt';
const statusPath = 'public/status/index.html';
const productionNginxPath = 'deploy/web/beatgaler.com.conf';
const installerPath = 'deploy/web/install-web-production.sh';
const deployScriptPath = 'scripts/deploy-web-production.ps1';

assert.ok(existsSync(resolve(root, securityPath)), `${securityPath} must exist`);
const security = read(securityPath);
assert.match(security, /^Contact: mailto:security@beatgaler\.com$/m);
assert.match(security, /^Contact: mailto:abuse@beatgaler\.com$/m);
assert.match(security, /^Preferred-Languages: en, es$/m);
assert.match(security, /^Canonical: https:\/\/beatgaler\.com\/\.well-known\/security\.txt$/m);

const expiresMatches = [...security.matchAll(/^Expires:\s*(\S+)$/gm)];
assert.equal(expiresMatches.length, 1, 'security.txt must contain exactly one Expires field');
const expiresAt = Date.parse(expiresMatches[0][1]);
assert.ok(Number.isFinite(expiresAt), 'security.txt Expires must be an RFC3339 timestamp');
const now = Date.now();
const day = 24 * 60 * 60 * 1000;
assert.ok(expiresAt > now + 30 * day, 'security.txt expires within 30 days; renew it before publishing');
assert.ok(expiresAt < now + 366 * day, 'security.txt Expires must remain less than one year ahead');

const nginx = read(productionNginxPath);
const securityLocation = nginx.match(/location\s*=\s*\/\.well-known\/security\.txt\s*\{([\s\S]*?)\n\s*\}/);
assert.ok(securityLocation, 'Nginx must define an exact security.txt location');
assert.match(securityLocation[1], /try_files\s+\$uri\s+=404;/, 'security.txt must return 404 instead of SPA fallback when absent');
assert.match(securityLocation[1], /default_type\s+"text\/plain; charset=utf-8";/, 'security.txt must use text/plain; charset=utf-8');
assert.doesNotMatch(securityLocation[1], /index\.html/, 'security.txt route must not use SPA index fallback');

const sourceLocation = nginx.match(/location\s*=\s*\/\.well-known\/source-sha\.txt\s*\{([\s\S]*?)\n\s*\}/);
assert.ok(sourceLocation, 'Nginx must define an exact deployment source SHA location');
assert.match(sourceLocation[1], /try_files\s+\$uri\s+=404;/, 'source SHA route must return 404 instead of SPA fallback when absent');
assert.match(sourceLocation[1], /no-cache, no-store, must-revalidate/, 'source SHA route must not be cached');
assert.doesNotMatch(sourceLocation[1], /index\.html/, 'source SHA route must not use SPA index fallback');

assert.match(nginx, /server_name\s+status\.beatgaler\.com;/, 'Nginx must support status.beatgaler.com');
assert.match(nginx, /try_files\s+\/status\/index\.html\s+=404;/, 'status host must serve the static status document directly');

assert.ok(existsSync(resolve(root, statusPath)), `${statusPath} must exist`);
const status = read(statusPath);
for (const label of ['BeatGaler Web', 'API', 'Authentication', 'Galer Cloud / Storage', 'Overall status']) {
  assert.ok(status.includes(label), `status page must include ${label}`);
}
for (const contact of ['support@beatgaler.com', 'security@beatgaler.com', 'abuse@beatgaler.com']) {
  assert.ok(status.includes(`mailto:${contact}`), `status page must link ${contact}`);
}

const forbiddenStatusPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /AKIA[0-9A-Z]{16}/,
  /aws_secret_access_key/i,
  /bot[_-]?token/i,
  /client_secret/i,
  /database_url/i,
  /private[_-]?key/i,
  /bearer\s+[a-z0-9._~-]{12,}/i,
  /127\.0\.0\.1/,
  /localhost/i,
  /\/web-health\b/i,
  /\/beatgaler-api\b/i,
];
for (const pattern of forbiddenStatusPatterns) {
  assert.doesNotMatch(status, pattern, `status page contains forbidden sensitive/internal pattern: ${pattern}`);
}

const installer = read(installerPath);
assert.match(installer, /STATUS_HOST="status\.beatgaler\.com"/);
assert.match(installer, /shares_ip_with_api "\$STATUS_HOST"/);
assert.match(installer, /CERTBOT_ARGS\+\=\(-d "\$STATUS_HOST"\)/, 'TLS SAN for status must be conditional on DNS readiness');
assert.match(installer, /EXPECTED_SOURCE_SHA="\$\{4:-\}"/, 'installer must receive the expected source SHA separately from the archive');
assert.match(installer, /source-sha\.txt/, 'installer must require a packaged source SHA marker');
assert.match(installer, /ACTUAL_SOURCE_SHA=.*tr -d/, 'installer must read the packaged source SHA marker');
assert.match(installer, /ACTUAL_SOURCE_SHA" != "\$EXPECTED_SOURCE_SHA/, 'installer must fail closed when archive SHA and expected SHA differ');
assert.match(installer, /\.well-known\/source-sha\.txt" \| grep -Fxq "\$EXPECTED_SOURCE_SHA"/, 'installer must verify the active local HTTPS source marker');
assert.match(installer, /WEB_RUNTIME_SOURCE_PROOF_OK source=\$EXPECTED_SOURCE_SHA/, 'installer must emit explicit runtime/source proof');

const deployScript = read(deployScriptPath);
assert.match(deployScript, /git rev-parse HEAD/, 'production deploy must derive an exact Git HEAD');
assert.match(deployScript, /git status --porcelain --untracked-files=all/, 'production deploy must reject an unclean working tree');
assert.match(deployScript, /Refusing production Web deployment from a dirty working tree/, 'production deploy must fail closed on local modifications');
assert.match(deployScript, /source-sha\.txt/, 'production deploy must package the source SHA marker');
assert.match(deployScript, /install-web-production\.sh[^\r\n]*\$SourceSha/, 'production deploy must pass the expected SHA to the EC2 installer');
assert.match(deployScript, /https:\/\/beatgaler\.com\/\.well-known\/source-sha\.txt/, 'production deploy must read back the public source marker');
assert.match(deployScript, /Production source proof mismatch/, 'production deploy must fail closed when public runtime reports another SHA');
assert.match(deployScript, /WEB_RUNTIME_SOURCE_PROOF_OK source=\$SourceSha/, 'production deploy must emit explicit public runtime/source proof');

if (checkDist) {
  const builtSecurityPath = 'dist/.well-known/security.txt';
  const builtStatusPath = 'dist/status/index.html';
  assert.ok(existsSync(resolve(root, builtSecurityPath)), `${builtSecurityPath} must exist after Web build`);
  assert.ok(existsSync(resolve(root, builtStatusPath)), `${builtStatusPath} must exist after Web build`);
  assert.equal(read(builtSecurityPath), security, 'built security.txt must match the canonical source file');
  assert.equal(read(builtStatusPath), status, 'built status page must match the canonical source file');
}

console.log(`PUBLIC_OPERATIONS_VALIDATION_OK mode=${checkDist ? 'dist' : 'source'}`);
