'use strict';

const crypto = require('crypto');
const { resolveBillingAccess } = require('./billing-access-resolver');

const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ACTION_LEASE_MS = 30_000;
const DEFAULT_ACTION_RETRY_BASE_MS = 5_000;
const DEFAULT_ACTION_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_ACTION_MAX_ATTEMPTS = 12;

const SUBSCRIPTION_EVENT_TYPES = Object.freeze([
  'subscription.created',
  'subscription.updated',
  'subscription.active',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.past_due',
  'subscription.revoked',
]);

const ORDER_EVENT_TYPES = Object.freeze([
  'order.created',
  'order.updated',
  'order.paid',
  'order.refunded',
]);

class BillingLifecycleError extends Error {
  constructor(message, code = 'BILLING_LIFECYCLE_FAILED', details = null, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BillingLifecycleError';
    this.code = code;
    this.details = details;
    if (cause && this.cause == null) this.cause = cause;
  }
}

function requiredText(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new BillingLifecycleError(`${label} is required.`, 'BILLING_LIFECYCLE_INVALID_INPUT');
  return text;
}

function optionalText(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function integerMinor(value, label, { defaultValue = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (defaultValue !== null) return defaultValue;
    throw new BillingLifecycleError(`${label} is required.`, 'BILLING_LIFECYCLE_INVALID_PROVIDER_STATE');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new BillingLifecycleError(`${label} must be a non-negative integer.`, 'BILLING_LIFECYCLE_INVALID_PROVIDER_STATE');
  }
  return number;
}

function isoTime(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BillingLifecycleError(`${label} is required.`, 'BILLING_LIFECYCLE_INVALID_PROVIDER_STATE');
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new BillingLifecycleError(`${label} must be a valid timestamp.`, 'BILLING_LIFECYCLE_INVALID_PROVIDER_STATE');
  }
  return date.toISOString();
}

function eventTime(context) {
  return isoTime(context?.event?.validatedPayload?.timestamp, 'webhook timestamp', { required: true });
}

function plusMs(iso, ms) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function deterministicId(prefix, ...parts) {
  const digest = crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40);
  return `${prefix}_${digest}`;
}

function normalizeProviderStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['inactive','trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused'].includes(value)) {
    return value;
  }
  if (value === 'revoked') return 'canceled';
  return 'inactive';
}

function providerIds(record) {
  const priceId = optionalText(record?.product_price_id)
    || optionalText(record?.price_id)
    || optionalText(record?.prices?.[0]?.id)
    || optionalText(record?.items?.find(item => item?.product_price_id)?.product_price_id);
  return {
    productId: optionalText(record?.product_id) || optionalText(record?.product?.id),
    priceId,
  };
}

function mappedOffers(catalog) {
  return Object.values(catalog?.offers || {}).filter(offer => offer?.providerMapping);
}

function resolveOffer(catalog, record, label = 'provider object') {
  const ids = providerIds(record);
  const candidates = mappedOffers(catalog).filter(offer => {
    const mapping = offer.providerMapping;
    if (ids.productId && mapping.productId !== ids.productId) return false;
    if (ids.priceId && mapping.priceId !== ids.priceId) return false;
    return Boolean(ids.productId || ids.priceId);
  });
  if (candidates.length !== 1) {
    throw new BillingLifecycleError(
      `${label} does not map to exactly one BeatGaler offer.`,
      'BILLING_LIFECYCLE_OFFER_MAPPING_AMBIGUOUS',
      { productId: ids.productId, priceId: ids.priceId },
    );
  }
  return candidates[0];
}

function resolveOfferByProduct(catalog, productId, label = 'provider product') {
  const id = requiredText(productId, label);
  const candidates = mappedOffers(catalog).filter(offer => offer.providerMapping.productId === id);
  if (candidates.length !== 1) {
    throw new BillingLifecycleError(
      `${label} does not map to exactly one BeatGaler offer.`,
      'BILLING_LIFECYCLE_OFFER_MAPPING_AMBIGUOUS',
      { productId: id },
    );
  }
  return candidates[0];
}

