"use strict";

const express = require("express");
const { installLegacyMediaUploadDisable } = require("./legacy-media-upload-disable");
const { installHttpContainment } = require("./http-containment");
const { installDirectCapabilityBoundary } = require("./direct-capability-boundary");
const { installSensitiveAuthCapabilityRevocation } = require("./sensitive-auth-capability-revocation");
const { installProductiveTempAuthBoundary } = require("./productive-temp-auth-boundary");
const { installSecurityHeaders } = require("./security-headers");
const { installAuthAbuseControls } = require("./auth-abuse-controls");
const { postgresConfig } = require("./postgres-runtime-config");
const { startPostgresControlPlane, installPostgresShutdown } = require("./postgres-bootstrap");
const { prepareControlPlaneCutover } = require("./control-plane-cutover-runtime");
const { createPostgresInstallationClaimCoordinator } = require("./postgres-installation-claim-coordinator");

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

  const cutover = await prepareControlPlaneCutover({ pool, env: process.env });
  const installationClaimCoordinator = pool ? createPostgresInstallationClaimCoordinator(pool) : null;
  if (String(process.env.NODE_ENV || "") === "production" && !installationClaimCoordinator) {
    throw new Error("Production authorization requires PostgreSQL cross-process installation claim coordination.");
  }

  installHttpContainment(express, { dataDir: __dirname, installationClaimCoordinator });
  const directCapabilities = installDirectCapabilityBoundary(express, { dataDir: __dirname, pool });
  installSensitiveAuthCapabilityRevocation(express, { store: directCapabilities?.store });
  installAuthAbuseControls(express);
  installProductiveTempAuthBoundary(express);
  console.log(`[control-plane] authority=${cutover.authority} claim-coordinator=${installationClaimCoordinator ? "postgres" : "process-local-dev"} direct-capabilities=${pool ? "postgres" : "process-local-dev"}`);
  require("./server-core");
}

start().catch((error) => {
  console.error("[control-plane] startup failed; cloud-server will not start:", error?.message || String(error));
  process.exitCode = 1;
});
