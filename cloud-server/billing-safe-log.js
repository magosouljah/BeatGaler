'use strict';

const crypto = require('crypto');

const SAFE_STATE_KEYS = new Set([
  'customerId','subscriptionId','checkoutId','orderId','offerId','planId','status',
  'cancelAtPeriodEnd','currentPeriodStart','currentPeriodEnd','paidThrough','pastDueAt',
  'graceUntil','endedAt','amountMinor','refundedAmountMinor','currency','missing','count',
]);

const SAFE_DETAIL_KEYS = new Set([
  'userId','operationId','eventId','provider','environment','reason','durationMs','errorCode',
  'exceptionKey','repairKind','mode','checkedCount','repairedCount','exceptionCount','failedCount',
  'previousState','nextState',
]);

function safeText(value, max = 256) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : null;
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function sanitizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_STATE_KEYS.has(key)) continue;
    if (typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'number') {
      if (Number.isFinite(raw)) out[key] = raw;
    } else {
      const text = safeText(raw, 256);
      if (text !== null) out[key] = text;
    }
  }
  return out;
}

function sanitizeDetails(details = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(details || {})) {
    if (!SAFE_DETAIL_KEYS.has(key) || raw === undefined || raw === null) continue;
    if (key === 'previousState' || key === 'nextState') {
      const state = sanitizeState(raw);
      if (state) out[key] = state;
      continue;
    }
    if (['durationMs','checkedCount','repairedCount','exceptionCount','failedCount'].includes(key)) {
      const number = safeInteger(raw);
      if (number !== null) out[key] = number;
      continue;
    }
    const text = safeText(raw, key === 'reason' ? 160 : 256);
    if (text !== null) out[key] = text;
  }
  return Object.freeze(out);
}

function safeErrorCode(error, fallback = 'BILLING_RECONCILIATION_FAILED') {
  const code = String(error?.code || '').trim().toUpperCase();
  return /^[A-Z0-9_:-]{1,128}$/.test(code) ? code : fallback;
}

function auditId(eventType, details) {
  const digest = crypto.createHash('sha256').update([
    eventType,
    details.operationId || '',
    details.userId || '',
    details.reason || '',
    details.exceptionKey || '',
  ].join('\n')).digest('hex').slice(0, 40);
  return `billing_audit_${digest}`;
}

function createBillingLogEntry(eventType, details = {}, now = new Date()) {
  const type = safeText(eventType, 96);
  if (!type || !/^[a-z0-9_:-]+$/i.test(type)) throw new Error('Billing log event type is invalid.');
  const safe = sanitizeDetails(details);
  return Object.freeze({
    eventType: type,
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
    ...safe,
  });
}

function createBillingSafeLogger({ sink } = {}) {
  const write = typeof sink === 'function'
    ? sink
    : entry => console.log(JSON.stringify(entry));
  return Object.freeze({
    emit(eventType, details = {}) {
      const entry = createBillingLogEntry(eventType, details);
      write(entry);
      return entry;
    },
  });
}

async function writeBillingAuditEvent(client, eventType, details = {}) {
  const safe = sanitizeDetails(details);
  const id = auditId(eventType, safe);
  await client.query(`
    INSERT INTO audit_events(id,actor_user_id,event_type,subject_type,subject_id,details,created_at)
    VALUES($1,NULL,$2,'billing_user',$3,$4::jsonb,now())
    ON CONFLICT(id) DO NOTHING
  `, [id, eventType, safe.userId || null, JSON.stringify(safe)]);
  return id;
}

module.exports = {
  SAFE_STATE_KEYS,
  SAFE_DETAIL_KEYS,
  sanitizeState,
  sanitizeDetails,
  safeErrorCode,
  createBillingLogEntry,
  createBillingSafeLogger,
  writeBillingAuditEvent,
};
