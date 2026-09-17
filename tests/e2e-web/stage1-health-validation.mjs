export function validateAuthHealth(entries, label) {
  const health = entries.filter(entry => entry.route === '/beatgaler-api/auth/health');
  const failure = health.find(entry => ['aborted', 'network-error'].includes(entry.state) || (entry.state === 'response' && entry.status !== 200));
  if (failure) throw Object.assign(new Error(`Account ${label} health failed: ${failure.state}, HTTP ${failure.status ?? 'none'}, ${failure.duration_ms}ms, phase=${failure.harness_phase}.`), { code: 'STAGE1_HEALTH_UNSTABLE', severity: 'P1' });
  for (const phase of ['login', 'reload']) {
    const success = health.some(entry => entry.state === 'response' && entry.status === 200 && (phase === 'reload' ? entry.harness_phase === 'simultaneous-reload' : ['submitting-sign-in', 'waiting-for-login-result'].includes(entry.harness_phase)));
    if (!success) throw Object.assign(new Error(`Account ${label} has no successful observed ${phase} health probe.`), { code: 'STAGE1_HEALTH_UNPROVEN', severity: 'P1' });
  }
}
