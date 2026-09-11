'use strict';

const crypto = require('crypto');

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_MAX_RAW_BODY_BYTES = 256 * 1024;

class DurableWebhookError extends Error {
  constructor(message, code = 'WEBHOOK_DURABLE_FAILED', details = null, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DurableWebhookError';
    this.code = code;
    this.details = details;
    if (cause && this.cause == null) this.cause = cause;
  }
}

class DurableWebhookSignatureError extends DurableWebhookError {
  constructor(message = 'Webhook verification failed.', cause = null) {
    super(message, 'WEBHOOK_INVALID_SIGNATURE', null, cause);
    this.name = 'DurableWebhookSignatureError';
  }
}

class DurableWebhookIdentityError extends DurableWebhookError {
  constructor(message = 'Webhook event identity collision.', details = null) {
    super(message, 'WEBHOOK_IDENTITY_COLLISION', details);
    this.name = 'DurableWebhookIdentityError';
  }
}

class DurableWebhookBindingError extends DurableWebhookError {
  constructor(message = 'Trusted billing bindings disagree.', details = null) {
    super(message, 'WEBHOOK_BINDING_CONFLICT', details);
    this.name = 'DurableWebhookBindingError';
  }
}

class DurableWebhookProcessingError extends DurableWebhookError {
  constructor(message = 'Durable webhook processing failed.', code = 'WEBHOOK_PROCESSING_FAILED', cause = null) {
    super(message, code, null, cause);
    this.name = 'DurableWebhookProcessingError';
  }
}

function requiredText(value, label, pattern = null) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new DurableWebhookError(`${label} is required.`, 'WEBHOOK_INVALID_EVENT');
  if (pattern && !pattern.test(text)) {
    throw new DurableWebhookError(`${label} is invalid.`, 'WEBHOOK_INVALID_EVENT');
  }
  return text;
}

function optionalText(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function pickFirst(...values) {
  for (const value of values) {
    const text = optionalText(value);
    if (text) return text;
  }
  return null;
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    throw new DurableWebhookError('Webhook headers are required.', 'WEBHOOK_INVALID_HEADERS');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    normalized[String(key).toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return normalized;
}

function requireRawBody(rawBody, maxBytes) {
  if (!Buffer.isBuffer(rawBody)) {
    throw new DurableWebhookSignatureError('Webhook raw body Buffer is required.');
  }
  if (rawBody.length > maxBytes) {
    throw new DurableWebhookError('Webhook body exceeds the configured limit.', 'WEBHOOK_BODY_TOO_LARGE');
  }
  return rawBody;
}

function rawBodyDigest(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(String(value == null ? '' : value));
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new DurableWebhookError('Verified webhook timestamp is invalid.', 'WEBHOOK_INVALID_EVENT');
  }
  return Object.freeze({ iso: date.toISOString(), milliseconds });
}

function pickBeatGalerMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = [
    'beatgaler_user_id',
    'beatgaler_offer_id',
    'beatgaler_plan_id',
    'beatgaler_provider_product_id',
    'beatgaler_provider_price_id',
  ];
  const selected = {};
  for (const key of allowed) {
    if (value[key] != null) selected[key] = String(value[key]);
  }
  return Object.keys(selected).length ? selected : null;
}

function minimalValidatedData(data) {
  const keys = [
    'id', 'status', 'customer_id', 'subscription_id', 'checkout_id', 'order_id', 'payment_id', 'refund_id',
    'external_id', 'product_id', 'product_price_id', 'price_id', 'currency', 'amount', 'amount_minor',
    'refunded_amount', 'refunded_amount_minor', 'current_period_start', 'current_period_end',
    'cancel_at_period_end', 'canceled_at', 'ends_at', 'ended_at', 'billing_reason',
  ];
  const selected = {};
  for (const key of keys) {
    if (data[key] !== undefined) selected[key] = data[key];
  }
  const metadata = pickBeatGalerMetadata(data.metadata);
  if (metadata) selected.metadata = metadata;
  return selected;
}