function currentOrderPeriod(order, subscription = null) {
  const ids = providerIds(order);
  const matching = Array.isArray(order?.items)
    ? order.items.find(item => {
        if (!item?.start_timestamp || !item?.end_timestamp) return false;
        if (ids.priceId && item.product_price_id && String(item.product_price_id) !== ids.priceId) return false;
        return true;
      })
    : null;
  const periodStart = isoTime(
    matching?.start_timestamp ?? subscription?.current_period_start,
    'order period start',
  );
  const periodEnd = isoTime(
    matching?.end_timestamp ?? subscription?.current_period_end,
    'order period end',
  );
  if (periodStart && periodEnd && new Date(periodEnd) <= new Date(periodStart)) {
    throw new BillingLifecycleError('Order coverage period is invalid.', 'BILLING_LIFECYCLE_INVALID_PROVIDER_STATE');
  }
  return { periodStart, periodEnd };
}

function orderProjection(order) {
  const amountMinor = integerMinor(
    order?.net_amount ?? order?.amount ?? order?.subtotal_amount ?? order?.total_amount,
    'order amount',
    { defaultValue: 0 },
  );
  const refundedAmountMinor = integerMinor(order?.refunded_amount, 'order refunded amount', { defaultValue: 0 });
  const providerStatus = String(order?.status || '').trim().toLowerCase();
  const fullRefund = refundedAmountMinor > 0
    && (providerStatus === 'refunded' || (amountMinor > 0 && refundedAmountMinor >= amountMinor));
  let status = 'pending';
  if (fullRefund) status = 'refunded';
  else if (refundedAmountMinor > 0) status = 'partially_refunded';
  else if (order?.paid === true || providerStatus === 'paid') status = 'succeeded';
  else if (['void','canceled','cancelled'].includes(providerStatus)) status = 'void';
  else if (['failed','uncollectible'].includes(providerStatus)) status = 'failed';

  return {
    status,
    amountMinor,
    refundedAmountMinor,
    fullRefund,
    currency: String(order?.currency || '').trim().toLowerCase(),
  };
}

async function upsertCustomer(client, { provider, environment, userId, providerCustomerId }) {
  if (!providerCustomerId) return;
  await client.query(`
    INSERT INTO billing_customers(
      id,user_id,provider,provider_environment,provider_customer_id,external_id,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$2,now(),now())
    ON CONFLICT(user_id,provider,provider_environment) DO UPDATE SET
      provider_customer_id=EXCLUDED.provider_customer_id,
      external_id=EXCLUDED.external_id,
      updated_at=now()
  `, [
    deterministicId('billing_customer', provider, environment, providerCustomerId),
    userId,
    provider,
    environment,
    providerCustomerId,
  ]);
}

async function readSubscriptionForUpdate(client, userId) {
  return (await client.query(
    'SELECT * FROM billing_subscription_state WHERE user_id=$1 FOR UPDATE',
    [userId],
  )).rows[0] || null;
}

function activePaidThrough(row, atIso) {
  if (!row?.paid_through) return false;
  if (new Date(row.paid_through).getTime() <= new Date(atIso).getTime()) return false;
  if (row.access_invalidated_at && new Date(row.access_invalidated_at).getTime() <= new Date(atIso).getTime()) return false;
  return true;
}

function assertReplaceableSubscription(row, providerSubscriptionId, atIso) {
  if (!row?.provider_subscription_id || row.provider_subscription_id === providerSubscriptionId) return;
  if (activePaidThrough(row, atIso)) {
    throw new BillingLifecycleError(
      'A different paid subscription is already active for this user.',
      'BILLING_LIFECYCLE_MULTIPLE_SUBSCRIPTIONS',
      {
        existingSubscriptionId: row.provider_subscription_id,
        incomingSubscriptionId: providerSubscriptionId,
      },
    );
  }
}

