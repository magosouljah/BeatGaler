"use strict";

const LEGACY_MEDIA_UPLOAD_ROUTES = new Set([
  "/beats/upload",
  "/projects/upload",
  "/cloud-files/upload",
]);

function installLegacyMediaUploadDisable(ctx) {
  ctx.entries.legacyMediaUploadDisable ||= { installed: true };
}

function wrapLegacyMediaUploadPost(routePath, handlers) {
  const { next, ctx } = this;
  if (ctx?.entries.legacyMediaUploadDisable &&LEGACY_MEDIA_UPLOAD_ROUTES.has(routePath)) {
    return next(routePath, (_req, res) => res.status(410).json({
      error: "Legacy HTTP media upload is disabled. Use the active Galer Cloud Direct transport.",
    }));
  }
  return next(routePath, ...handlers);
}

module.exports = { LEGACY_MEDIA_UPLOAD_ROUTES, installLegacyMediaUploadDisable, wrapLegacyMediaUploadPost };
