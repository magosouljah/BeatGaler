# Public status and security endpoints

This runbook covers the low-maintenance public operations surfaces for BeatGaler.

## `security.txt`

Canonical source: `public/.well-known/security.txt`.

The Web build copies it unchanged to `dist/.well-known/security.txt`. Nginx has an exact location for `/.well-known/security.txt`, returns the file directly (never the SPA fallback), and declares `text/plain; charset=utf-8`.

RFC 9116 requires an `Expires` field. The current file expires at `2027-02-28T23:59:59Z`. `scripts/test-public-operations-pages.mjs` rejects an expiry more than one year ahead and starts failing when fewer than 30 days remain. `.github/workflows/public-operations-validation.yml` runs that check weekly so stale metadata becomes a visible CI failure before expiry.

### Renewing `Expires`

Before the 30-day warning window:

1. Confirm `security@beatgaler.com` and `abuse@beatgaler.com` still reach the operational owner inbox.
2. Move `Expires` forward, preferably about six months, and always keep it less than one year in the future.
3. Run `node scripts/test-public-operations-pages.mjs` and `npm run build:web` followed by `node scripts/test-public-operations-pages.mjs --dist`.
4. Ship through the normal PR/CI/deploy path. Do not edit the production host by hand as a substitute for the repository source.

## `status.beatgaler.com`

Canonical source: `public/status/index.html`. It is intentionally static and operator-maintained. It names only public service groups and public contact addresses; it does not expose internal health URLs, hosts, credentials, tokens, telemetry, or infrastructure details.

The EC2 installer only asks Certbot to add `status.beatgaler.com` when that hostname resolves to the same public origin as `api.beatgaler.com`. Until then, normal `beatgaler.com` deployments continue without trying to issue the status certificate.

### Owner DNS action

Create this DNS record:

- Name: `status`
- Type: `CNAME`
- Value: `beatgaler.com`

Use the provider's normal/default TTL. If the DNS provider offers an HTTP proxy/CDN toggle, use DNS-only for initial origin certificate issuance unless the production routing has explicitly been changed to support the proxy.

After DNS resolves, run the normal Web production deployment again. The installer expands the existing `beatgaler.com` certificate with the `status.beatgaler.com` SAN, installs the status virtual host, and performs a local HTTPS smoke check against the status hostname. Public runtime should only be marked verified after an external HTTPS request to `https://status.beatgaler.com/` succeeds.

## Public contacts

- Support: `support@beatgaler.com`
- Security: `security@beatgaler.com`
- Abuse: `abuse@beatgaler.com`
