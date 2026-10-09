'use strict';

const { createDurableWebhookInbox } = require('./billing-webhook-durable');

let inbox = null;
let failureCode = 'WEBHOOK_RUNTIME_NOT_INITIALIZED';

function configure({ pool, adapter, env = process.env } = {}) {
  inbox = null;
  failureCode = 'WEBHOOK_RUNTIME_UNAVAILABLE';
  if (!String(env.POLAR_SANDBOX_WEBHOOK_SECRET || '').trim()) {
    failureCode = 'WEBHOOK_SECRET_MISSING';
    return status();
  }
  try {
    if (adapter?.provider !== 'polar' || adapter?.environment !== 'sandbox') {
      throw new Error('WEBHOOK_ADAPTER_INVALID');
    }
    inbox = createDurableWebhookInbox({ pool, adapter });
    failureCode = null;
  } catch {
    failureCode = 'WEBHOOK_RUNTIME_UNAVAILABLE';
  }
  return status();
}

function status() { return Object.freeze({ ready: Boolean(inbox), failureCode }); }
function current() { return inbox; }

module.exports = { configure, status, current };
