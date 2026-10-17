# Gates: Web subscriber management

Scope: Let authenticated existing subscribers open the validated Polar customer portal for changes/cancellation without exposing arbitrary destinations or granting access on redirect.

- [x] P1: Add a session-authenticated, CSRF-protected route that resolves the current user's existing subscription/customer and creates a portal URL with a server-controlled return origin.
  EVIDENCE: `server-core.js` registers GET `/billing/portal/availability` and POST `/billing/portal`; `server.js` configures the portal only with the validated provider and PostgreSQL pool. `session-security.js` guards cookie-authenticated non-safe methods with CSRF. `billing-web-portal-route.js` queries subscription by authenticated `user.id` and provider/environment, verifies the provider customer by external user ID, rejects client parameters, validates the exact Polar host and HTTPS, returns no access grant, and derives `/?billing=portal-return` from the server-validated canonical Web origin. Local route tests passed 6/6; no live provider was called.
  SOURCE: [Polar Create Customer Session API](https://polar.sh/docs/api-reference/customer-portal/sessions/create) documents a server-created session and `customer_portal_url` response.
- [x] P2: Add a Web Settings action only when subscriber management is available, preserving truthful current Access and no grant from a portal return URL.
  EVIDENCE: `SettingsPanel.tsx` shows Manage subscription only after authenticated availability and an existing subscriber state; it retains `/plans/me` as the current-plan source. Portal return only refreshes Account/Access, strips the query, and makes no entitlement mutation. `billingPortalSettings.test.tsx` passed 2/2 in WSL.
- [x] P3: Cover tenant isolation, no subscription, provider failure, URL safety, and successful portal creation with focused tests.
  EVIDENCE: `node cloud-server/tests/billing-web-portal-route.test.cjs` in WSL passed 6/6, including tenant-scoped SQL parameters, absent/ended subscription, customer mismatch, provider exception, arbitrary return parameter, unsafe URLs, canonical return, and no grant. UI test passed 2/2.
- [x] P4: Run affected typecheck, build, server and UI tests; record remaining live-provider/human gate.
  EVIDENCE: `node node_modules/typescript/bin/tsc --noEmit` passed; `node --check cloud-server/server.js` and `server-core.js` passed; `npm run build:web` in WSL passed (909 modules). New portal UI test passed 2/2. Root isolated portal availability in the existing Settings mock and reran `billingSettings.test.tsx` 10/10; the new client CSRF test passed 1/1.
  ABANDON: Live Polar portal session, a human subscription change/cancellation in Polar, webhook propagation, and final Access state cannot be proved in this read-only, no-provider-mutation leaf. Keep the live launch gate open for an authorized end-to-end validation.

Local portal code and tests pass. The separate live-provider and human cancellation/propagation launch gate remains open under G6.
