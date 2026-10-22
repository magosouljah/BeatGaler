"use strict";

require('dotenv').config({ quiet: true });
const express = require("express");
const { installLegacyMediaUploadDisable } = require("./legacy-media-upload-disable");
const { installHttpContainment } = require("./http-containment");
const { installDirectCapabilityBoundary } = require("./direct-capability-boundary");
const { installSensitiveAuthCapabilityRevocation } = require("./sensitive-auth-capability-revocation");
const { installSessionSecurity } = require("./session-security");
const { installAccountLifecycle } = require("./account-lifecycle");
const { installAuthPublicRegistrationHardening } = require("./auth-public-registration-hardening");
const { installSensitiveAuthContainment } = require("./sensitive-auth-containment");
const { installDurableAuthAbuseControls } = require("./auth-durable-abuse-controls");
const { createPendingSignupRuntime } = require("./pending-signup-runtime");
const { createPendingSignupService } = require("./pending-signup-service");
const { installPendingSignupBoundary } = require("./pending-signup-boundary");
const { createSignupActivationCoordinator } = require("./signup-activation-coordinator");
const { installServerCoreAuthBridgeLoader, getServerCoreAuthBridge } = require("./server-core-auth-bridge-loader");
const { createProviderIdentityAuthority } = require("./provider-identity-authority");
const { createAuthDeliveryWorker } = require("./auth-delivery-worker");
const { createStagedEmailChange, createStagedEmailChangeNoticeWorker } = require("./staged-email-change");
const { installStagedEmailChangeRoutes } = require("./staged-email-change-routes");
const { resolveSecretEnvelopeKeyring } = require("./secret-envelope-provider");
const { installLifecyclePasswordAuthority } = require("./account-lifecycle-password-authority");
const { installLifecycleRequestGuard } = require("./account-lifecycle-request-guard");
const { createSesEmailNotifier } = require("./account-email-ses");
const { applyD8RoResolutions, d8LifecycleEnv } = require("./d8-ro-resolutions");
const { installProductiveTempAuthBoundary } = require("./productive-temp-auth-boundary");
const { installSecurityHeaders } = require("./security-headers");
const { installAuthAbuseControls } = require("./auth-abuse-controls");
const { postgresConfig } = require("./postgres-runtime-config");
const { startPostgresControlPlane, installPostgresShutdown } = require("./postgres-bootstrap");
const { prepareControlPlaneCutover } = require("./control-plane-cutover-runtime");
const accessGrants = require("./access-grant-runtime");
const accessRuntime = require("./access-runtime");
const webBillingRuntime = require("./billing-web-runtime");
const webCheckoutRuntime = require("./billing-web-checkout-runtime");
const webPortalRuntime = require("./billing-web-portal-runtime");
const webhookRuntime = require("./billing-webhook-runtime");
const lifecycleRuntime = require("./billing-lifecycle-runtime");
const reconciliationRuntime = require("./billing-reconciliation-runtime");
const { createPostgresInstallationClaimCoordinator } = require("./postgres-installation-claim-coordinator");
const { installRuntimeOperability, configureRuntimeDependencies } = require("./runtime-operability");
const { operationsRuntime } = require('./operations-runtime');
const directPersistentAssignments = require("./direct-persistent-assignment-runtime");
const { installPersistentDirectSessionStart } = require("./direct-persistent-session-runtime");
const { installPersistentDirectMembershipActivation } = require("./direct-persistent-membership-runtime");
const { installAtomicLibraryIndexBootstrap } = require("./atomic-library-index");
const { installStartupRoutingIndex } = require("./startup-routing-index");
const vaultIndexPointers = require("./vault-index-pointer-store");
const libraryIndexPublication = require("./library-index-publication");
const { createDirectIndexPinAuthority } = require("./direct-index-pin-authority");

installRuntimeOperability(express);
installSecurityHeaders(express);
installLegacyMediaUploadDisable(express);