function pendingPlanFromSubscription(catalog, subscription, currentRow, currentOffer) {
  if (subscription?.pending_update?.product_id) {
    const pendingOffer = resolveOfferByProduct(catalog, subscription.pending_update.product_id, 'pending subscription product');
    return {
      nextPlanId: pendingOffer.planId,
      nextInterval: pendingOffer.interval,
      nextPlanEffectiveAt: isoTime(subscription.pending_update.applies_at, 'pending update applies_at', { required: true }),
    };
  }

  if (
    currentRow?.plan_id
    && currentRow.plan_id !== 'free'
    && currentOffer?.planId
    && currentOffer.planId !== currentRow.plan_id
    && currentRow.paid_through
  ) {
    return {
      nextPlanId: currentOffer.planId,
      nextInterval: currentOffer.interval,
      nextPlanEffectiveAt: isoTime(subscription?.current_period_start, 'subscription current period start'),
    };
  }

  if (normalizeProviderStatus(subscription?.status) === 'past_due' && currentRow?.next_plan_id) {
    return {
      nextPlanId: currentRow.next_plan_id,
      nextInterval: currentRow.next_interval,
      nextPlanEffectiveAt: currentRow.next_plan_effective_at
        ? new Date(currentRow.next_plan_effective_at).toISOString()
        : null,
    };
  }

  return { nextPlanId: null, nextInterval: null, nextPlanEffectiveAt: null };
}

async function applySubscriptionSnapshot(client, context, subscription, { catalog, graceMs }) {
  const userId = requiredText(context.resolvedUserId, 'resolved billing user');
  const provider = requiredText(context.provider, 'provider');
  const environment = requiredText(context.environment, 'provider environment');
  const eventAt = eventTime(context);
  const providerSubscriptionId = requiredText(subscription?.id, 'provider subscription id');
  const providerCustomerId = optionalText(subscription?.customer_id);
  const currentOffer = resolveOffer(catalog, subscription, 'subscription');

  await upsertCustomer(client, { provider, environment, userId, providerCustomerId });
  const current = await readSubscriptionForUpdate(client, userId);
  assertReplaceableSubscription(current, providerSubscriptionId, eventAt);

  const replacing = Boolean(current?.provider_subscription_id && current.provider_subscription_id !== providerSubscriptionId);
  const status = normalizeProviderStatus(subscription?.status);
  const currentPeriodStart = isoTime(subscription?.current_period_start, 'subscription current period start');
  const currentPeriodEnd = isoTime(subscription?.current_period_end, 'subscription current period end');
  const endedAt = isoTime(subscription?.ended_at ?? subscription?.ends_at, 'subscription ended at');
  const providerPastDueAt = isoTime(subscription?.past_due_at, 'subscription past_due_at');

  let planId = current?.plan_id || currentOffer.planId;
  if (!current || replacing || (!current.paid_through && current.plan_id === 'free')) {
    planId = currentOffer.planId;
  }

  let pastDueAt = current?.past_due_at ? new Date(current.past_due_at).toISOString() : null;
  let graceUntil = current?.grace_until ? new Date(current.grace_until).toISOString() : null;
  if (status === 'past_due') {
    if (!pastDueAt) pastDueAt = providerPastDueAt || eventAt;
    const hasPreviouslyPaidTier = planId !== 'free' && Boolean(current?.paid_through);
    if (hasPreviouslyPaidTier && !graceUntil) graceUntil = plusMs(pastDueAt, graceMs);
  }

  const pending = pendingPlanFromSubscription(catalog, subscription, current, currentOffer);
  let invalidatedAt = current?.access_invalidated_at ? new Date(current.access_invalidated_at).toISOString() : null;
  let invalidationReason = current?.invalidation_reason || null;
  if (context.event.eventType === 'subscription.revoked') {
    invalidatedAt = invalidatedAt || eventAt;
    invalidationReason = invalidationReason || 'PROVIDER_SUBSCRIPTION_REVOKED';
    pastDueAt = null;
    graceUntil = null;
  }

  const params = [
    userId, provider, environment, providerCustomerId, providerSubscriptionId,
    currentOffer.id, currentOffer.planId === planId ? currentOffer.providerMapping?.productId : optionalText(subscription?.product_id),
    optionalText(subscription?.price_id) || optionalText(subscription?.prices?.[0]?.id),
    planId, status, Boolean(subscription?.cancel_at_period_end),
    currentPeriodStart, currentPeriodEnd, pastDueAt, graceUntil, endedAt,
    pending.nextPlanId, pending.nextInterval, pending.nextPlanEffectiveAt,
    invalidatedAt, invalidationReason,
  ];

  await client.query(`
    INSERT INTO billing_subscription_state(
      user_id,provider,provider_environment,provider_customer_id,provider_subscription_id,
      offer_id,provider_product_id,provider_price_id,plan_id,status,cancel_at_period_end,
      current_period_start,current_period_end,paid_through,past_due_at,grace_until,ended_at,
      next_plan_id,next_interval,next_plan_effective_at,access_invalidated_at,invalidation_reason,
      last_synced_at,local_version,updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
      $12,$13,NULL,$14,$15,$16,$17,$18,$19,$20,$21,
      now(),1,now()
    )
    ON CONFLICT(user_id) DO UPDATE SET
      provider=EXCLUDED.provider,
      provider_environment=EXCLUDED.provider_environment,
      provider_customer_id=EXCLUDED.provider_customer_id,
      provider_subscription_id=EXCLUDED.provider_subscription_id,
      offer_id=EXCLUDED.offer_id,
      provider_product_id=EXCLUDED.provider_product_id,
      provider_price_id=EXCLUDED.provider_price_id,
      plan_id=EXCLUDED.plan_id,
      status=EXCLUDED.status,
      cancel_at_period_end=EXCLUDED.cancel_at_period_end,
      current_period_start=EXCLUDED.current_period_start,
      current_period_end=EXCLUDED.current_period_end,
      past_due_at=EXCLUDED.past_due_at,
      grace_until=EXCLUDED.grace_until,
      ended_at=EXCLUDED.ended_at,
      next_plan_id=EXCLUDED.next_plan_id,
      next_interval=EXCLUDED.next_interval,
      next_plan_effective_at=EXCLUDED.next_plan_effective_at,
      access_invalidated_at=EXCLUDED.access_invalidated_at,
      invalidation_reason=EXCLUDED.invalidation_reason,
      last_synced_at=now(),
      local_version=billing_subscription_state.local_version+1,
      updated_at=now()
  `, params);
}

