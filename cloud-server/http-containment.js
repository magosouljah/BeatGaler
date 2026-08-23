"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Product decision: keep the hard single-file ceiling below the upstream 2 GB edge.
// Decimal GB is intentional so 1.99 GB stays safely below 2,000,000,000 bytes.
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

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
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
    const session = data.sessions?.[sessionKey(token)];
    if (!session || Number(session.expiresAt || 0) <= now()) {
      sendJson(res, 401, "Session expired. Sign in again.");
      return null;
    }
    const user = (Array.isArray(data.users) ? data.users : []).find(entry => String(entry?.id || "") === String(session.userId || ""));
    if (!user) {
      sendJson(res, 401, "Session expired. Sign in again.");
      return null;
    }
    return { token, session, user };
  }

  function preUpload(req, res, next) {
    const auth = authenticate(req, res);
    if (!auth) return;
    req.beatgalerPreAuth = auth;

    const contentLength = Number(req.headers?.["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > FILE_UPLOAD_LIMIT_BYTES + MULTIPART_OVERHEAD_BYTES) {
      return sendJson(res, 413, "FILE_TOO_LARGE: BeatGaler single-file limit is 1.99 GB.", {
        max_bytes: FILE_UPLOAD_LIMIT_BYTES,
      });
    }

    const key = sessionKey(auth.token) || requestIp(req);
    const stamp = now();
    let bucket = rateBuckets.get(key);
    if (!bucket || stamp - bucket.startedAt >= uploadWindowMs) {
      bucket = { startedAt: stamp, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > uploadRequestsPerWindow) {
      return sendJson(res, 429, "Too many upload requests. Please retry shortly.");
    }

    const active = Number(activeUploads.get(key) || 0);
    if (active >= uploadConcurrency) {
      return sendJson(res, 429, "Too many uploads are already in progress. Please wait for one to finish.");
    }
    activeUploads.set(key, active + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = Number(activeUploads.get(key) || 0);
      if (current <= 1) activeUploads.delete(key);
      else activeUploads.set(key, current - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  }

  function cleanupUploadedFile(req) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }

  function authorizeInstallation(req, res, { upload = false } = {}) {
    const auth = req.beatgalerPreAuth || authenticate(req, res);
    if (!auth) {
      if (upload) cleanupUploadedFile(req);
      return null;
    }

    const headerInstallation = String(req.headers?.["x-beatgaler-installation-id"] || "").trim();
    const bodyInstallation = String(req.body?.beatgalerUserId || "").trim();
    if (headerInstallation && bodyInstallation && headerInstallation !== bodyInstallation) {
      if (upload) cleanupUploadedFile(req);
      sendJson(res, 403, "This installation does not match the authenticated request.");
      return null;
    }
    const installationId = headerInstallation || bodyInstallation;
    if (!installationId) {
      if (upload) cleanupUploadedFile(req);
      sendJson(res, 400, "beatgalerUserId is required.");
      return null;
    }

    const cloud = readJson(cloudFile, { linkedAccounts: {} });
    const account = cloud.linkedAccounts?.[installationId];
    if (!account || String(account.beatgalerAccountId || "") !== String(auth.user.id || "")) {
      if (upload) cleanupUploadedFile(req);
      sendJson(res, 403, "This installation is not authorized for the signed-in account.");
      return null;
    }

    req.body = req.body || {};
    req.body.beatgalerUserId = installationId;
    req.beatgalerAuthorizedUserId = auth.user.id;
    req.beatgalerAuthorizedInstallationId = installationId;
    return { auth, account, installationId };
  }

  function postUpload(req, res, next) {
    if (req.file && Number(req.file.size || 0) > FILE_UPLOAD_LIMIT_BYTES) {
      cleanupUploadedFile(req);
      return sendJson(res, 413, "FILE_TOO_LARGE: BeatGaler single-file limit is 1.99 GB.", {
        max_bytes: FILE_UPLOAD_LIMIT_BYTES,
      });
    }
    if (!authorizeInstallation(req, res, { upload: true })) return;
    next();
  }

  function bodyOwner(req, res, next) {
    if (!authorizeInstallation(req, res)) return;
    next();
  }

  function registrationGate(_req, res, next) {
    // Development remains usable by default. Public production signup is closed
    // until verification + abuse controls are explicitly enabled.
    if (String(env.NODE_ENV || "") === "production" && String(env.BEATGALER_PUBLIC_REGISTRATION || "") !== "1") {
      return sendJson(res, 503, "Public registration is temporarily unavailable.");
    }
    next();
  }

  function legacyLibraryUpsert(_req, res) {
    return sendJson(res, 410, "Legacy server-side library index upload is disabled. Use the active Galer Cloud session.");
  }

  return {
    preUpload,
    postUpload,
    bodyOwner,
    registrationGate,
    legacyLibraryUpsert,
    authenticate,
    authorizeInstallation,
    constants: {
      FILE_UPLOAD_LIMIT_BYTES,
      uploadWindowMs,
      uploadRequestsPerWindow,
      uploadConcurrency,
    },
  };
}

function installHttpContainment(express, options = {}) {
  if (express.application.__beatgalerContainmentInstalled) return;
  express.application.__beatgalerContainmentInstalled = true;
  const containment = createHttpContainment(options);
  const originalPost = express.application.post;

  express.application.post = function patchedPost(routePath, ...handlers) {
    if (routePath === "/library/upsert") {
      return originalPost.call(this, routePath, containment.legacyLibraryUpsert);
    }
    if (routePath === "/auth/register") {
      return originalPost.call(this, routePath, containment.registrationGate, ...handlers);
    }
    if (UPLOAD_ROUTES.has(routePath) && handlers.length >= 2) {
      return originalPost.call(
        this,
        routePath,
        containment.preUpload,
        handlers[0],
        containment.postUpload,
        ...handlers.slice(1),
      );
    }
    if (BODY_OWNER_ROUTES.has(routePath)) {
      return originalPost.call(this, routePath, containment.bodyOwner, ...handlers);
    }
    return originalPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  FILE_UPLOAD_LIMIT_BYTES,
  createHttpContainment,
  installHttpContainment,
};
