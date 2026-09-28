"use strict";

const fs = require("fs");

const RELEVANT_ROUTES = new Set([
  "/auth/session",
  "/transport/session/start",
  "/transport/session/activate",
  "/transport/operation/begin",
  "/transport/capability/authorize",
  "/transport/operation/end",
]);

let stream = null;

function traceFile() {
  const value = String(process.env.STAGE1_CRITICAL_PATH_CLOUD_TRACE_FILE || "").trim();
  return value || null;
}

function correlation(req) {
  const value = String(req?.headers?.["x-stage1-critical-path"] || "").trim();
  return /^[A-Za-z0-9:-]{1,100}$/.test(value) ? value : null;
}

function write(req, event, detail = {}) {
  const id = correlation(req);
  const file = traceFile();
  if (!id || !file || !RELEVANT_ROUTES.has(String(req?.path || ""))) return;
  if (!stream) {
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", () => {});
  }
  stream.write(`${JSON.stringify({ correlation_id: id, route: req.path, event, at_ms: Date.now(), ...detail })}\n`);
}

function install(app) {
  app.use((req, res, next) => {
    if (!correlation(req) || !RELEVANT_ROUTES.has(String(req.path || ""))) return next();
    write(req, "cloud_ingress");
    res.once("finish", () => write(req, "cloud_response_sent", { status: res.statusCode }));
    res.once("close", () => {
      if (!res.writableEnded) write(req, "cloud_response_closed", { status: res.statusCode });
    });
    next();
  });
}

async function step(req, name, operation) {
  write(req, `${name}_begin`);
  try {
    const value = await operation();
    write(req, `${name}_done`);
    return value;
  } catch (error) {
    write(req, `${name}_error`, { error_name: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

module.exports = { install, step, write };
