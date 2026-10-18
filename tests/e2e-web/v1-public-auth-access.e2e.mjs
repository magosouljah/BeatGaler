import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePublicBrowserEnv } from '../../scripts/v1-public-browser-guard.mjs';

const run = validatePublicBrowserEnv(process.env);
const identifier = process.env.V1_PUBLIC_ACCOUNT_IDENTIFIER;
const password = process.env.V1_PUBLIC_ACCOUNT_PASSWORD;

async function accountSnapshot() {
  return browser.execute(async () => {
    const csrf = sessionStorage.getItem('beatgaler:web-csrf:v1') || '';
    const [planResponse, accountResponse] = await Promise.all([
      fetch('/beatgaler-api/plans/me', { credentials: 'include' }),
      fetch('/beatgaler-api/auth/account', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web',
          ...(csrf ? { 'X-BeatGaler-CSRF': csrf } : {}) }, body: '{}' }),
    ]);
    const library = document.querySelector('[data-library-scroll="true"]');
    const pageText = String(document.body?.innerText || '');
    return { planStatus: planResponse.status, accountStatus: accountResponse.status,
      plan: await planResponse.json(), account: await accountResponse.json(),
      csrfPresent: Boolean(csrf), libraryPresent: Boolean(library),
      libraryBusy: library?.getAttribute('aria-busy') === 'true',
      libraryLoadError: pageText.includes('Galer Cloud could not load your library'),
      beatIds: Array.from(document.querySelectorAll('[data-beat-card-id]'))
        .map(node => node.getAttribute('data-beat-card-id')).filter(Boolean).sort() };
  });
}

describe('V1 public disposable account canary', () => {
  it('restores the same Access identity after Web reload', async () => {
    await browser.url('/');
    await browser.deleteCookies();
    await browser.execute(() => { localStorage.clear(); sessionStorage.clear(); });
    await browser.refresh();
    await (await browser.$('#auth-login-identifier')).waitForDisplayed({ timeout: 30_000 });
    await (await browser.$('#auth-login-identifier')).setValue(identifier);
    await (await browser.$('#auth-login-password')).setValue(password);
    await (await browser.$('.bg-auth-form button[type="submit"]')).click();
    await browser.waitUntil(async () => !(await (await browser.$('#auth-login-identifier')).isExisting()),
      { timeout: 60_000, timeoutMsg: 'Disposable account did not sign in.' });
    await browser.waitUntil(async () => {
      const snapshot = await accountSnapshot();
      return snapshot.libraryPresent && !snapshot.libraryBusy;
    }, { timeout: 60_000, timeoutMsg: 'Disposable account library did not settle.' });
    const first = await accountSnapshot();
    assert.equal(first.planStatus, 200);
    assert.equal(first.accountStatus, 200);
    assert.equal(first.plan?.ok, true);
    assert.equal(first.account?.ok, true);
    assert.ok(first.account?.user?.id);
    assert.equal(first.account.user.storage_ready, true);
    assert.equal(first.csrfPresent, true);
    assert.equal(first.libraryPresent, true);
    assert.equal(first.libraryBusy, false);
    assert.equal(first.libraryLoadError, false);
    assert.equal(first.plan.plan?.effective_plan_id, first.account.user.plan?.effective_plan_id);
    assert.deepEqual(first.plan.plan?.entitlements, first.account.user.plan?.entitlements);
    assert.deepEqual(first.plan.plan?.quotas, first.account.user.plan?.quotas);
    if (run.expectedPlan) assert.equal(first.plan.plan?.effective_plan_id, run.expectedPlan);
    await browser.refresh();
    await browser.waitUntil(async () => {
      const snapshot = await accountSnapshot();
      return snapshot.accountStatus === 200 && snapshot.libraryPresent && !snapshot.libraryBusy;
    },
      { timeout: 60_000, timeoutMsg: 'Disposable account session did not restore.' });
    const second = await accountSnapshot();
    assert.equal(second.account.user.id, first.account.user.id);
    assert.equal(second.plan.plan?.effective_plan_id, first.plan.plan?.effective_plan_id);
    assert.equal(second.libraryBusy, false);
    assert.equal(second.libraryLoadError, false);
    assert.deepEqual(second.beatIds, first.beatIds, 'INDEX-backed library changed across reload');
    const report = { kind: 'V1_PUBLIC_BROWSER_AUTH_ACCESS', result: 'PASS',
      sourceSha: run.sourceSha, accountIdSha256Prefix: crypto.createHash('sha256')
        .update(String(first.account.user.id)).digest('hex').slice(0, 16),
      effectivePlanId: first.plan.plan?.effective_plan_id, identityPreservedAcrossReload: true,
      libraryIndexPreservedAcrossReload: true, libraryBeatCount: first.beatIds.length,
      financialMutation: false, accountCreatedByHarness: false, accountDeletedByHarness: false };
    await fs.writeFile(path.join(run.runDir, 'public-browser-auth-access.json'), `${JSON.stringify(report, null, 2)}\n`);
    await browser.deleteCookies();
  });
});
