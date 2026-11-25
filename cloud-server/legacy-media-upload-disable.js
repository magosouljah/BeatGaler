"use strict";

const LEGACY_MEDIA_UPLOAD_ROUTES = new Set([
  "/beats/upload",
  "/projects/upload",
  "/cloud-files/upload",
]);

function installLegacyMediaUploadDisable(express) {
  if (express.application.__beatgalerLegacyMediaUploadDisableInstalled) return;
  express.application.__beatgalerLegacyMediaUploadDisableInstalled = true;
}

function wrapLegacyMediaUploadPost(routePath, handlers) {
  const { app, next } = this;
  if (app.__beatgalerLegacyMediaUploadDisableInstalled && LEGACY_MEDIA_UPLOAD_ROUTES.has(routePath)) {
    return next(routePath, (_req, res) => res.status(410).json({
      error: "Legacy HTTP media upload is disabled. Use the active Galer Cloud Direct transport.",
    }));
  }
  return next(routePath, ...handlers);
}

module.exports = { LEGACY_MEDIA_UPLOAD_ROUTES, installLegacyMediaUploadDisable, wrapLegacyMediaUploadPost };
