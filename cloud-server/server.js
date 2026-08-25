"use strict";

// Security containment bootstrap. This file is staged separately so the final
// tree update can atomically preserve the previous large server as server-core.js
// and make this bootstrap the canonical server.js entrypoint.
const express = require("express");
const { installHttpContainment } = require("./http-containment");

installHttpContainment(express, { dataDir: __dirname });
require("./server-core");

// server-core loads the environment and the canonical Direct transport first.
// Patch that same cached transport object before Node can service requests, so
// replaced media that Bot API cannot delete (for example, old messages) gets a
// best-effort MASTER MTProto cleanup after the new INDEX has committed.
const directTransport = require("./direct-transport-control");
const { installDirectMediaCleanupHook } = require("./direct-media-cleanup-hook");
installDirectMediaCleanupHook({ directTransport });
