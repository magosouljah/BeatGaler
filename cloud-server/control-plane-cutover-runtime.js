'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { controlPlaneAuthorityConfig, developmentEnvelopeKeyConfig } = require('./control-plane-authority');
const { PostgresControlPlaneRuntime } = require('./postgres-control-plane-runtime');
const { assertJsonRollbackSnapshot } = require('./postgres-rollback-preparation');
const { installLegacyJsonCompatibility, installExpressDurabilityBarrier } = require('./control-plane-json-compat');

async function prepareControlPlaneCutover({ pool, env = process.env } = {}) {
  const config = controlPlaneAuthorityConfig(env);
  const authPath = path.join(__dirname, 'accounts-data.json');
  const persistentPath = path.join(__dirname, 'cloud-data.json');

  if (config.authority === 'json') {
    if (pool) {
      const authRaw = fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf8') : JSON.stringify({ users: [], sessions: {} });
      const persistentRaw = fs.existsSync(persistentPath)
        ? fs.readFileSync(persistentPath, 'utf8')
        : JSON.stringify({ linkedAccounts: {}, uploadedFiles: {}, beatTopics: {}, pendingTopicDeletes: {}, messageRedirects: {} });
      await assertJsonRollbackSnapshot(pool, config.expectedRollbackSha256, { authRaw, persistentRaw });
    }
    return Object.freeze({ authority: 'json', runtime: null, rollbackSha256: config.expectedRollbackSha256 || null });
  }
  if (!pool) throw new Error('PostgreSQL authority requires an initialized PostgreSQL pool.');

  const cryptoConfig = developmentEnvelopeKeyConfig(env);
  const runtime = new PostgresControlPlaneRuntime({
    pool,
    expectedSnapshotSha256: config.expectedSnapshotSha256,
    cryptoConfig,
  });
  const initial = await runtime.initialize();

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
  });
}

module.exports = { prepareControlPlaneCutover };
