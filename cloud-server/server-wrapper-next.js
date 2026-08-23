"use strict";

// Security containment bootstrap. This file is staged separately so the final
// tree update can atomically preserve the previous large server as server-core.js
// and make this bootstrap the canonical server.js entrypoint.
const express = require("express");
const { installHttpContainment } = require("./http-containment");

installHttpContainment(express, { dataDir: __dirname });
require("./server-core");
