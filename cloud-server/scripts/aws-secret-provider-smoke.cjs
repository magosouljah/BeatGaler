'use strict';

const { resolveSecretEnvelopeKeyring } = require('../secret-envelope-provider');

(async () => {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    BEATGALER_SECRET_ENVELOPE_PROVIDER: 'aws-secrets-manager',
  };
  const startedAt = Date.now();
  const keyring = await resolveSecretEnvelopeKeyring(env);
  const elapsedMs = Date.now() - startedAt;

  // Intentionally redacted: never print secret ID, ciphertext keys, plaintext keys,
  // credentials, database URLs or any Secrets Manager response payload.
  process.stdout.write(`${JSON.stringify({
    ok: true,
    provider: 'aws-secrets-manager',
    regionConfigured: Boolean(String(env.AWS_REGION || env.AWS_DEFAULT_REGION || '').trim()),
    activeKeyVersion: keyring.activeKeyVersion,
    availableKeyVersions: keyring.availableVersions,
    fetchAndKmsDecryptMs: elapsedMs,
    secretMaterialLogged: false,
  })}\n`);
})().catch(error => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    provider: 'aws-secrets-manager',
    errorName: String(error?.name || 'Error'),
    // Do not emit error.message: upstream AWS errors can contain resource identifiers.
    secretMaterialLogged: false,
  })}\n`);
  process.exitCode = 1;
});