function normalizeVerifiedEvent({ verified, headers, provider, environment }) {
  if (!verified || typeof verified !== 'object') {
    throw new DurableWebhookError('Verifier returned no webhook event.', 'WEBHOOK_INVALID_EVENT');
  }
  const normalizedHeaders = normalizeHeaders(headers);
  const eventId = requiredText(normalizedHeaders['webhook-id'], 'webhook-id', /^[A-Za-z0-9._:-]{1,256}$/);
  requiredText(normalizedHeaders['webhook-timestamp'], 'webhook-timestamp');
  requiredText(normalizedHeaders['webhook-signature'], 'webhook-signature');

  const eventType = requiredText(verified.type, 'webhook type', /^[A-Za-z0-9_.:-]{1,160}$/);
  const timestamp = normalizeTimestamp(verified.timestamp);
  const data = verified.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new DurableWebhookError('Verified webhook data must be an object.', 'WEBHOOK_INVALID_EVENT');
  }
  const subjectId = requiredText(data.id, 'webhook data.id');
  const providerCustomerId = pickFirst(
    data.customer_id,
    data.customerId,
    data.customer?.id,
    eventType.startsWith('customer.') ? data.id : null,
  );
  const providerSubscriptionId = pickFirst(
    data.subscription_id,
    data.subscriptionId,
    data.subscription?.id,
    eventType.startsWith('subscription.') ? data.id : null,
  );
  const providerCheckoutId = pickFirst(
    data.checkout_id,
    data.checkoutId,
    data.checkout?.id,
    eventType.startsWith('checkout.') ? data.id : null,
  );

  return Object.freeze({
    eventId,
    eventType,
    subjectId,
    providerCreatedAt: timestamp.milliseconds,
    provider: requiredText(provider, 'provider'),
    environment: requiredText(environment, 'provider environment'),
    providerCustomerId,
    providerSubscriptionId,
    providerCheckoutId,
    validatedPayload: Object.freeze({
      type: eventType,
      timestamp: timestamp.iso,
      data: Object.freeze(minimalValidatedData(data)),
    }),
  });
}

function safeErrorCode(error) {
  const code = String(error?.code || 'WEBHOOK_PROCESSING_FAILED').trim().toUpperCase();
  return /^[A-Z0-9_:-]{1,128}$/.test(code) ? code : 'WEBHOOK_PROCESSING_FAILED';
}