async function upsertOrderProjection(client, context, order, subscription, { catalog }) {
  const userId = requiredText(context.resolvedUserId, 'resolved billing user');
  const provider = requiredText(context.provider, 'provider');
  const environment = requiredText(context.environment, 'provider environment');
  const eventAt = eventTime(context);
  const providerOrderId = requiredText(order?.id, 'provider order id');
  const providerCustomerId = optionalText(order?.customer_id);
  const providerSubscriptionId = optionalText(order?.subscription_id);
  const providerCheckoutId = optionalText(order?.checkout_id);

  if (!providerSubscriptionId) {
    throw new BillingLifecycleError(
      'A recurring billing order must reference a subscription.',
      'BILLING_LIFECYCLE_SUBSCRIPTION_REQUIRED',
    );
  }
  if (String(order?.billing_reason || '') === 'subscription_update') {
    throw new BillingLifecycleError(
      'Immediate provider proration is outside Billing V1.',
      'BILLING_LIFECYCLE_UNEXPECTED_PRORATION',
    );
  }

  const offer = resolveOffer(catalog, order, 'order');
  const projection = orderProjection(order);
  const { periodStart, periodEnd } = currentOrderPeriod(order, subscription);
  if ((projection.status === 'succeeded' || projection.status === 'partially_refunded') && !periodEnd) {
    throw new BillingLifecycleError(
      'Confirmed recurring payment lacks a coverage end.',
      'BILLING_LIFECYCLE_MISSING_PAID_COVERAGE',
    );
  }
  if (!/^[a-z]{3}$/.test(projection.currency)) {
    throw new BillingLifecycleError('Order currency is invalid.', 'BILLING_LIFECYCLE_INVALID_PROVIDER_STATE');
  }

  await upsertCustomer(client, { provider, environment, userId, providerCustomerId });
  const current = await readSubscriptionForUpdate(client, userId);
  assertReplaceableSubscription(current, providerSubscriptionId, eventAt);

  const existingPayment = (await client.query(`
    SELECT * FROM billing_payments
    WHERE provider=$1 AND provider_environment=$2 AND provider_order_id=$3
    FOR UPDATE
  `, [provider, environment, providerOrderId])).rows[0] || null;

  const invalidatedAt = projection.fullRefund
    ? (existingPayment?.invalidated_at ? new Date(existingPayment.invalidated_at).toISOString() : eventAt)
    : null;
  const invalidationReason = projection.fullRefund ? 'FULL_REFUND' : null;
  const paymentId = existingPayment?.id || deterministicId('billing_order', provider, environment, providerOrderId);

  if (existingPayment) {
    await client.query(`
      UPDATE billing_payments SET
        provider_payment_id=$4,
        provider_invoice_id=$5,
        user_id=$6,
        provider_subscription_id=$7,
        offer_id=$8,
        period_start=$9,
        period_end=$10,
        amount_minor=$11,
        currency=$12,
        status=$13,
        refunded_amount_minor=$14,
        invalidated_at=$15,
        invalidation_reason=$16,
        updated_at=now()
      WHERE provider=$1 AND provider_environment=$2 AND provider_order_id=$3
    `, [
      provider, environment, providerOrderId,
      optionalText(order?.payment_id), optionalText(order?.invoice_number), userId, providerSubscriptionId,
      offer.id, periodStart, periodEnd, projection.amountMinor, projection.currency, projection.status,
      projection.refundedAmountMinor, invalidatedAt, invalidationReason,
    ]);
  } else {
    await client.query(`
      INSERT INTO billing_payments(
        id,provider,provider_environment,provider_payment_id,provider_order_id,provider_invoice_id,
        user_id,provider_subscription_id,offer_id,period_start,period_end,
        amount_minor,currency,status,refunded_amount_minor,invalidated_at,invalidation_reason,
        created_at,updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now()
      )
    `, [
      paymentId, provider, environment, optionalText(order?.payment_id), providerOrderId,
      optionalText(order?.invoice_number), userId, providerSubscriptionId, offer.id,
      periodStart, periodEnd, projection.amountMinor, projection.currency, projection.status,
      projection.refundedAmountMinor, invalidatedAt, invalidationReason,
    ]);
  }

  if (providerCheckoutId && ['succeeded','partially_refunded','refunded'].includes(projection.status)) {
    await client.query(`
      UPDATE billing_checkout_requests
      SET state='COMPLETED',
          completed_at=COALESCE(completed_at,now()),
          updated_at=now(),
          last_error_code=NULL
      WHERE provider=$1 AND provider_environment=$2 AND provider_checkout_id=$3
        AND user_id=$4
        AND state IN ('CREATING','OPEN','AMBIGUOUS','COMPLETED')
    `, [provider, environment, providerCheckoutId, userId]);
  }

  if (projection.status === 'succeeded' || projection.status === 'partially_refunded') {
    const currentPaidThroughMs = current?.paid_through ? new Date(current.paid_through).getTime() : -1;
    const incomingPaidThroughMs = periodEnd ? new Date(periodEnd).getTime() : -1;
    const replacing = Boolean(current?.provider_subscription_id && current.provider_subscription_id !== providerSubscriptionId);
    const shouldAdvance = replacing || !current || incomingPaidThroughMs >= currentPaidThroughMs;

    if (shouldAdvance) {
      const subStatus = normalizeProviderStatus(subscription?.status || 'active');
      const subPeriodStart = isoTime(subscription?.current_period_start, 'subscription current period start') || periodStart;
      const subPeriodEnd = isoTime(subscription?.current_period_end, 'subscription current period end') || periodEnd;
      // A late update/replay of the already paid Order must not consume a change
      // scheduled for coverage that this Order has not paid for. The fresh provider
      // subscription is authoritative; an applied or canceled pending update clears it.
      const pending = subscription?.pending_update?.product_id
        && new Date(subscription.pending_update.applies_at).getTime() >= incomingPaidThroughMs
        ? pendingPlanFromSubscription(catalog, subscription, null, offer)
        : { nextPlanId: null, nextInterval: null, nextPlanEffectiveAt: null };
      await client.query(`
        INSERT INTO billing_subscription_state(
          user_id,provider,provider_environment,provider_customer_id,provider_subscription_id,
          offer_id,provider_product_id,provider_price_id,plan_id,status,cancel_at_period_end,
          current_period_start,current_period_end,paid_through,past_due_at,grace_until,ended_at,
          next_plan_id,next_interval,next_plan_effective_at,access_invalidated_at,invalidation_reason,
          last_synced_at,local_version,updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,NULL,$15,
          $16,$17,$18,NULL,NULL,now(),1,now()
        )
        ON CONFLICT(user_id) DO UPDATE SET
          provider=EXCLUDED.provider,
          provider_environment=EXCLUDED.provider_environment,
          provider_customer_id=EXCLUDED.provider_customer_id,
          provider_subscription_id=EXCLUDED.provider_subscription_id,
          offer_id=EXCLUDED.offer_id,
          provider_product_id=EXCLUDED.provider_product_id,
          provider_price_id=EXCLUDED.provider_price_id,
          plan_id=EXCLUDED.plan_id,
          status=EXCLUDED.status,
          cancel_at_period_end=EXCLUDED.cancel_at_period_end,
          current_period_start=EXCLUDED.current_period_start,
          current_period_end=EXCLUDED.current_period_end,
          paid_through=EXCLUDED.paid_through,
          past_due_at=NULL,
          grace_until=NULL,
          ended_at=EXCLUDED.ended_at,
          next_plan_id=EXCLUDED.next_plan_id,
          next_interval=EXCLUDED.next_interval,
          next_plan_effective_at=EXCLUDED.next_plan_effective_at,
          access_invalidated_at=NULL,
          invalidation_reason=NULL,
          last_synced_at=now(),
          local_version=billing_subscription_state.local_version+1,
          updated_at=now()
      `, [
        userId, provider, environment, providerCustomerId, providerSubscriptionId,
        offer.id, offer.providerMapping.productId, offer.providerMapping.priceId,
        offer.planId, subStatus, Boolean(subscription?.cancel_at_period_end),
        subPeriodStart || periodStart, subPeriodEnd || periodEnd, periodEnd,
        isoTime(subscription?.ended_at ?? subscription?.ends_at, 'subscription ended at'),
        pending.nextPlanId, pending.nextInterval, pending.nextPlanEffectiveAt,
      ]);
    }
  }

  if (projection.fullRefund && current?.provider_subscription_id === providerSubscriptionId) {
    const currentPaidThroughMs = current?.paid_through ? new Date(current.paid_through).getTime() : -1;
    const refundPeriodEndMs = periodEnd ? new Date(periodEnd).getTime() : -1;
    const currentCoverageInvalidated = refundPeriodEndMs >= currentPaidThroughMs && currentPaidThroughMs > -1;

    if (currentCoverageInvalidated) {
      await client.query(`
        UPDATE billing_subscription_state
        SET access_invalidated_at=COALESCE(access_invalidated_at,$2),
            invalidation_reason=COALESCE(invalidation_reason,'FULL_REFUND_CURRENT_PERIOD'),
            past_due_at=NULL,
            grace_until=NULL,
            last_synced_at=now(),
            local_version=local_version+1,
            updated_at=now()
        WHERE user_id=$1
      `, [userId, eventAt]);

      await client.query(`
        INSERT INTO billing_provider_actions(
          id,user_id,provider,provider_environment,action_type,provider_subscription_id,
          idempotency_key,state,attempt_count,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,'REVOKE_SUBSCRIPTION',$5,$6,'PENDING',0,now(),now())
        ON CONFLICT(provider,provider_environment,action_type,provider_subscription_id) DO NOTHING
      `, [
        deterministicId('billing_action', provider, environment, 'REVOKE_SUBSCRIPTION', providerSubscriptionId),
        userId, provider, environment, providerSubscriptionId,
        `refund-revoke:${provider}:${environment}:${providerSubscriptionId}`,
      ]);
    }
  }

  return { offer, projection, periodStart, periodEnd };
}

