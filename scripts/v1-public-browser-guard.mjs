import { resolve, sep } from 'node:path';
import { validateCanaryConfig } from './v1-public-canary.mjs';

export function validatePublicBrowserEnv(env = process.env, root = process.cwd()) {
  const canary = validateCanaryConfig(env);
  if (env.V1_PUBLIC_BROWSER_ACK !== 'ACCOUNT_LOGIN_ONLY') {
    throw new Error('V1_PUBLIC_BROWSER_ACK=ACCOUNT_LOGIN_ONLY is required.');
  }
  if (env.V1_PUBLIC_ACCOUNT_DISPOSABLE !== '1') {
    throw new Error('V1_PUBLIC_ACCOUNT_DISPOSABLE=1 is required.');
  }
  if (!String(env.V1_PUBLIC_ACCOUNT_IDENTIFIER || '').trim() || !String(env.V1_PUBLIC_ACCOUNT_PASSWORD || '')) {
    throw new Error('Disposable account identifier and password are required.');
  }
  const expectedPlan = String(env.V1_PUBLIC_EXPECTED_PLAN || '').trim();
  if (expectedPlan && !['free', 'paid_entry', 'highest_paid'].includes(expectedPlan)) {
    throw new Error('V1_PUBLIC_EXPECTED_PLAN must be free, paid_entry, or highest_paid.');
  }
  const runId = String(env.V1_PUBLIC_RUN_ID || '');
  if (!/^v1-public-[a-z0-9_-]{4,40}$/.test(runId)) {
    throw new Error('V1_PUBLIC_RUN_ID must identify one v1-public run.');
  }
  const base = resolve(root, 'tmp', 'v1-public');
  const runDir = resolve(base, runId);
  if (!runDir.startsWith(`${base}${sep}`)) throw new Error('Public browser run directory escaped the workspace.');
  return { ...canary, runId, runDir, expectedPlan: expectedPlan || null };
}
