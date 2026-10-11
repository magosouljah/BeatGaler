'use strict';

function installProjectMultipartRoutes(app, { authenticate, verifyCapability,
  capabilityMatches, storageChatId, currentService }) {
  function route(action) {
    return async (req, res) => {
      const auth = authenticate(req, res);
      if (!auth) return;
      if (!capabilityMatches(req)) return res.status(403).json({ code: 'PROJECT_CAPABILITY_REQUIRED' });
      try {
        await verifyCapability(req);
        const service = currentService();
        if (!service) return res.status(503).json({ code: 'PROJECT_STAGING_UNAVAILABLE' });
        const input = { ...req.body, userId: auth.user.id, beatId: req.body.beatId,
          chatId: storageChatId(auth.account) };
        const result = await service[action](input);
        res.json({ ok: true, ...result });
      } catch (error) {
        const code = /^PROJECT_[A-Z0-9_]{1,90}$/.test(error?.code || '')
          ? error.code : 'PROJECT_STAGING_UNAVAILABLE';
        res.status(Number(error?.status || 503)).json({ code, error: code });
      }
    };
  }
  for (const action of ['start', 'status', 'partUrl', 'complete', 'abort', 'retry']) {
    const path = action === 'partUrl' ? 'part-url' : action;
    app.post(`/transport/project/multipart/${path}`, route(action));
  }
}

module.exports = { installProjectMultipartRoutes };
