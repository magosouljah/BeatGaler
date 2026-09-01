# Windows Authenticode + RFC3161 release seam

**Owner: `RO`**  
**External signing provider: `PENDING_OWNER_PROVIDER`**  
**Production signing state: `NO-GO`**

This control provides Windows OS publisher trust for BeatGaler PE/NSIS artifacts. It is explicitly separate from the **Tauri updater signature** (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `.exe.sig`), which protects updater payload integrity. Neither mechanism substitutes for the other.

## Release policy

- `Build - Windows` has two explicit intents: `internal` and `public`.
- `internal` may build while production Authenticode is deferred, but its evidence must say `INTERNAL_NOT_FOR_PUBLIC_RELEASE` and `public_release_eligible=false`.
- `public` fails closed while the provider is `PENDING_OWNER_PROVIDER` or any required provider/certificate/timestamp/publisher configuration is missing or invalid.
- Production Authenticode file digest is **SHA-256**. SHA-1 is not permitted as the file digest.
- A trusted **RFC3161/TSP** timestamp is mandatory, and the timestamp endpoint must be absolute HTTPS.
- A signed `.exe` without a valid RFC3161 timestamp is not eligible for public release.
- Public verification must pass `signtool verify /pa /all /v` and repository checks for a valid Authenticode status, expected publisher, SHA-256 signer policy, a timestamp certificate, the Authenticode RFC3161 timestamp attribute, and applicable Windows trust validation.
- Both the NSIS installer and the installed/final BeatGaler application executable are verified for a public build. The installed app executable is discovered safely rather than assuming a fixed filename.
- No certificate, private key, password, token, or provider credential is committed to this repository.

## Signing order and updater separation

For `release_intent=public`, the build creates an **ephemeral Tauri config outside the repository** before bundling. It supplies:

- `bundle.windows.certificateThumbprint` from external configuration;
- `bundle.windows.digestAlgorithm = "sha256"`;
- `bundle.windows.timestampUrl` from the owner/provider-approved HTTPS endpoint;
- `bundle.windows.tsp = true` for RFC3161/TSP.

Authenticode therefore runs inside the Tauri bundling pipeline. The final Authenticode-signed application/installer bytes are produced before the Tauri updater `.exe.sig` is accepted. The workflow rejects an updater signature older than the final installer and then runs the existing updater artifact verification so a stale signature for pre-Authenticode bytes cannot pass.

## Secret and provider boundary

Production certificate/private-key material and provider credentials must live outside Git, for example in an HSM, remote-signing service, protected runner/certificate store, OIDC-backed provider, or equivalent owner-approved custody model.

Repository/runtime configuration used by the seam:

| Setting | Location | Purpose |
|---|---|---|
| `WINDOWS_AUTHENTICODE_PROVIDER` | GitHub Actions variable | Selected provider identifier; remains `PENDING_OWNER_PROVIDER` until RO decides. |
| `WINDOWS_AUTHENTICODE_CERT_SHA1` | GitHub Actions secret | Certificate thumbprint selector only; this does **not** mean SHA-1 is used for the Authenticode file digest. |
| `WINDOWS_RFC3161_TIMESTAMP_URL` | GitHub Actions variable | Owner/provider-approved absolute HTTPS RFC3161 endpoint. |
| `WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT` | GitHub Actions variable | Owner-approved expected legal publisher/certificate subject. |

Provider-specific authentication or a provider-specific Tauri `signCommand` is intentionally deferred. If RO selects a provider that requires `signCommand`, that adapter must preserve the same SHA-256, RFC3161, trust verification, release-intent, and fail-closed gates.

## Build and publication gates

1. Internal Windows builds use the normal packaging path and remain explicitly non-public.
2. Public Windows builds validate provider/configuration first, then build through the Authenticode-aware ephemeral Tauri config.
3. The public build verifies the NSIS installer, rejects stale updater signing order, installs the package, discovers the application executable, verifies that executable, and verifies updater artifacts.
4. Only after those checks does the build emit `WINDOWS-AUTHENTICODE-STATUS.json` with public eligibility.
5. `Release - Desktop Updater` has an independent Windows job before publication is reachable. It validates the selected Windows run as a successful **public** `Build - Windows` run, rejects internal/deferred evidence, checks out the exact source SHA used by that build, downloads the selected Windows artifact, and independently re-verifies the actual installer `.exe` with the Windows trust verifier.
6. The existing immutable release governance remains authoritative: channel policy, source-SHA provenance, Draft → upload → verify → publish-once flow, no clobber/overwrite, prerelease handling, stable/latest rules, and `provenance.json` are preserved.

## Inputs still required from RO

The following twelve inputs are intentionally unresolved and required before production signing can become GO:

1. **Authenticode provider** — select and approve the production provider.
2. **Production certificate** — obtain/approve the real code-signing certificate; no test certificate counts as production evidence.
3. **Exact legal subject/publisher** — confirm the exact certificate subject/publisher identity BeatGaler will enforce.
4. **Private-key custody** — choose HSM, remote signing, protected certificate store/runner, or equivalent custody outside the repo.
5. **CI authentication mechanism** — define OIDC/provider authentication, protected-runner binding, hardware access, or equivalent.
6. **Thumbprint/config or provider `signCommand`** — provide the production certificate selector/configuration or the provider-specific signing adapter.
7. **HTTPS RFC3161 endpoint** — approve the production timestamp service endpoint.
8. **`WINDOWS_AUTHENTICODE_EXPECTED_SUBJECT`** — set the owner-approved expected legal publisher subject.
9. **Renewal/expiration process** — define certificate renewal, expiry monitoring, and replacement ownership.
10. **Outage/provider failure procedure** — define fail-closed handling and operational response when signing/timestamp infrastructure is unavailable.
11. **Rotation/emergency disable** — define credential/certificate rotation and an emergency disable/revocation procedure.
12. **Controlled public-build authorization** — explicitly authorize one controlled `release_intent=public` build for production signing evidence.

Until all required external inputs exist and a controlled real public build passes the full signing and verification chain, **PRODUCTION SIGNING = NO-GO**. This seam does not buy, request, generate, provision, import, or publish with a production certificate.