async function start() {
  const pgConfig = postgresConfig(process.env);
  let pool = null;
  let authDeliveryWorker = null;
  let emailChangeNoticeWorker = null;

  if (pgConfig.enabled) {
    const started = await startPostgresControlPlane({
      onMigrationError: () => operationsRuntime.recordCondition('migration_failure'),
    });
    pool = started.pool;
    installPostgresShutdown(pool, process, { beforeClose: async () => {
      authDeliveryWorker?.stop?.();
      emailChangeNoticeWorker?.stop?.();
      await Promise.all([lifecycleRuntime.stop(), reconciliationRuntime.stop()]);
    } });
  }
  configureRuntimeDependencies({ pool, postgresRequired: pgConfig.enabled });
  directPersistentAssignments.configure({ pool });
  vaultIndexPointers.configure({ pool });

  const cutover = await prepareControlPlaneCutover({ pool, env: process.env });
  libraryIndexPublication.configure({ pool: cutover.authority === 'postgres' ? pool : null, transport: require('./direct-transport-control') });
  const indexPinAuthority = cutover.authority === 'postgres'
    ? createDirectIndexPinAuthority({ pool, transport: require('./direct-transport-control') }) : null;
  if (indexPinAuthority) {
    await indexPinAuthority.ensureAll();
    await libraryIndexPublication.recoverAll();
  }
  accessGrants.configure({ pool: cutover.authority === 'postgres' ? pool : null, authRuntime: cutover.runtime });
  accessRuntime.configure({ pool: cutover.authority === 'postgres' ? pool : null });
  if (cutover.authority === 'postgres') {
    const billing = await webBillingRuntime.configure({ env: process.env });
    console.log(`[billing] ${process.env.BILLING_PROVIDER_ENVIRONMENT || 'unconfigured'} sale=${billing.ready ? 'ready' : 'unavailable'} code=${billing.failureCode || 'OK'}`);
    const checkout = webCheckoutRuntime.configure({
      pool,
      adapter: billing.ready ? webBillingRuntime.provider() : null,
      env: process.env,
    });
    console.log(`[billing] web checkout=${checkout.ready ? 'ready' : 'unavailable'} code=${checkout.failureCode || 'OK'}`);
    const portal = webPortalRuntime.configure({
      pool,
      adapter: billing.ready ? webBillingRuntime.provider() : null,
      env: process.env,
    });
    console.log(`[billing] web portal=${portal.ready ? 'ready' : 'unavailable'} code=${portal.failureCode || 'OK'}`);
    const webhook = webhookRuntime.configure({
      pool,
      adapter: billing.ready ? webBillingRuntime.provider() : null,
      env: process.env,
    });
    console.log(`[billing] webhook inbox=${webhook.ready ? 'ready' : 'unavailable'} code=${webhook.failureCode || 'OK'}`);
    const lifecycle = lifecycleRuntime.configure({
      pool,
      adapter: billing.ready && webhook.ready ? webBillingRuntime.provider() : null,
      inbox: webhook.ready ? webhookRuntime.current() : null,
      onError: (area, code) => console.error(`[billing] lifecycle ${area} code=${code}`),
    });
    console.log(`[billing] lifecycle=${lifecycle.ready ? 'ready' : 'unavailable'} code=${lifecycle.failureCode || 'OK'}`);
    const reconciliation = reconciliationRuntime.configure({
      pool, authority: cutover.authority,
      adapter: billing.ready ? webBillingRuntime.provider() : null,
      onError: () => operationsRuntime.recordCondition('billing_reconciliation_exception'),
      onBacklog: () => operationsRuntime.recordCondition('queue_backlog'),
    });
    console.log(`[billing] reconciliation=${reconciliation.ready ? 'ready' : 'unavailable'} code=${reconciliation.failureCode || 'OK'}`);
    if (!billing.ready || !checkout.ready || !portal.ready || !webhook.ready || !lifecycle.ready || !reconciliation.ready) {
      operationsRuntime.recordCondition('provider_failure');
    }
  }
  const installationClaimCoordinator = pool ? createPostgresInstallationClaimCoordinator(pool) : null;
  if (String(process.env.NODE_ENV || "") === "production" && !installationClaimCoordinator) {
    throw new Error("Production authorization requires PostgreSQL cross-process installation claim coordination.");
  }
  const providerIdentityAuthority = pool && cutover.authority === 'postgres'
    ? createProviderIdentityAuthority({ pool, getBridge: getServerCoreAuthBridge, flushAuthority: () => cutover.runtime.flush() })
    : null;

  const accountEmailNotifier = createSesEmailNotifier({ env: process.env });
  let pendingSignupService = null;
  let pendingSignupActivation = null;
  const pendingSignupEnabled = String(process.env.BEATGALER_PENDING_SIGNUP_ENABLED || '') === '1';
  if (pendingSignupEnabled) {
    if (!pool || cutover.authority !== 'postgres' || typeof cutover.runtime?.flush !== 'function') {
      throw new Error('BEATGALER_PENDING_SIGNUP_ENABLED=1 requires PostgreSQL control-plane authority.');
    }
    const keyring = await resolveSecretEnvelopeKeyring(process.env);
    const pendingRuntime = createPendingSignupRuntime({ pool, keyring, env: process.env });
    pendingSignupService = createPendingSignupService({ pool, runtime: pendingRuntime, env: process.env });
    await pendingSignupService.recoverStaleActivations();
    authDeliveryWorker = createAuthDeliveryWorker({
      service: pendingSignupService,
      emailNotifier: accountEmailNotifier,
    });
  }

  let directCapabilities = null;
  // Install these boundaries before lifecycle/containment wrappers so a public
  // register request can never fall through to the legacy create+provision path.
  installAuthPublicRegistrationHardening(express, {
    env: process.env,
    getAccountLifecycle: () => express.application.__beatgalerAccountLifecycleRuntime || null,
    getProviderIdentityAuthority: () => providerIdentityAuthority,
    getAuthPool: () => cutover.authority === 'postgres' ? pool : null,
  });
  installPendingSignupBoundary(express, {
    service: pendingSignupService,
    env: process.env,
    activation: input => {
      if (!pendingSignupActivation) {
        const error = new Error('Pending signup activation is unavailable.');
        error.code = 'SIGNUP_ACTIVATION_UNAVAILABLE';
        throw error;
      }
      return pendingSignupActivation.activate(input);
    },
  });
  const accountLifecycle = installAccountLifecycle(express, {
    dataDir: __dirname,
    env: d8LifecycleEnv(process.env),
    emailNotifier: accountEmailNotifier,
    pool: cutover.authority === 'postgres' ? pool : null,
    getCapabilityStore: () => directCapabilities?.store || null,
    onEmailVerified: userId => accessGrants.issueWelcomeAfterActivation(userId),
  });
  installLifecyclePasswordAuthority(accountLifecycle);

  if (pool && cutover.authority === 'postgres') {
    const stagedEmailChange = createStagedEmailChange({
      pool,
      runtime: accountLifecycle,
      emailNotifier: accountEmailNotifier,
      commitLocalEmail: async (userId, email, authoritativeUser) => {
        const bridge = getServerCoreAuthBridge();
        if (!bridge?.adoptIdentityUser) {
          const error = new Error('Local auth identity bridge is unavailable.');
          error.code = 'EMAIL_CHANGE_LOCAL_COMMIT_UNAVAILABLE';
          throw error;
        }
        bridge.adoptIdentityUser({
          id: String(userId),
          username: authoritativeUser?.username,
          usernameSource: authoritativeUser?.username_source || 'beatgaler',
          email,
        });
      },
      flushAuthority: () => cutover.runtime.flush(),
      env: process.env,
    });
    installStagedEmailChangeRoutes(express, stagedEmailChange);
    emailChangeNoticeWorker = createStagedEmailChangeNoticeWorker(stagedEmailChange, {
      onError: error => console.error('[auth] email-change notice retry failed:', error?.message || String(error)),
    });
  }

  // Sensitive legacy mutations are contained before provider reauth wraps the
  // OAuth routes, so purpose=reauth can still reach the D8 coordinator.
  installSensitiveAuthContainment(express, accountLifecycle, { pool: cutover.authority === 'postgres' ? pool : null });
  applyD8RoResolutions(express, accountLifecycle, { env: process.env });
  installSessionSecurity(express, {
    dataDir: __dirname,
    pool: cutover.authority === 'postgres' ? pool : null,
    getCapabilityStore: () => directCapabilities?.store || null,
  });
  installLifecycleRequestGuard(express, accountLifecycle);
  installHttpContainment(express, { dataDir: __dirname, installationClaimCoordinator });
  directCapabilities = installDirectCapabilityBoundary(express, { dataDir: __dirname, pool });
  installSensitiveAuthCapabilityRevocation(express, { store: directCapabilities?.store });
  // PostgreSQL is mandatory in production. These shared buckets therefore
  // coordinate auth abuse controls across every production process/restart;
  // the existing in-memory layer remains as an additional low-latency guard.
  installDurableAuthAbuseControls(express, { pool, runtime: accountLifecycle, env: process.env });
  installAuthAbuseControls(express);
  installProductiveTempAuthBoundary(express);
  installAtomicLibraryIndexBootstrap(express);
  installStartupRoutingIndex(express, { pool, dataDir: __dirname });
  console.log(`[control-plane] authority=${cutover.authority} claim-coordinator=${installationClaimCoordinator ? "postgres" : "process-local-dev"} direct-capabilities=${pool ? "postgres" : "process-local-dev"} pending-signup=${pendingSignupEnabled ? 'configured' : 'disabled'}`);

  // Install a one-shot loader only for server-core so activation can reuse its
  // in-process user/storage/session primitives without adding internal routes.
  const restoreCoreAuthBridgeLoader = pendingSignupEnabled ? installServerCoreAuthBridgeLoader() : () => {};
  try {
    // Keep this literal require: regression tooling verifies contained core boot order.
    require("./server-core");
  } finally {
    restoreCoreAuthBridgeLoader();
  }

  if (pendingSignupEnabled) {
    if (!getServerCoreAuthBridge()) throw new Error('Pending signup activation bridge was not installed into server-core.');
    pendingSignupActivation = createSignupActivationCoordinator({
      pool,
      service: pendingSignupService,
      getBridge: getServerCoreAuthBridge,
      flushAuthority: () => cutover.runtime.flush(),
      issueWelcome: userId => accessGrants.issueWelcomeAfterActivation(userId),
      installationClaimCoordinator,
      staleMs: Number(process.env.BEATGALER_SIGNUP_ACTIVATION_STALE_MS || 5 * 60_000),
    });
  }

  const directTransport = require("./direct-transport-control");
  installPersistentDirectSessionStart({
    directTransport,
    persistentAssignments: directPersistentAssignments,
    indexPinAuthority,
  });
  installPersistentDirectMembershipActivation({
    directTransport,
    persistentAssignments: directPersistentAssignments,
  });
  lifecycleRuntime.start();
  reconciliationRuntime.start();
  authDeliveryWorker?.start?.();
  emailChangeNoticeWorker?.start?.();
}

start().catch((error) => {
  console.error("[control-plane] startup failed; cloud-server will not start:", error?.message || String(error));
  process.exitCode = 1;
});