function createBillingLifecycle({ adapter, graceMs = DEFAULT_GRACE_MS } = {}) {
  if (!adapter || typeof adapter.getSubscription !== 'function' || typeof adapter.getOrder !== 'function') {
    throw new BillingLifecycleError(
      'Billing lifecycle requires provider subscription and order lookups.',
      'BILLING_LIFECYCLE_CONFIG_INVALID',
    );
  }
  if (!adapter.catalog?.offers) {
    throw new BillingLifecycleError('Billing lifecycle requires a commercial catalog.', 'BILLING_LIFECYCLE_CONFIG_INVALID');
  }
  if (!Number.isInteger(graceMs) || graceMs <= 0) {
    throw new BillingLifecycleError('graceMs must be a positive integer.', 'BILLING_LIFECYCLE_CONFIG_INVALID');
  }

  const provider = requiredText(adapter.provider, 'provider');
  const environment = requiredText(adapter.environment, 'provider environment');
  const catalog = adapter.catalog;

  const subscriptionHandler = Object.freeze({
    async prepare(context) {
      return adapter.getSubscription(requiredText(context.event.subjectId, 'subscription subject id'));
    },
    async apply(client, context, prepared) {
      return applySubscriptionSnapshot(client, context, prepared, { catalog, graceMs });
    },
  });

  const orderHandler = Object.freeze({
    async prepare(context) {
      const order = await adapter.getOrder(requiredText(context.event.subjectId, 'order subject id'));
      const subscription = order?.subscription_id
        ? await adapter.getSubscription(String(order.subscription_id))
        : null;
      return Object.freeze({ order, subscription });
    },
    async apply(client, context, prepared) {
      return upsertOrderProjection(client, context, prepared.order, prepared.subscription, { catalog });
    },
  });

  const handlers = {};
  for (const type of SUBSCRIPTION_EVENT_TYPES) handlers[type] = subscriptionHandler;
  for (const type of ORDER_EVENT_TYPES) handlers[type] = orderHandler;

  async function resolveUserAccess(client, userId, now) {
    const subscription = (await client.query(
      'SELECT * FROM billing_subscription_state WHERE user_id=$1',
      [requiredText(userId, 'userId')],
    )).rows[0] || null;
    const grants = (await client.query(`
      SELECT * FROM entitlements WHERE user_id=$1 ORDER BY starts_at,id
    `, [userId])).rows;
    return resolveBillingAccess({ subscription, grants, now });
  }

  return Object.freeze({
    provider,
    environment,
    graceMs,
    handlers: Object.freeze(handlers),
    resolveUserAccess,
  });
}

