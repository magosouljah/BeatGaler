"use strict";

const express = require("express");
const { installLegacyMediaUploadDisable } = require("./legacy-media-upload-disable");
const { installHttpContainment } = require("./http-containment");
const { installProductiveTempAuthBoundary } = require("./productive-temp-auth-boundary");
const { installSecurityHeaders } = require("./security-headers");
const { postgresConfig } = require("./postgres-runtime-config");
const { startPostgresControlPlane, installPostgresShutdown } = require("./postgres-bootstrap");
const { prepareControlPlaneCutover } = require("./control-plane-cutover-runtime");

installSecurityHeaders(express);
installLegacyMediaUploadDisable(express);
installHttpContainment(express, { dataDir: __dirname });
installProductiveTempAuthBoundary(express);

async function start() {
  const pgConfig = postgresConfig(process.env);
  let pool = null;

  if (pgConfig.enabled) {
    const started = await startPostgresControlPlane();
    pool = started.pool;
    installPostgresShutdown(pool);
  }

  const cutover = await prepareControlPlaneCutover({ pool, env: process.env });
  console.log(`[control-plane] authority=${cutover.authority}`);
  require("./server-core");
}

start().catch((error) => {
  console.error("[control-plane] startup failed; cloud-server will not start:", error?.message || String(error));
  process.exitCode = 1;
});
