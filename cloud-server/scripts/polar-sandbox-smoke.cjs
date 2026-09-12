'use strict';

const crypto = require('node:crypto');
const {
  ENV,
  createPolarSandboxAdapter,
} = require('../billing-polar-sandbox');

const REQUIRED_SMOKE_ENV = Object.freeze({
  userId: 'POLAR_SANDBOX_SMOKE_USER_ID',
  existingUserId: 'POLAR_SANDBOX_SMOKE_EXISTING_USER_ID',
  email: 'POLAR_SANDBOX_SMOKE_EMAIL',
  successUrl: 'POLAR_SANDBOX_SMOKE_SUCCESS_URL',
  returnUrl: 'POLAR_SANDBOX_SMOKE_RETURN_URL',
});

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for the Polar sandbox smoke.`);
  return value;
}

function signWebhook({ body, secret, webhookId, timestamp }) {
  const signedContent = `${webhookId}.${timestamp}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(signedContent).digest('base64');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  };
}

async function main() {
  const userId = requiredEnv(REQUIRED_SMOKE_ENV.userId);
  const existingUserId = requiredEnv(REQUIRED_SMOKE_ENV.existingUserId);
  const email = requiredEnv(REQUIRED_SMOKE_ENV.email);
  const successUrl = requiredEnv(REQUIRED_SMOKE_ENV.successUrl);
  const returnUrl = requiredEnv(REQUIRED_SMOKE_ENV.returnUrl);
  const webhookSecret = requiredEnv(ENV.webhookSecret);

  const adapter = createPolarSandboxAdapter();

  const paidEntry = await adapter.validateOfferMapping('paid_entry_monthly_v1');
  const highestPaid = await adapter.validateOfferMapping('highest_paid_monthly_v1');

  const checkout = await adapter.createCheckout({
    offerId: 'paid_entry_monthly_v1',
    userId,
    email,
    successUrl,
    returnUrl,
  });
  if (checkout.entitlementGranted !== false) {
    throw new Error('Checkout smoke unexpectedly granted entitlement.');
  }

  const portal = await adapter.createCustomerPortal({ userId: existingUserId, returnUrl });
  if (!portal || typeof portal.url !== 'string' || !portal.url.startsWith('http')) {
    throw new Error('Polar customer portal smoke did not return a URL.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type: 'product.created',
    timestamp: new Date().toISOString(),
    data: {},
  });
  const headers = signWebhook({
    body,
    secret: webhookSecret,
    webhookId: 'msg_beatgaler_polar_sandbox_smoke',
    timestamp,
  });
  const webhook = await adapter.verifyWebhook({ rawBody: body, headers });
  if (webhook?.type !== 'product.created') {
    throw new Error('Polar webhook signature smoke returned an unexpected event type.');
  }

  console.log(JSON.stringify({
    ok: true,
    provider: adapter.provider,
    environment: adapter.environment,
    apiVersion: adapter.apiVersion,
    sdkVersion: adapter.sdkVersion,
    validatedOffers: [paidEntry.offerId, highestPaid.offerId],
    checkoutCreated: Boolean(checkout.id),
    checkoutGrantedEntitlement: checkout.entitlementGranted,
    portalCreated: true,
    webhookSignatureVerified: true,
  }));
}

main().catch(error => {
  console.error(`[polar-sandbox-smoke] FAIL: ${error?.code || error?.name || 'ERROR'}: ${error?.message || error}`);
  process.exitCode = 1;
});
