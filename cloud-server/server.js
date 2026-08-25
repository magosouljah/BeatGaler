"use strict";

const express = require("express");
const { installHttpContainment } = require("./http-containment");
const { installProductiveTempAuthBoundary } = require("./productive-temp-auth-boundary");

installHttpContainment(express, { dataDir: __dirname });
installProductiveTempAuthBoundary(express);
require("./server-core");
