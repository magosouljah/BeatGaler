"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FILE_UPLOAD_LIMIT_BYTES = 1_990_000_000;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const DEFAULT_UPLOAD_WINDOW_MS = 60_000;
const DEFAULT_UPLOAD_REQUESTS_PER_WINDOW = 30;
const DEFAULT_UPLOAD_CONCURRENCY = 2;

const UPLOAD_ROUTES = new Set([
  "/metadata/artwork",
  "/beats/upload",
  "/projects/upload",
  "/cloud-files/upload",
]);

const BODY_OWNER_ROUTES = new Set([
  "/metadata/upsert",
  "/library/artwork",
]);

const SESSION_BIND_ROUTES = new Set([
  "/auth/register",
  "/auth/login",
  "/auth/session",
  "/auth/oauth/poll",
]);

const INSTALLATION_POST_ROUTES = new Set([
  "/events/ticket",
  "/telegram/connect/start",
  "/telegram/disconnect",
  "/transport/session/start",
  "/transport/session/activate",
  "/transport/session/heartbeat",
  "/transport/session/stop",
  "/transport/operation/begin",
  "/transport/operation/end",
  "/transport/index/commit",
  "/transport/topic/ensure",
  "/transport/upload/confirm",
  "/beats/delete-topic",
]);

const INSTALLATION_GET_ROUTES = new Set([
  "/telegram/connect/status",
]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-authz`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function bearerToken(req) {
  const raw = String(req.headers?.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function sessionKey(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function requestIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

function sendJson(res, status, error, extra = {}) {
  return res.status(status).json({ error, ...extra });
}

function createHttpContainment(options = {}) {
  const dataDir = options.dataDir || __dirname;
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const accountsFile = path.join(dataDir, "accounts-data.json");
  const cloudFile = path.join(dataDir, "cloud-data.json");
  const bindingsFile = path.join(dataDir, "authz-session-bindings.json");
  const uploadWindowMs = Math.max(1_000, Number(env.BEATGALER_UPLOAD_RATE_WINDOW_MS || DEFAULT_UPLOAD_WINDOW_MS));
  const uploadRequestsPerWindow = Math.max(1, Number(env.BEATGALER_UPLOAD_RATE_MAX || DEFAULT_UPLOAD_REQUESTS_PER_WINDOW));
  const uploadConcurrency = Math.max(1, Number(env.BEATGALER_UPLOAD_CONCURRENCY || DEFAULT_UPLOAD_CONCURRENCY));
  const rateBuckets = new Map();
  const activeUploads = new Map();

  function authenticate(req, res) {
    const token = bearerToken(req);
    if (!token) {
      sendJson(res, 401, "Session expired. Sign in again.");
      return null;
    }
    const data = readJson(accountsFile, { users: [], sessions: {} });
    const key = sessionKey(token);
    const session = data.sessions?.[key];
    if (!session || Number(session.expiresAt || 0) <= now()) {
      sendJson(res, 401, "Session expired. Sign in again.");
      return null;
    }
    const user = (Array.isArray(data.users) ? data.users : []).find(entry => String(entry?.id || "") === String(session.userId || ""));
    if (!user) {
      sendJson(res, 401, "Session expired. Sign in again.");
      return null;
    }
    return { token, key, session, user };
  }

  function linkedAccount(installationId) {
    const cloud = readJson(cloudFile, { linkedAccounts: {} });
    return cloud.linkedAccounts?.[String(installationId || "")] || null;
  }

  function bindSessionInstallation(token, installationId, expectedUserId) {
    const id = String(installationId || "").trim();
    if (!token || !id) return false;
    const cloudAccount = linkedAccount(id);
    if (!cloudAccount || String(cloudAccount.beatgalerAccountId || "") !== String(expectedUserId || "")) return false;
    const data = readJson(accountsFile, { users: [], sessions: {} });
    const key = sessionKey(token);
    const session = data.sessions?.[key];
    if (!session || String(session.userId || "") !== String(expectedUserId || "")) return false;
    const bindings = readJson(bindingsFile, {});
    bindings[key] = { installationId: id, tenantId: String(expectedUserId), boundAt: now(), expiresAt: Number(session.expiresAt || 0) };
    writeJsonAtomic(bindingsFile, bindings);
    return true;
  }

  function authorizeSessionInstallation(req, res, { upload = false } = {}) {
    const auth = req.beatgalerPreAuth || authenticate(req, res);
    if (!auth) {
      if (upload) cleanupUploadedFile(req);
      return null;
    }
    const binding = readJson(bindingsFile, {})?.[auth.key] || null;
    const installationId = String(binding?.installationId || auth.session?.installationId || "").trim();
    const tenantId = String(binding?.tenantId || auth.session?.tenantId || auth.user.id || "").trim();
    if (binding && Number(binding.expiresAt || 0) > 0 && Number(binding.expiresAt) <= now()) {
      sendJson(res, 401, "Session expired. Sign in again.");
      return null;
    }
    if (!installationId || !tenantId || tenantId !== String(auth.user.id || "")) {
      if (upload) cleanupUploadedFile(req);
      sendJson(res, 403, "This session is not bound to an authorized BeatGaler installation. Sign in again.");
      return null;
    }
    const account = linkedAccount(installationId);
    if (!account || String(account.beatgalerAccountId || "") !== String(auth.user.id || "")) {
      if (upload) cleanupUploadedFile(req);
      sendJson(res, 403, "This installation is not authorized for the signed-in account.");
      return null;
    }

    req.body = req.body || {};
    req.query = req.query || {};
    req.body.beatgalerUserId = installationId;
    req.query.beatgalerUserId = installationId;
    req.beatgalerAuthorizedUserId = String(auth.user.id);
    req.beatgalerAuthorizedTenantId = tenantId;
    req.beatgalerAuthorizedInstallationId = installationId;
    return { auth, account, installationId, tenantId };
  }

  function preUpload(req, res, next) {
    const auth = authenticate(req, res);
    if (!auth) return;
    req.beatgalerPreAuth = auth;
    if (!authorizeSessionInstallation(req, res)) return;

    const contentLength = Number(req.headers?.["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > FILE_UPLOAD_LIMIT_BYTES + MULTIPART_OVERHEAD_BYTES) {
      return sendJson(res, 413, "FILE_TOO_LARGE: BeatGaler single-file limit is 1.99 GB.", { max_bytes: FILE_UPLOAD_LIMIT_BYTES });
    }

    const keys = [
      `ip:${requestIp(req)}`,
      `account:${auth.user.id}`,
      `tenant:${req.beatgalerAuthorizedTenantId}`,
    ];
    const stamp = now();
    for (const key of keys) {
      let bucket = rateBuckets.get(key);
      if (!bucket || stamp - bucket.startedAt >= uploadWindowMs) bucket = { startedAt: stamp, count: 0 };
      bucket.count += 1;
      rateBuckets.set(key, bucket);
      if (bucket.count > uploadRequestsPerWindow) return sendJson(res, 429, "Too many upload requests. Please retry shortly.");
    }

    const concurrencyKey = `tenant:${req.beatgalerAuthorizedTenantId}`;
    const active = Number(activeUploads.get(concurrencyKey) || 0);
    if (active >= uploadConcurrency) return sendJson(res, 429, "Too many uploads are already in progress. Please wait for one to finish.");
    activeUploads.set(concurrencyKey, active + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = Number(activeUploads.get(concurrencyKey) || 0);
      if (current <= 1) activeUploads.delete(concurrencyKey);
      else activeUploads.set(concurrencyKey, current - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  }

  function cleanupUploadedFile(req) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }

  function postUpload(req, res, next) {
    if (req.file && Number(req.file.size || 0) > FILE_UPLOAD_LIMIT_BYTES) {
      cleanupUploadedFile(req);
      return sendJson(res, 413, "FILE_TOO_LARGE: BeatGaler single-file limit is 1.99 GB.", { max_bytes: FILE_UPLOAD_LIMIT_BYTES });
    }
    if (!req.beatgalerAuthorizedInstallationId && !authorizeSessionInstallation(req, res, { upload: true })) return;
    req.body = req.body || {};
    req.body.beatgalerUserId = req.beatgalerAuthorizedInstallationId;
    next();
  }

  function bodyOwner(req, res, next) {
    if (!authorizeSessionInstallation(req, res)) return;
    next();
  }

  function installationOwner(req, res, next) {
    if (!authorizeSessionInstallation(req, res)) return;
    next();
  }

  function beatTopicOwner(req, res, next) {
    const authz = authorizeSessionInstallation(req, res);
    if (!authz) return;
    const beatId = String(req.body?.beatId || "").trim();
    const hintedTopicId = Number(req.body?.telegramTopicId || 0);
    if (!beatId) return sendJson(res, 400, "beatId is required.");
    if (Number.isFinite(hintedTopicId) && hintedTopicId > 0) {
      const cloud = readJson(cloudFile, { beatTopics: {} });
      const current = cloud.beatTopics?.[`${authz.installationId}:${beatId}`];
      if (!current || Number(current.messageThreadId || 0) !== hintedTopicId) {
        return sendJson(res, 403, "This topic does not belong to the requested BeatGaler object.");
      }
    }
    next();
  }

  function registrationGate(_req, res, next) {
    if (String(env.NODE_ENV || "") === "production" && String(env.BEATGALER_PUBLIC_REGISTRATION || "") !== "1") {
      return sendJson(res, 503, "Public registration is temporarily unavailable.");
    }
    next();
  }

  function bindSessionOnSuccess(req, res, next) {
    const requestedInstallation = String(req.body?.beatgalerUserId || req.headers?.["x-beatgaler-installation-id"] || "").trim();
    if (!requestedInstallation) return next();
    const originalJson = res.json.bind(res);
    res.json = payload => {
      const status = Number(res.statusCode || 200);
      if (status >= 200 && status < 300 && payload?.user?.id) {
        const token = String(payload?.token || bearerToken(req) || "");
        bindSessionInstallation(token, requestedInstallation, payload.user.id);
      }
      return originalJson(payload);
    };
    next();
  }

  function legacyLibraryUpsert(_req, res) {
    return sendJson(res, 410, "Legacy server-side library index upload is disabled. Use the active Galer Cloud session.");
  }

  return {
    preUpload, postUpload, bodyOwner, installationOwner, beatTopicOwner, registrationGate,
    bindSessionOnSuccess, legacyLibraryUpsert, authenticate,
    authorizeInstallation: authorizeSessionInstallation,
    authorizeSessionInstallation, bindSessionInstallation,
    constants: { FILE_UPLOAD_LIMIT_BYTES, uploadWindowMs, uploadRequestsPerWindow, uploadConcurrency },
  };
}

function installHttpContainment(express, options = {}) {
  if (express.application.__beatgalerContainmentInstalled) return;
  express.application.__beatgalerContainmentInstalled = true;
  const containment = createHttpContainment(options);
  const originalPost = express.application.post;
  const originalGet = express.application.get;

  express.application.post = function patchedPost(routePath, ...handlers) {
    if (routePath === "/library/upsert") return originalPost.call(this, routePath, containment.legacyLibraryUpsert);
    if (routePath === "/auth/register") {
      return originalPost.call(this, routePath, containment.registrationGate, containment.bindSessionOnSuccess, ...handlers);
    }
    if (SESSION_BIND_ROUTES.has(routePath)) return originalPost.call(this, routePath, containment.bindSessionOnSuccess, ...handlers);
    if (UPLOAD_ROUTES.has(routePath) && handlers.length >= 2) {
      return originalPost.call(this, routePath, containment.preUpload, handlers[0], containment.postUpload, ...handlers.slice(1));
    }
    if (BODY_OWNER_ROUTES.has(routePath)) return originalPost.call(this, routePath, containment.bodyOwner, ...handlers);
    if (routePath === "/beats/delete-topic") return originalPost.call(this, routePath, containment.beatTopicOwner, ...handlers);
    if (INSTALLATION_POST_ROUTES.has(routePath)) return originalPost.call(this, routePath, containment.installationOwner, ...handlers);
    return originalPost.call(this, routePath, ...handlers);
  };

  express.application.get = function patchedGet(routePath, ...handlers) {
    if (INSTALLATION_GET_ROUTES.has(routePath)) return originalGet.call(this, routePath, containment.installationOwner, ...handlers);
    return originalGet.call(this, routePath, ...handlers);
  };
}

module.exports = { FILE_UPLOAD_LIMIT_BYTES, createHttpContainment, installHttpContainment };