function redactedErrorMessage(error) {
  const code = safeErrorCode(error);
  if (code === 'WEBHOOK_BINDING_CONFLICT') return 'trusted billing bindings disagree';
  if (code === 'WEBHOOK_PROCESSING_LOCK_TIMEOUT') return 'processing lock unavailable';
  if (code === 'WEBHOOK_LEASE_LOST') return 'processing lease lost';
  return 'webhook processing failed';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function publicInboxRow(row) {
  if (!row) return null;
  return Object.freeze({
    eventId: row.event_id,
    eventType: row.event_type,
    subjectId: row.subject_id,
    provider: row.provider,
    environment: row.provider_environment,
    state: row.state,
    attemptCount: Number(row.attempt_count || 0),
    resolvedUserId: row.resolved_user_id || null,
    providerCustomerId: row.provider_customer_id || null,
    providerSubscriptionId: row.provider_subscription_id || null,
    providerCheckoutId: row.provider_checkout_id || null,
    receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
    leaseOwner: row.processing_lease_owner || null,
    leaseUntil: row.processing_lease_until ? new Date(row.processing_lease_until).toISOString() : null,
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    lastErrorCode: row.last_error_code || null,
    validatedPayload: row.validated_payload || {},
  });
}

function createDurableWebhookInbox({
  pool,
  adapter,
  leaseMs = DEFAULT_LEASE_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxRawBodyBytes = DEFAULT_MAX_RAW_BODY_BYTES,
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new DurableWebhookError('PostgreSQL pool is required.', 'WEBHOOK_CONFIG_INVALID');
  }
  if (!adapter || typeof adapter.verifyWebhook !== 'function') {
    throw new DurableWebhookError('Webhook provider adapter is required.', 'WEBHOOK_CONFIG_INVALID');
  }
  const provider = requiredText(adapter.provider, 'adapter provider');
  const environment = requiredText(adapter.environment, 'adapter environment');
  for (const [label, value] of Object.entries({ leaseMs, lockTimeoutMs, retryBaseMs, retryMaxMs, maxAttempts, maxRawBodyBytes })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new DurableWebhookError(`${label} must be a positive integer.`, 'WEBHOOK_CONFIG_INVALID');
    }
  }

  function retryDelay(attemptCount) {
    const exponent = Math.max(0, Number(attemptCount || 1) - 1);
    return Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(exponent, 20)));
  }

  async function receive({ rawBody, headers }) {
    const raw = requireRawBody(rawBody, maxRawBodyBytes);
    let verified;
    try {
      verified = await adapter.verifyWebhook({ rawBody: raw, headers });
    } catch (error) {
      throw new DurableWebhookSignatureError('Webhook signature verification failed.', error);
    }

    const normalized = normalizeVerifiedEvent({ verified, headers, provider, environment });
    const digest = rawBodyDigest(raw);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`
        INSERT INTO billing_webhook_events(
          event_id,event_type,subject_id,provider_created_at,state,attempt_count,
          provider,provider_environment,raw_body_sha256,validated_payload,
          provider_customer_id,provider_subscription_id,provider_checkout_id,
          received_at,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,'RECEIVED',0,$5,$6,$7,$8::jsonb,$9,$10,$11,now(),now(),now())
        ON CONFLICT(provider,provider_environment,event_id) DO NOTHING
        RETURNING *
      `, [
        normalized.eventId,
        normalized.eventType,
        normalized.subjectId,
        normalized.providerCreatedAt,
        provider,
        environment,
        digest,
        JSON.stringify(normalized.validatedPayload),
        normalized.providerCustomerId,
        normalized.providerSubscriptionId,
        normalized.providerCheckoutId,
      ]);

      if (inserted.rowCount === 1) {
        await client.query('COMMIT');
        return Object.freeze({
          accepted: true,
          persisted: true,
          duplicate: false,
          eventId: normalized.eventId,
          state: 'RECEIVED',
          entitlementGranted: false,
        });
      }

      const existingResult = await client.query(`
        SELECT * FROM billing_webhook_events
        WHERE provider=$1 AND provider_environment=$2 AND event_id=$3
        FOR UPDATE
      `, [provider, environment, normalized.eventId]);
      const existing = existingResult.rows[0];
      if (!existing) throw new Error('Webhook idempotency race produced no row.');

      const sameIdentity = existing.event_type === normalized.eventType
        && existing.subject_id === normalized.subjectId
        && Number(existing.provider_created_at) === normalized.providerCreatedAt
        && existing.raw_body_sha256 === digest;
      if (!sameIdentity) {
        throw new DurableWebhookIdentityError('webhook-id was reused with different verified content.', {
          eventId: normalized.eventId,
          provider,
          environment,
        });
      }

      await client.query('COMMIT');
      return Object.freeze({
        accepted: true,
        persisted: true,
        duplicate: true,
        eventId: normalized.eventId,
        state: existing.state,
        entitlementGranted: false,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof DurableWebhookError) throw error;
      throw new DurableWebhookError(
        'Verified webhook could not be persisted.',
        'WEBHOOK_INBOX_PERSIST_FAILED',
        null,
        error,
      );
    } finally {
      client.release();
    }
  }

  async function claimNext(workerId) {
    const owner = requiredText(workerId, 'workerId', /^[A-Za-z0-9._:-]{1,128}$/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const candidate = await client.query(`
        SELECT *
        FROM billing_webhook_events
        WHERE provider=$1
          AND provider_environment=$2
          AND (
            state='RECEIVED'
            OR (state='FAILED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
            OR (state='PROCESSING' AND processing_lease_until <= now())
          )
        ORDER BY received_at ASC, event_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `, [provider, environment]);
      if (!candidate.rows[0]) {
        await client.query('COMMIT');
        return null;
      }

      const claimed = await client.query(`
        UPDATE billing_webhook_events
        SET state='PROCESSING',
            attempt_count=attempt_count+1,
            processing_lease_owner=$4,
            processing_lease_until=now()+($5 * interval '1 millisecond'),
            next_attempt_at=NULL,
            processed_at=NULL,
            last_error_code=NULL,
            last_error_redacted=NULL,
            updated_at=now()
        WHERE provider=$1 AND provider_environment=$2 AND event_id=$3
        RETURNING *
      `, [provider, environment, candidate.rows[0].event_id, owner, leaseMs]);
      await client.query('COMMIT');
      return publicInboxRow(claimed.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function resolveTrustedUser(queryable, event) {
    const candidates = new Set();
    if (event.resolvedUserId) candidates.add(event.resolvedUserId);

    if (event.providerCustomerId) {
      const result = await queryable.query(`
        SELECT user_id FROM billing_customers
        WHERE provider=$1 AND provider_environment=$2 AND provider_customer_id=$3
        LIMIT 2
      `, [provider, environment, event.providerCustomerId]);
      for (const row of result.rows) candidates.add(row.user_id);
    }

    if (event.providerSubscriptionId) {
      const result = await queryable.query(`
        SELECT user_id FROM billing_subscription_state
        WHERE provider=$1 AND provider_environment=$2 AND provider_subscription_id=$3
        LIMIT 2
      `, [provider, environment, event.providerSubscriptionId]);
      for (const row of result.rows) candidates.add(row.user_id);
    }

    if (event.providerCheckoutId) {
      const result = await queryable.query(`
        SELECT user_id FROM billing_checkout_requests
        WHERE provider=$1 AND provider_environment=$2 AND provider_checkout_id=$3
        LIMIT 2
      `, [provider, environment, event.providerCheckoutId]);
      for (const row of result.rows) candidates.add(row.user_id);
    }

    if (candidates.size > 1) {
      throw new DurableWebhookBindingError('Provider identifiers resolve to different BeatGaler users.', {
        eventId: event.eventId,
        provider,
        environment,
      });
    }
    return candidates.size === 1 ? Array.from(candidates)[0] : null;
  }

  async function tryAcquireLock(client, lockKey) {
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      const result = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockKey],
      );
      if (result.rows[0]?.locked === true) return true;
      if (Date.now() >= deadline) return false;
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }

  async function withProcessingLock(event, action) {
    const initialUserId = await resolveTrustedUser(pool, event);
    const lockKey = initialUserId
      ? `beatgaler:billing-user:${initialUserId}`
      : `beatgaler:billing-subject:${provider}:${environment}:${event.subjectId}`;
    const client = await pool.connect();
    let locked = false;
    try {
      locked = await tryAcquireLock(client, lockKey);
      if (!locked) {
        throw new DurableWebhookProcessingError(
          'Webhook processing lock timed out.',
          'WEBHOOK_PROCESSING_LOCK_TIMEOUT',
        );
      }
      return await action(client, initialUserId);
    } finally {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => {});
      }
      client.release();
    }
  }

  async function markIgnored(eventId, workerId, reasonCode = 'WEBHOOK_EVENT_UNSUPPORTED') {
    const result = await pool.query(`
      UPDATE billing_webhook_events
      SET state='IGNORED',
          processed_at=now(),
          processing_lease_owner=NULL,
          processing_lease_until=NULL,
          next_attempt_at=NULL,
          last_error_code=$5,
          last_error_redacted='event intentionally ignored',
          updated_at=now()
      WHERE provider=$1 AND provider_environment=$2 AND event_id=$3
        AND state='PROCESSING' AND processing_lease_owner=$4
      RETURNING *
    `, [provider, environment, eventId, workerId, reasonCode]);
    if (result.rowCount !== 1) {
      throw new DurableWebhookProcessingError('Webhook processing lease was lost.', 'WEBHOOK_LEASE_LOST');
    }
    return publicInboxRow(result.rows[0]);
  }

  async function markFailed(event, workerId, error, { retryable = true } = {}) {
    const attemptCount = Number(event.attemptCount || 0);
    const canRetry = retryable && attemptCount < maxAttempts;
    const delayMs = canRetry ? retryDelay(attemptCount) : null;
    const code = safeErrorCode(error);
    const result = await pool.query(`
      UPDATE billing_webhook_events
      SET state='FAILED',
          processed_at=NULL,
          processing_lease_owner=NULL,
          processing_lease_until=NULL,
          next_attempt_at=CASE WHEN $7::bigint IS NULL THEN NULL ELSE now()+($7 * interval '1 millisecond') END,
          last_error_code=$5,
          last_error_redacted=$6,
          updated_at=now()
      WHERE provider=$1 AND provider_environment=$2 AND event_id=$3
        AND state='PROCESSING' AND processing_lease_owner=$4
      RETURNING *
    `, [provider, environment, event.eventId, workerId, code, redactedErrorMessage(error), delayMs]);
    return result.rows[0] ? publicInboxRow(result.rows[0]) : null;
  }

  async function processNext({ workerId, handlers = {} } = {}) {
    const owner = requiredText(workerId, 'workerId', /^[A-Za-z0-9._:-]{1,128}$/);
    const event = await claimNext(owner);
    if (!event) return null;

    const handler = handlers[event.eventType];
    if (typeof handler !== 'function' && (!handler || typeof handler.apply !== 'function')) {
      return markIgnored(event.eventId, owner);
    }

    try {
      return await withProcessingLock(event, async lockClient => {
        const resolvedUserId = await resolveTrustedUser(lockClient, event);
        const context = Object.freeze({
          event,
          resolvedUserId,
          provider,
          environment,
        });

        let prepared = null;
        if (handler && typeof handler.prepare === 'function') {
          prepared = await handler.prepare(context);
        }

        await lockClient.query('BEGIN');
        try {
          const currentResult = await lockClient.query(`
            SELECT * FROM billing_webhook_events
            WHERE provider=$1 AND provider_environment=$2 AND event_id=$3
            FOR UPDATE
          `, [provider, environment, event.eventId]);
          const current = currentResult.rows[0];
          if (!current || current.state !== 'PROCESSING' || current.processing_lease_owner !== owner) {
            throw new DurableWebhookProcessingError('Webhook processing lease was lost.', 'WEBHOOK_LEASE_LOST');
          }

          const finalUserId = await resolveTrustedUser(lockClient, {
            ...event,
            resolvedUserId,
          });
          if (typeof handler === 'function') {
            await handler(lockClient, Object.freeze({ ...context, resolvedUserId: finalUserId }));
          } else {
            await handler.apply(
              lockClient,
              Object.freeze({ ...context, resolvedUserId: finalUserId }),
              prepared,
            );
          }

          const completed = await lockClient.query(`
            UPDATE billing_webhook_events
            SET state='PROCESSED',
                resolved_user_id=$5,
                processed_at=now(),
                processing_lease_owner=NULL,
                processing_lease_until=NULL,
                next_attempt_at=NULL,
                last_error_code=NULL,
                last_error_redacted=NULL,
                updated_at=now()
            WHERE provider=$1 AND provider_environment=$2 AND event_id=$3
              AND state='PROCESSING' AND processing_lease_owner=$4
            RETURNING *
          `, [provider, environment, event.eventId, owner, finalUserId]);
          if (completed.rowCount !== 1) {
            throw new DurableWebhookProcessingError('Webhook processing lease was lost.', 'WEBHOOK_LEASE_LOST');
          }
          await lockClient.query('COMMIT');
          return publicInboxRow(completed.rows[0]);
        } catch (error) {
          await lockClient.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
    } catch (error) {
      await markFailed(event, owner, error).catch(() => {});
      if (error instanceof DurableWebhookProcessingError || error instanceof DurableWebhookBindingError) throw error;
      throw new DurableWebhookProcessingError('Durable webhook handler failed.', safeErrorCode(error), error);
    }
  }

  async function requeueFailed(eventId) {
    const id = requiredText(eventId, 'eventId');
    const result = await pool.query(`
      UPDATE billing_webhook_events
      SET next_attempt_at=now(), last_error_code=NULL, last_error_redacted=NULL, updated_at=now()
      WHERE provider=$1 AND provider_environment=$2 AND event_id=$3 AND state='FAILED'
      RETURNING *
    `, [provider, environment, id]);
    return result.rows[0] ? publicInboxRow(result.rows[0]) : null;
  }

  async function getEvent(eventId) {
    const id = requiredText(eventId, 'eventId');
    const result = await pool.query(`
      SELECT * FROM billing_webhook_events
      WHERE provider=$1 AND provider_environment=$2 AND event_id=$3
      LIMIT 1
    `, [provider, environment, id]);
    return publicInboxRow(result.rows[0]);
  }

  return Object.freeze({
    provider,
    environment,
    receive,
    claimNext,
    processNext,
    requeueFailed,
    getEvent,
  });
}

module.exports = {
  DEFAULT_LEASE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_RAW_BODY_BYTES,
  DurableWebhookError,
  DurableWebhookSignatureError,
  DurableWebhookIdentityError,
  DurableWebhookBindingError,
  DurableWebhookProcessingError,
  rawBodyDigest,
  normalizeVerifiedEvent,
  createDurableWebhookInbox,
};
