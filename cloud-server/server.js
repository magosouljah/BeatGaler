"use strict";

const express = require("express");
const { installLegacyMediaUploadDisable } = require("./legacy-media-upload-disable");
const { installHttpContainment } = require("./http-containment");
const { installDirectCapabilityBoundary } = require("./direct-capability-boundary");
const { installSensitiveAuthCapabilityRevocation } = require("./sensitive-auth-capability-revocation");
const { installSessionSecurity } = require("./session-security");
const { installAccountLifecycle } = require("./account-lifecycle");
const { installLifecyclePasswordAuthority } = require("./account-lifecycle-password-authority");
const { installLifecycleRequestGuard } = require("./account-lifecycle-request-guard");
const { createSesEmailNotifier } = require("./account-email-ses");
const { applyD8RoResolutions, d8LifecycleEnv } = require("./d8-ro-resolutions");
const { installProductiveTempAuthBoundary } = require("./productive-temp-auth-boundary");
const { installSecurityHeaders } = require("./security-headers");
const { installAuthAbuseControls } = require("./auth-abuse-controls");
const { postgresConfig } = require("./postgres-runtime-config");
const { startPostgresControlPlane, installPostgresShutdown } = require("./postgres-bootstrap");
const { prepareControlPlaneCutover } = require("./control-plane-cutover-runtime");
const { createPostgresInstallationClaimCoordinator } = require("./postgres-installation-claim-coordinator");
const { installRuntimeOperability, configureRuntimeDependencies } = require("./runtime-operability");
const directPersistentAssignments = require("./direct-persistent-assignment-runtime");
const { installPersistentDirectSessionStart } = require("./direct-persistent-session-runtime");
const { installPersistentDirectMembershipActivation } = require("./direct-persistent-membership-runtime");
const { installAtomicLibraryIndexBootstrap } = require("./atomic-library-index");
const { installStartupRoutingIndex } = require("./startup-routing-index");

installRuntimeOperability(express);
installSecurityHeaders(express);
installLegacyMediaUploadDisable(express);

async function start() {
  const pgConfig = postgresConfig(process.env);
  let pool = null;

  if (pgConfig.enabled) {
    const started = await startPostgresControlPlane();
    pool = started.pool;
    installPostgresShutdown(pool);
  }
  configureRuntimeDependencies({ pool, postgresRequired: pgConfig.enabled });
  directPersistentAssignments.configure({ pool });

  const cutover = await prepareControlPlaneCutover({ pool, env: process.env });
  const installationClaimCoordinator = pool ? createPostgresInstallationClaimCoordinator(pool) : null;
  if (String(process.env.NODE_ENV || "") === "production" && !installationClaimCoordinator) {
    throw new Error("Production authorization requires PostgreSQL cross-process installation claim coordination.");
  }

  let directCapabilities = null;
  const accountLifecycle = installAccountLifecycle(express, {
    dataDir: __dirname,
    env: d8LifecycleEnv(process.env),
    emailNotifier: createSesEmailNotifier({ env: process.env }),
    getCapabilityStore: () => directCapabilities?.store || null,
  });
  installLifecyclePasswordAuthority(accountLifecycle);
  applyD8RoResolutions(express, accountLifecycle, { env: process.env });
  installSessionSecurity(express, {
    dataDir: __dirname,
    getCapabilityStore: () => directCapabilities?.store || null,
  });
  installLifecycleRequestGuard(express, accountLifecycle);
  installHttpContainment(express, { dataDir: __dirname, installationClaimCoordinator });
  directCapabilities = installDirectCapabilityBoundary(express, { dataDir: __dirname, pool });
  installSensitiveAuthCapabilityRevocation(express, { store: directCapabilities?.store });
  installAuthAbuseControls(express);
  installProductiveTempAuthBoundary(express);
  installAtomicLibraryIndexBootstrap(express, { pool, dataDir: __dirname });
  installStartupRoutingIndex(express, { pool, dataDir: __dirname });
  console.log(`[control-plane] authority=${cutover.authority} claim-coordinator=${installationClaimCoordinator ? "postgres" : "process-local-dev"} direct-capabilities=${pool ? "postgres" : "process-local-dev"}`);

  // server-core loads dotenv and the Direct module using the existing startup
  // order. Its request handlers dereference Direct methods only when a request
  // arrives, so patching the cached module immediately after the synchronous
  // require preserves that ordering while installing persistent ownership and
  // membership semantics before the event loop can serve Direct requests.
  require("./server-core");
  const directTransport = require("./direct-transport-control");
  installPersistentDirectSessionStart({
    directTransport,
    persistentAssignments: directPersistentAssignments,
  });
  installPersistentDirectMembershipActivation({
    directTransport,
    persistentAssignments: directPersistentAssignments,
  });
}

start().catch((error) => {
  console.error("[control-plane] startup failed; cloud-server will not start:", error?.message || String(error));
  process.exitCode = 1;
});
