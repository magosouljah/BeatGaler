'use strict';

const fs = require('fs');

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing expected source for ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`expected exactly one source match for ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const containmentPath = 'cloud-server/http-containment.js';
let source = fs.readFileSync(containmentPath, 'utf8');
source = replaceOnce(
  source,
  '  const pendingInstallationClaims = new Map();',
  '  const pendingInstallationClaims = new Map();\n  const installationClaimCoordinator = options.installationClaimCoordinator || null;',
  'claim coordinator option',
);

source = replaceOnce(
  source,
  String.raw`  function reserveInstallationClaim(res, installationId, claimant) {
    const id = String(installationId || "").trim();
    if (!id) return true;
    const current = pendingInstallationClaims.get(id);
    if (current) {
      sendJson(res, 403, "This installation is already being claimed by another authenticated flow. Try again.");
      return false;
    }
    const marker = { claimant: String(claimant || "unknown"), startedAt: now() };
    pendingInstallationClaims.set(id, marker);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (pendingInstallationClaims.get(id) === marker) pendingInstallationClaims.delete(id);
    };
    res.once("finish", release);
    res.once("close", release);
    return true;
  }`,
  String.raw`  async function reserveInstallationClaim(res, installationId, claimant) {
    const id = String(installationId || "").trim();
    if (!id) return true;

    if (installationClaimCoordinator) {
      let releaseClaim;
      try {
        releaseClaim = await installationClaimCoordinator.tryAcquire(id, claimant);
      } catch {
        sendJson(res, 503, "Authorization claim coordination is unavailable. Try again shortly.");
        return false;
      }
      if (!releaseClaim) {
        sendJson(res, 403, "This installation is already being claimed by another authenticated flow. Try again.");
        return false;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        void Promise.resolve(releaseClaim()).catch(() => {});
      };
      res.once("finish", release);
      res.once("close", release);
      return true;
    }

    const current = pendingInstallationClaims.get(id);
    if (current) {
      sendJson(res, 403, "This installation is already being claimed by another authenticated flow. Try again.");
      return false;
    }
    const marker = { claimant: String(claimant || "unknown"), startedAt: now() };
    pendingInstallationClaims.set(id, marker);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (pendingInstallationClaims.get(id) === marker) pendingInstallationClaims.delete(id);
    };
    res.once("finish", release);
    res.once("close", release);
    return true;
  }`,
  'claim reservation implementation',
);

const replacements = [
  ['  function guardRegisterInstallation(req, res, next) {', '  async function guardRegisterInstallation(req, res, next) {', 'register async'],
  ['    if (!reserveInstallationClaim(res, installationId, `register:${String(req.body?.email || "").trim().toLowerCase()}`)) return;', '    if (!(await reserveInstallationClaim(res, installationId, `register:${String(req.body?.email || "").trim().toLowerCase()}`))) return;', 'register await'],
  ['  function guardLoginInstallation(req, res, next) {', '  async function guardLoginInstallation(req, res, next) {', 'login async'],
  ['    if (!reserveInstallationClaim(res, installationId, candidate?.id || `login:${String(req.body?.identifier || req.body?.username || "").trim().toLowerCase()}`)) return;', '    if (!(await reserveInstallationClaim(res, installationId, candidate?.id || `login:${String(req.body?.identifier || req.body?.username || "").trim().toLowerCase()}`))) return;', 'login await'],
  ['  function guardSessionRebind(req, res, next) {', '  async function guardSessionRebind(req, res, next) {', 'session async'],
  ['    if (!current && !reserveInstallationClaim(res, installationId, auth.user.id)) return;', '    if (!current && !(await reserveInstallationClaim(res, installationId, auth.user.id))) return;', 'session await'],
  ['  function guardOAuthCallback(req, res, next) {', '  async function guardOAuthCallback(req, res, next) {', 'oauth callback async'],
  ['    if (!current && !reserveInstallationClaim(res, guard.installationId, guard.expectedOwnerId || `oauth:${guard.flowId}`)) {', '    if (!current && !(await reserveInstallationClaim(res, guard.installationId, guard.expectedOwnerId || `oauth:${guard.flowId}`))) {', 'oauth callback await'],
];
for (const [before, after, label] of replacements) source = replaceOnce(source, before, after, label);
fs.writeFileSync(containmentPath, source, 'utf8');

const regressionPath = 'scripts/regression-http-containment.mjs';
let regression = fs.readFileSync(regressionPath, 'utf8');
for (const method of ['guardLoginInstallation', 'guardSessionRebind', 'guardOAuthCallback']) {
  const before = `containment.${method}(`;
  const count = regression.split(before).length - 1;
  if (count < 1) throw new Error(`missing regression callsites for ${method}`);
  regression = regression.replaceAll(before, `await containment.${method}(`);
}
fs.writeFileSync(regressionPath, regression, 'utf8');

const workflowPath = '.github/workflows/test-desktop-portability.yml';
let workflow = fs.readFileSync(workflowPath, 'utf8');
workflow = replaceOnce(
  workflow,
  String.raw`      - name: Execute migrations and adversarial persistence checks on PostgreSQL
        run: node cloud-server/tests/postgres-live.integration.cjs
`,
  String.raw`      - name: Execute migrations and adversarial persistence checks on PostgreSQL
        run: node cloud-server/tests/postgres-live.integration.cjs

      - name: Verify D6 PostgreSQL claim coordinator and real cross-process atomicity
        run: |
          node cloud-server/tests/postgres-installation-claim-coordinator.test.cjs
          node cloud-server/tests/postgres-installation-claim-cross-process.integration.cjs
`,
  'Required CI D6 cross-process step',
);
fs.writeFileSync(workflowPath, workflow, 'utf8');
