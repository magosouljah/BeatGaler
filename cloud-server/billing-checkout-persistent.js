'use strict';

const crypto = require('crypto');

const PROVIDER = 'polar';
const PROVIDER_ENVIRONMENT = 'sandbox';
const UNRESOLVED_STATES = Object.freeze(['CREATING', 'OPEN', 'AMBIGUOUS']);
const TERMINAL_STATES = Object.freeze(['COMPLETED', 'EXPIRED', 'FAILED']);

class PersistentCheckoutError extends Error {
  constructor(message, code = 'BILLING_CHECKOUT_FAILED', details = null, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PersistentCheckoutError';
    this.code = code;
    this.details = details;
    if (cause && this.cause == null) this.cause = cause;
  }
}

function requiredText(value, label, pattern = null) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new PersistentCheckoutError(`${label} is required.`, 'BILLING_CHECKOUT_INVALID_REQUEST');
  if (pattern && !pattern.test(text)) {
    throw new PersistentCheckoutError(`${label} is invalid.`, 'BILLING_CHECKOUT_INVALID_REQUEST');
  }
  return text;
}

function normalizeCallbackUrl(value, label, allowedOrigins) {
  let url;
  try {
    url = new URL(requiredText(value, label));
  } catch (error) {
    if (error instanceof PersistentCheckoutError) throw error;
    throw new PersistentCheckoutError(`${label} must be an absolute URL.`, 'BILLING_CHECKOUT_CALLBACK_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PersistentCheckoutError(`${label} is not allowed.`, 'BILLING_CHECKOUT_CALLBACK_INVALID');
  }
  if (!allowedOrigins.has(url.origin)) {
    throw new PersistentCheckoutError(`${label} origin is not allowed.`, 'BILLING_CHECKOUT_CALLBACK_NOT_ALLOWED');
  }
  url.hash = '';
  return url.toString();
}

function normalizeProviderCheckoutUrl(value) {
  let url;
  try {
    url = new URL(requiredText(value, 'provider checkout url'));
  } catch (error) {
    if (error instanceof PersistentCheckoutError) throw error;
    throw new PersistentCheckoutError(
      'Provider checkout URL is invalid.',
      'BILLING_CHECKOUT_PROVIDER_RESPONSE_INVALID',
    );
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PersistentCheckoutError(
      'Provider checkout URL is invalid.',
      'BILLING_CHECKOUT_PROVIDER_RESPONSE_INVALID',
    );
  }
  url.hash = '';
  return url.toString();
}

function checkoutRequestHash({ offerId, successUrl, returnUrl }) {
  const payload = JSON.stringify({
    offerId: requiredText(offerId, 'offerId', /^[a-z0-9_]+$/),
    successUrl: requiredText(successUrl, 'successUrl'),
    returnUrl: requiredText(returnUrl, 'returnUrl'),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function safeProviderErrorCode(error) {
  const code = String(error?.code || 'BILLING_CHECKOUT_PROVIDER_FAILED').trim();
  return /^[A-Z0-9_:-]{1,128}$/.test(code) ? code : 'BILLING_CHECKOUT_PROVIDER_FAILED';
}

function providerFailureCouldHaveCreatedCheckout(error) {
  const code = safeProviderErrorCode(error);
  if (code === 'POLAR_SANDBOX_PRODUCT_GET_FAILED') return false;
  if (code === 'POLAR_SANDBOX_PROVIDER_MAPPING_MISMATCH') return false;
  if (code === 'BILLING_OFFER_UNKNOWN') return false;
  if (code === 'BILLING_OFFER_DISABLED') return false;
  if (code === 'BILLING_OFFER_PROVIDER_UNCONFIGURED') return false;
  if (code === 'POLAR_SANDBOX_CONFIG_INVALID') return false;
  return true;
}

function publicRow(row, { recovered = false } = {}) {
  return Object.freeze({
    requestId: row.request_id,
    state: row.state,
    offerId: row.offer_id,
    checkoutId: row.provider_checkout_id || null,
    url: row.checkout_url || null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    recovered,
    entitlementGranted: false,
  });
}

function createPersistentCheckoutService({
  pool,
  adapter,
  allowedCallbackOrigins,
  providerCallTimeoutMs = 20_000,
  now = () => new Date(),
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new PersistentCheckoutError('PostgreSQL pool is required.', 'BILLING_CHECKOUT_CONFIG_INVALID');
  }
  if (!adapter || typeof adapter.createCheckout !== 'function' || typeof adapter.getCheckoutOffer !== 'function') {
    throw new PersistentCheckoutError('Billing provider adapter is required.', 'BILLING_CHECKOUT_CONFIG_INVALID');
  }
  if (adapter.provider !== PROVIDER || adapter.environment !== PROVIDER_ENVIRONMENT) {
    throw new PersistentCheckoutError(
      'Billing V1 persistent checkout currently requires Polar sandbox.',
      'BILLING_CHECKOUT_CONFIG_INVALID',
    );
  }
  const allowedOrigins = new Set(Array.from(allowedCallbackOrigins || [], value => {
    const url = new URL(String(value));
    return url.origin;
  }));
  if (allowedOrigins.size === 0) {
    throw new PersistentCheckoutError(
      'At least one allowed callback origin is required.',
      'BILLING_CHECKOUT_CONFIG_INVALID',
    );
  }
  if (!Number.isInteger(providerCallTimeoutMs) || providerCallTimeoutMs < 1) {
    throw new PersistentCheckoutError('providerCallTimeoutMs is invalid.', 'BILLING_CHECKOUT_CONFIG_INVALID');
  }

  async function withUserLock(userId, action) {
    const client = await pool.connect();
    const lockName = `beatgaler:billing-checkout:${userId}`;
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
      locked = true;
      return await action(client);
    } finally {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]).catch(() => {});
      }
      client.release();
    }
  }

  async function raceProvider(promise) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new PersistentCheckoutError(
        'Checkout provider result is uncertain.',
        'BILLING_CHECKOUT_PROVIDER_TIMEOUT',
      )), providerCallTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function loadCustomerOwnership(client, userId) {
    const result = await client.query(`
      SELECT user_id, provider_customer_id, external_id
      FROM billing_customers
      WHERE user_id=$1 AND provider=$2 AND provider_environment=$3
      LIMIT 1
    `, [userId, PROVIDER, PROVIDER_ENVIRONMENT]);
    const row = result.rows[0] || null;
    if (row && row.external_id !== userId) {
      throw new PersistentCheckoutError(
        'Billing customer ownership mismatch.',
        'BILLING_CHECKOUT_CUSTOMER_OWNERSHIP_MISMATCH',
      );
    }
    return row;
  }

  async function assertNoLiveSubscription(client, userId) {
    const result = await client.query(`
      SELECT provider_subscription_id, ended_at
      FROM billing_subscription_state
      WHERE user_id=$1
      LIMIT 1
    `, [userId]);
    const row = result.rows[0] || null;
    if (row?.provider_subscription_id && (!row.ended_at || new Date(row.ended_at) > now())) {
      throw new PersistentCheckoutError(
        'Existing subscribers must manage plan changes through the billing portal.',
        'BILLING_CHECKOUT_SUBSCRIBER_PORTAL_REQUIRED',
      );
    }
  }

  async function persistCustomerBestEffort(client, userId) {
    if (typeof adapter.getCustomerByExternalId !== 'function') return;
    try {
      const customer = await adapter.getCustomerByExternalId(userId);
      const providerCustomerId = String(customer?.id || '').trim();
      if (!providerCustomerId) return;
      await client.query(`
        INSERT INTO billing_customers(
          id,user_id,provider,provider_environment,provider_customer_id,external_id,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,now(),now())
        ON CONFLICT (user_id,provider,provider_environment)
        DO UPDATE SET
          provider_customer_id=EXCLUDED.provider_customer_id,
          external_id=EXCLUDED.external_id,
          updated_at=now()
        WHERE billing_customers.external_id=EXCLUDED.external_id
      `, [crypto.randomUUID(), userId, PROVIDER, PROVIDER_ENVIRONMENT, providerCustomerId, userId]);
    } catch (_) {
      // Checkout recovery must not depend on this cache/projection. The checkout
      // itself is already identity-bound by external_customer_id=userId.
    }
  }

  async function createSession({ user, request, successUrl, returnUrl }) {
    const userId = requiredText(user?.id, 'authenticated user id');
    const email = user?.email == null ? null : requiredText(user.email, 'authenticated user email');
    const requestId = requiredText(
      request?.requestId ?? request?.checkoutRequestId,
      'requestId',
      /^[A-Za-z0-9_-]{8,128}$/,
    );
    const offerId = requiredText(request?.offerId, 'offerId', /^[a-z0-9_]+$/);
    const normalizedSuccessUrl = normalizeCallbackUrl(successUrl, 'successUrl', allowedOrigins);
    const normalizedReturnUrl = normalizeCallbackUrl(returnUrl, 'returnUrl', allowedOrigins);

    let offer;
    try {
      offer = adapter.getCheckoutOffer(offerId);
    } catch (error) {
      throw new PersistentCheckoutError(
        'Billing offer is unavailable.',
        error?.code || 'BILLING_CHECKOUT_OFFER_UNAVAILABLE',
        null,
        error,
      );
    }

    const requestHash = checkoutRequestHash({
      offerId: offer.id,
      successUrl: normalizedSuccessUrl,
      returnUrl: normalizedReturnUrl,
    });

    return withUserLock(userId, async client => {
      await loadCustomerOwnership(client, userId);

      const existingResult = await client.query(`
        SELECT *
        FROM billing_checkout_requests
        WHERE user_id=$1 AND request_id=$2
        LIMIT 1
      `, [userId, requestId]);
      const existing = existingResult.rows[0] || null;

      if (existing) {
        if (existing.request_hash_sha256 !== requestHash) {
          throw new PersistentCheckoutError(
            'requestId was already used with different checkout parameters.',
            'BILLING_CHECKOUT_REQUEST_CONFLICT',
          );
        }
        if (existing.state === 'OPEN' && existing.provider_checkout_id && existing.checkout_url) {
          return publicRow(existing, { recovered: true });
        }
        if (existing.state === 'CREATING') {
          await client.query(`
            UPDATE billing_checkout_requests
            SET state='AMBIGUOUS', last_error_code='BILLING_CHECKOUT_RECOVERED_CREATING', updated_at=now()
            WHERE user_id=$1 AND request_id=$2 AND state='CREATING'
          `, [userId, requestId]);
          throw new PersistentCheckoutError(
            'Previous checkout creation has an uncertain provider result and requires reconciliation.',
            'BILLING_CHECKOUT_AMBIGUOUS',
            { requestId, state: 'AMBIGUOUS' },
          );
        }
        if (existing.state === 'AMBIGUOUS') {
          throw new PersistentCheckoutError(
            'Checkout creation is ambiguous and must be reconciled before another checkout is created.',
            'BILLING_CHECKOUT_AMBIGUOUS',
            { requestId, state: 'AMBIGUOUS' },
          );
        }
        throw new PersistentCheckoutError(
          `Checkout request is already ${existing.state.toLowerCase()}. Use a new requestId for a new logical attempt.`,
          `BILLING_CHECKOUT_${existing.state}`,
          { requestId, state: existing.state },
        );
      }

      await assertNoLiveSubscription(client, userId);

      const unresolved = await client.query(`
        SELECT request_id, state
        FROM billing_checkout_requests
        WHERE user_id=$1 AND state = ANY($2::text[])
        LIMIT 1
      `, [userId, UNRESOLVED_STATES]);
      if (unresolved.rows[0]) {
        throw new PersistentCheckoutError(
          'Another checkout attempt for this user is unresolved.',
          'BILLING_CHECKOUT_UNRESOLVED_EXISTS',
          { requestId: unresolved.rows[0].request_id, state: unresolved.rows[0].state },
        );
      }

      await client.query(`
        INSERT INTO billing_checkout_requests(
          user_id,request_id,offer_id,request_hash_sha256,provider,provider_environment,state,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'CREATING',now(),now())
      `, [userId, requestId, offer.id, requestHash, PROVIDER, PROVIDER_ENVIRONMENT]);

      let checkout;
      try {
        checkout = await raceProvider(adapter.createCheckout({
          offerId: offer.id,
          userId,
          email,
          successUrl: normalizedSuccessUrl,
          returnUrl: normalizedReturnUrl,
        }));
      } catch (error) {
        const ambiguous = providerFailureCouldHaveCreatedCheckout(error);
        const nextState = ambiguous ? 'AMBIGUOUS' : 'FAILED';
        const errorCode = safeProviderErrorCode(error);
        await client.query(`
          UPDATE billing_checkout_requests
          SET state=$3, last_error_code=$4, updated_at=now()
          WHERE user_id=$1 AND request_id=$2 AND state='CREATING'
        `, [userId, requestId, nextState, errorCode]).catch(() => {});
        throw new PersistentCheckoutError(
          ambiguous
            ? 'Checkout provider result is uncertain and must be reconciled.'
            : 'Checkout could not be created.',
          ambiguous ? 'BILLING_CHECKOUT_AMBIGUOUS' : 'BILLING_CHECKOUT_PROVIDER_REJECTED',
          { requestId, state: nextState },
          error,
        );
      }

      const checkoutId = requiredText(checkout?.id, 'provider checkout id');
      const checkoutUrl = normalizeProviderCheckoutUrl(checkout?.url);
      try {
        const saved = await client.query(`
          UPDATE billing_checkout_requests
          SET state='OPEN',
              provider_checkout_id=$3,
              checkout_url=$4,
              expires_at=$5,
              last_error_code=NULL,
              updated_at=now()
          WHERE user_id=$1 AND request_id=$2 AND state='CREATING'
          RETURNING *
        `, [
          userId,
          requestId,
          checkoutId,
          checkoutUrl,
          checkout?.expiresAt ? new Date(checkout.expiresAt) : null,
        ]);
        if (saved.rowCount !== 1) {
          throw new Error('checkout request state changed before provider result could be persisted');
        }
        await persistCustomerBestEffort(client, userId);
        return publicRow(saved.rows[0]);
      } catch (error) {
        throw new PersistentCheckoutError(
          'Checkout was created externally but its local persistence is uncertain.',
          'BILLING_CHECKOUT_PERSISTENCE_UNCERTAIN',
          { requestId, state: 'CREATING' },
          error,
        );
      }
    });
  }

  async function getRequest({ userId, requestId }) {
    const normalizedUserId = requiredText(userId, 'userId');
    const normalizedRequestId = requiredText(requestId, 'requestId', /^[A-Za-z0-9_-]{8,128}$/);
    const result = await pool.query(`
      SELECT *
      FROM billing_checkout_requests
      WHERE user_id=$1 AND request_id=$2
      LIMIT 1
    `, [normalizedUserId, normalizedRequestId]);
    return result.rows[0] ? publicRow(result.rows[0], { recovered: true }) : null;
  }

  return Object.freeze({
    createSession,
    getRequest,
  });
}

module.exports = {
  PROVIDER,
  PROVIDER_ENVIRONMENT,
  UNRESOLVED_STATES,
  TERMINAL_STATES,
  PersistentCheckoutError,
  checkoutRequestHash,
  providerFailureCouldHaveCreatedCheckout,
  createPersistentCheckoutService,
};
