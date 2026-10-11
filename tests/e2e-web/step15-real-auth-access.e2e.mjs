import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const identifier = String(process.env.STEP15_ACCOUNT_A_IDENTIFIER || '').trim();
const password = String(process.env.STEP15_ACCOUNT_A_PASSWORD || '');
const runDir = String(process.env.STEP15_RUN_DIR || '').trim();
if (!identifier || !password) throw new Error('STEP15_ACCOUNT_A_IDENTIFIER and STEP15_ACCOUNT_A_PASSWORD are required.');
if (!runDir) throw new Error('STEP15_RUN_DIR is required.');

const reportFile = path.join(runDir, 'browser-auth-access.json');
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);

async function resetAndLogin() {
  await browser.url('/');
  await browser.deleteCookies();
  await browser.execute(() => { localStorage.clear(); sessionStorage.clear(); });
  await browser.refresh();
  await browser.waitUntil(async () => (await browser.$('#auth-login-identifier')).isDisplayed().catch(() => false), {
    timeout: 30_000,
    timeoutMsg: 'STEP15 account A did not reach sign-in UI.',
  });
  await (await browser.$('#auth-login-identifier')).setValue(identifier);
  await (await browser.$('#auth-login-password')).setValue(password);
  await (await browser.$('.bg-auth-form button[type="submit"]')).click();
  await browser.waitUntil(async () => {
    const login = await browser.$('#auth-login-identifier');
    const mfa = await browser.$('#auth-login-mfa');
    const alert = await browser.$('[role="alert"]');
    if (await mfa.isExisting().catch(() => false)) throw new Error('STEP15 account A unexpectedly requires MFA.');
    if (await alert.isDisplayed().catch(() => false)) {
      const text = await alert.getText().catch(() => 'login error');
      throw new Error(`STEP15 login rejected: ${String(text).slice(0, 200)}`);
    }
    return !(await login.isExisting().catch(() => true));
  }, { timeout: 60_000, interval: 300, timeoutMsg: 'STEP15 account A did not leave sign-in.' });
}

async function snapshot() {
  return browser.execute(async () => {
    const json = async (url, init) => {
      const response = await fetch(url, init);
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { parse_error: true }; }
      return { status: response.status, body };
    };
    const csrf = sessionStorage.getItem('beatgaler:web-csrf:v1') || '';
    const [plan, account] = await Promise.all([
      json('/beatgaler-api/plans/me'),
      json('/beatgaler-api/auth/account', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-BeatGaler-Client': 'web',
          ...(csrf ? { 'X-BeatGaler-CSRF': csrf } : {}),
        },
        body: '{}',
      }),
    ]);
    const library = document.querySelector('[data-library-scroll="true"]');
    const text = String(document.body?.innerText || '');
    return {
      plan,
      account,
      webSessionMarker: localStorage.getItem('beatgaler:web-session-present:v1'),
      csrfPresent: Boolean(csrf),
      library: {
        present: Boolean(library),
        ariaBusy: library?.getAttribute('aria-busy') ?? null,
        loadError: text.includes('Galer Cloud could not load your library'),
        offline: text.includes("You're offline."),
        beatIds: Array.from(document.querySelectorAll('[data-beat-card-id]'))
          .map(node => String(node.getAttribute('data-beat-card-id') || '')).filter(Boolean),
      },
    };
  });
}

function assertSnapshot(value, expectedIdentity = null) {
  assert.equal(value.plan.status, 200, 'plans/me must return 200');
  assert.equal(value.account.status, 200, 'auth/account must return 200');
  assert.equal(value.plan.body?.ok, true);
  assert.equal(value.account.body?.ok, true);
  const plan = value.plan.body.plan;
  const account = value.account.body.user;
  assert.ok(account?.id, 'account identity missing');
  assert.ok(account?.storage_ready, 'STEP15 account has no provisioned vault');
  assert.equal(plan?.effective_plan_id, account?.plan?.effective_plan_id, 'Access projection differs between plans/me and auth/account');
  assert.equal(plan?.base_plan_id, account?.plan?.base_plan_id, 'base plan projection differs between consumers');
  assert.deepEqual(plan?.entitlements, account?.plan?.entitlements, 'entitlements differ between consumers');
  assert.deepEqual(plan?.quotas, account?.plan?.quotas, 'quotas differ between consumers');
  assert.equal(value.webSessionMarker, '1');
  assert.equal(value.csrfPresent, true);
  assert.equal(value.library.present, true, 'authoritative library surface missing');
  assert.notEqual(value.library.ariaBusy, 'true', 'authoritative library is still loading');
  assert.equal(value.library.loadError, false);
  assert.equal(value.library.offline, false);
  if (expectedIdentity) assert.equal(account.id, expectedIdentity, 'account identity changed after reload');
  return { account, plan };
}

describe('BeatGaler STEP15 real Browser auth/access gate', () => {
  it('logs into isolated account A and preserves one Access identity across reload', async () => {
    await resetAndLogin();
    await browser.waitUntil(async () => {
      const current = await snapshot();
      return current.library.present && current.library.ariaBusy !== 'true';
    }, { timeout: 60_000, interval: 500, timeoutMsg: 'STEP15 library did not settle after login.' });

    const first = await snapshot();
    const { account, plan } = assertSnapshot(first);
    await browser.refresh();
    await browser.waitUntil(async () => {
      const current = await snapshot();
      return current.account.status === 200 && current.library.present && current.library.ariaBusy !== 'true';
    }, { timeout: 60_000, interval: 500, timeoutMsg: 'STEP15 account/library did not restore after reload.' });
    const second = await snapshot();
    const after = assertSnapshot(second, account.id);
    assert.equal(after.plan.effective_plan_id, plan.effective_plan_id, 'effective Access changed across reload');

    const report = {
      kind: 'STEP15_BROWSER_AUTH_ACCESS',
      result: 'PASS',
      checkedAtUtc: new Date().toISOString(),
      accountIdSha256Prefix: digest(account.id),
      effectivePlanId: plan.effective_plan_id,
      basePlanId: plan.base_plan_id,
      storageReady: true,
      csrfPresent: true,
      libraryBeatCountBeforeReload: first.library.beatIds.length,
      libraryBeatCountAfterReload: second.library.beatIds.length,
      identityPreservedAcrossReload: true,
      mutableExternalOperations: false,
    };
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });
});
