'use strict';

const { requiredEnv } = require('./runtime-env');
const { accountsDataPath } = require('./auth-helpers');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { controlPlaneAuthorityConfig } = require('./control-plane-authority');
const { resolveSecretEnvelopeKeyring } = require('./secret-envelope-provider');
const { PostgresControlPlaneRuntime } = require('./postgres-control-plane-runtime');
const { installMultiprocessAuthSnapshotCompatibility } = require('./postgres-auth-multiprocess-compat');
const { installLegacyJsonCompatibility, installExpressDurabilityBarrier } = require('./control-plane-json-compat');
const { STATE_DIR, statePath } = require('./state-dir');

async function prepareControlPlaneCutover({ pool, env = requiredEnv(), secretProviderOptions } = {}) {
  const config = controlPlaneAuthorityConfig(env);
  // json solo sin PostgreSQL configurado (control-plane-authority.js): no hay pool ni marcador que comprobar.
  if (config.authority === 'json') return Object.freeze({ authority: 'json', runtime: null });

  const authPath = accountsDataPath(STATE_DIR);
  const persistentPath = statePath('cloud-data.json');
  if (!pool) throw new Error('PostgreSQL authority requires an initialized PostgreSQL pool.');

  const cryptoConfig = await resolveSecretEnvelopeKeyring(env, secretProviderOptions);
  const runtime = new PostgresControlPlaneRuntime({
    pool,
    expectedSnapshotSha256: config.expectedSnapshotSha256,
    cryptoConfig,
  });
  const initial = await runtime.initialize();
  // Multiple cloud processes share this authority. Install per-process auth
  // deltas before virtual JSON writes can reach saveAuthSnapshot(), so one
  // process never globally deletes another process's sessions/providers/MFA.
  await installMultiprocessAuthSnapshotCompatibility(runtime, pool, { initialAuth: initial.auth });

  installLegacyJsonCompatibility({
    fsModule: fs,
    runtime,
    authPath,
    persistentPath,
    initialAuth: initial.auth,
    initialPersistent: initial.persistent,
  });
  installExpressDurabilityBarrier(express, runtime);

  return Object.freeze({
    authority: 'postgres',
    runtime,
    snapshotSha256: config.expectedSnapshotSha256,
    secretKeyVersion: cryptoConfig.activeKeyVersion,
  });
}

module.exports = { prepareControlPlaneCutover };
