export function validateAuthHealth(entries, label) {
  const health = entries.filter(entry => entry.route === '/beatgaler-api/auth/health');
  const failure = health.find(entry => ['aborted', 'network-error'].includes(entry.state) || (entry.state === 'response' && entry.status !== 200));
  if (failure) throw Object.assign(new Error(`Account ${label} health failed: ${failure.state}, HTTP ${failure.status ?? 'none'}, ${failure.duration_ms}ms, phase=${failure.harness_phase}.`), { code: 'STAGE1_HEALTH_UNSTABLE', severity: 'P1' });
  return { observed: health.length, successful: health.filter(entry => entry.state === 'response' && entry.status === 200).length };
}
