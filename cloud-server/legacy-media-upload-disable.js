"use strict";

const LEGACY_MEDIA_UPLOAD_ROUTES = new Set([
  "/beats/upload",
  "/projects/upload",
  "/cloud-files/upload",
]);

function installLegacyMediaUploadDisable(express) {
  if (express.application.__beatgalerLegacyMediaUploadDisableInstalled) return;
  express.application.__beatgalerLegacyMediaUploadDisableInstalled = true;
  const originalPost = express.application.post;

  express.application.post = function patchedLegacyMediaPost(routePath, ...handlers) {
    if (LEGACY_MEDIA_UPLOAD_ROUTES.has(routePath)) {
      return originalPost.call(this, routePath, (_req, res) => res.status(410).json({
        error: "Legacy HTTP media upload is disabled. Use the active Galer Cloud Direct transport.",
      }));
    }
    return originalPost.call(this, routePath, ...handlers);
  };
}

module.exports = { LEGACY_MEDIA_UPLOAD_ROUTES, installLegacyMediaUploadDisable };
