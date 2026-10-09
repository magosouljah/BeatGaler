'use strict';

const {
  DEFAULT_MAX_RAW_BODY_BYTES,
  DurableWebhookError,
} = require('./billing-webhook-durable');

function createPolarWebhookRoute({ currentInbox }) {
  return async function polarWebhook(req, res) {
    const inbox = currentInbox();
    if (!inbox) return res.status(503).json({ error: 'Webhook is unavailable.', code: 'WEBHOOK_RUNTIME_UNAVAILABLE' });
    try {
      const receipt = await inbox.receive({ rawBody: req.body, headers: req.headers });
      return res.status(202).json({
        accepted: true,
        duplicate: receipt.duplicate,
        eventId: receipt.eventId,
        state: receipt.state,
      });
    } catch (error) {
      if (!(error instanceof DurableWebhookError)) {
        return res.status(503).json({ error: 'Webhook could not be persisted.', code: 'WEBHOOK_INBOX_PERSIST_FAILED' });
      }
      const status = error.code === 'WEBHOOK_INVALID_SIGNATURE' ? 403
        : error.code === 'WEBHOOK_BODY_TOO_LARGE' ? 413
        : error.code === 'WEBHOOK_IDENTITY_COLLISION' ? 409
        : ['WEBHOOK_INVALID_HEADERS', 'WEBHOOK_INVALID_EVENT'].includes(error.code) ? 400 : 503;
      return res.status(status).json({ error: 'Webhook rejected.', code: error.code });
    }
  };
}

function polarRawBodyError(error, _req, res, next) {
  if (!error) return next();
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Webhook body too large.', code: 'WEBHOOK_BODY_TOO_LARGE' });
  }
  return res.status(400).json({ error: 'Webhook body invalid.', code: 'WEBHOOK_BODY_INVALID' });
}

function installPolarWebhookRoute(app, express, { currentInbox }) {
  app.post('/webhooks/polar',
    express.raw({ type: () => true, limit: DEFAULT_MAX_RAW_BODY_BYTES, inflate: false }),
    createPolarWebhookRoute({ currentInbox }),
    polarRawBodyError,
  );
}

module.exports = { createPolarWebhookRoute, polarRawBodyError, installPolarWebhookRoute };
