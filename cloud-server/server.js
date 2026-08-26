"use strict";

const express = require("express");
const { installHttpContainment } = require("./http-containment");
const { installProductiveTempAuthBoundary } = require("./productive-temp-auth-boundary");
const { installSecurityHeaders } = require("./security-headers");
const { postgresConfig } = require("./postgres-runtime-config");
const { startPostgresControlPlane, installPostgresShutdown } = require("./postgres-bootstrap");

installSecurityHeaders(express);
installHttpContainment(express, { dataDir: __dirname });
installProductiveTempAuthBoundary(express);

const pgConfig = postgresConfig(process.env);
if (!pgConfig.enabled) {
  require("./server-core");
} else {
  startPostgresControlPlane()
    .then(({ pool }) => {
      installPostgresShutdown(pool);
      require("./server-core");
    })
    .catch((error) => {
      console.error("[postgres] startup failed; cloud-server will not start:", error?.message || String(error));
      process.exitCode = 1;
    });
}