function actionRetryDelay(attemptCount, baseMs, maxMs) {
  const exponent = Math.max(0, Number(attemptCount || 1) - 1);
  return Math.min(maxMs, baseMs * (2 ** Math.min(exponent, 20)));
}

function createBillingProviderActionWorker({
  pool,
  adapter,
  leaseMs = DEFAULT_ACTION_LEASE_MS,
  retryBaseMs = DEFAULT_ACTION_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_ACTION_RETRY_MAX_MS,
  maxAttempts = DEFAULT_ACTION_MAX_ATTEMPTS,
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new BillingLifecycleError('PostgreSQL pool is required.', 'BILLING_ACTION_CONFIG_INVALID');
  }
  if (!adapter || typeof adapter.revokeSubscription !== 'function') {
    throw new BillingLifecycleError('Provider revoke primitive is required.', 'BILLING_ACTION_CONFIG_INVALID');
  }
  for (const [label, value] of Object.entries({ leaseMs, retryBaseMs, retryMaxMs, maxAttempts })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new BillingLifecycleError(`${label} must be a positive integer.`, 'BILLING_ACTION_CONFIG_INVALID');
    }
  }

  const provider = requiredText(adapter.provider, 'adapter provider');
  const environment = requiredText(adapter.environment, 'adapter environment');

  async function claimNext(workerId) {
    const owner = requiredText(workerId, 'workerId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const candidate = (await client.query(`
        SELECT * FROM billing_provider_actions
        WHERE provider=$1 AND provider_environment=$2
          AND (
            state='PENDING'
            OR (state='FAILED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
            OR (state='PROCESSING' AND processing_lease_until <= now())
          )
        ORDER BY created_at,id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `, [provider, environment])).rows[0];
      if (!candidate) {
        await client.query('COMMIT');
        return null;
      }
      const claimed = (await client.query(`
        UPDATE billing_provider_actions
        SET state='PROCESSING',
            attempt_count=attempt_count+1,
            processing_lease_owner=$2,
            processing_lease_until=now()+($3 * interval '1 millisecond'),
            next_attempt_at=NULL,
            last_error_code=NULL,
            updated_at=now()
        WHERE id=$1
        RETURNING *
      `, [candidate.id, owner, leaseMs])).rows[0];
      await client.query('COMMIT');
      return claimed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function processNext({ workerId } = {}) {
    const owner = requiredText(workerId, 'workerId');
    const action = await claimNext(owner);
    if (!action) return null;

    try {
      if (action.action_type !== 'REVOKE_SUBSCRIPTION') {
        throw new BillingLifecycleError('Unknown provider action.', 'BILLING_ACTION_UNKNOWN');
      }
      await adapter.revokeSubscription({ subscriptionId: action.provider_subscription_id });
      return (await pool.query(`
        UPDATE billing_provider_actions
        SET state='SUCCEEDED',
            succeeded_at=now(),
            processing_lease_owner=NULL,
            processing_lease_until=NULL,
            next_attempt_at=NULL,
            last_error_code=NULL,
            updated_at=now()
        WHERE id=$1 AND state='PROCESSING' AND processing_lease_owner=$2
        RETURNING *
      `, [action.id, owner])).rows[0] || null;
    } catch (error) {
      const canRetry = Number(action.attempt_count) < maxAttempts;
      const retryMs = canRetry ? actionRetryDelay(action.attempt_count, retryBaseMs, retryMaxMs) : null;
      const code = /^[A-Z0-9_:-]{1,128}$/.test(String(error?.code || '').toUpperCase())
        ? String(error.code).toUpperCase()
        : 'BILLING_PROVIDER_ACTION_FAILED';
      await pool.query(`
        UPDATE billing_provider_actions
        SET state='FAILED',
            processing_lease_owner=NULL,
            processing_lease_until=NULL,
            next_attempt_at=CASE WHEN $3::bigint IS NULL THEN NULL ELSE now()+($3 * interval '1 millisecond') END,
            last_error_code=$4,
            updated_at=now()
        WHERE id=$1 AND state='PROCESSING' AND processing_lease_owner=$2
      `, [action.id, owner, retryMs, code]);
      throw error;
    }
  }

  return Object.freeze({ provider, environment, claimNext, processNext });
}

module.exports = {
  DEFAULT_GRACE_MS,
  DEFAULT_ACTION_LEASE_MS,
  DEFAULT_ACTION_RETRY_BASE_MS,
  DEFAULT_ACTION_RETRY_MAX_MS,
  DEFAULT_ACTION_MAX_ATTEMPTS,
  SUBSCRIPTION_EVENT_TYPES,
  ORDER_EVENT_TYPES,
  BillingLifecycleError,
  resolveOffer,
  orderProjection,
  createBillingLifecycle,
  createBillingProviderActionWorker,
};
