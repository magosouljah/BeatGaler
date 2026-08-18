# BeatGaler — Security Base Architecture v0.4.0

Scope: architecture barriers required before deep testing and before BeatGaler Web. This is not a claim that the product has completed a professional security audit.

## 1. Authorization is server-side

- Product permissions are never authoritative in React/Desktop UI.
- A signed-in account session is resolved by the backend.
- Tenant-sensitive control-plane operations must validate the authenticated account before acting.
- Plan/entitlement checks will plug into the same backend authorization boundary when quota enforcement is activated.
- The development plan switch is server-side and remains dev-only.

## 2. Tenant isolation

Current v1 ownership model remains one private BeatGaler library per account/installation binding.

For every tenant-sensitive request:

1. Authenticate the BeatGaler account.
2. Validate the installation id.
3. Resolve the installation -> account binding server-side.
4. Require the bound account id to equal the authenticated account id.
5. Only then resolve storage/control-plane identifiers.

The client cannot select another account's storage by sending a different installation id.

Shared-folder/public-profile ownership is deliberately not designed here; it remains a V2 architecture decision.

## 3. Backend-side input validation

Security v1 introduces central validation for request ids/display strings and strict body/upload limits.

- JSON body limit: 256 KiB.
- Multipart: one file, bounded field count and field size.
- File upload middleware enforces the private hard file-size ceiling server-side.
- Installation ids are validated before tenant lookup.
- Sensitive routes continue to perform operation-specific checks (positive message ids, required beat ids, valid session ids, etc.).

Future route work should add schemas at each API boundary rather than trusting TypeScript types sent by a client.

## 4. No infrastructure secrets in frontend

The trust boundary is:

React/Web UI -> BeatGaler API -> private infrastructure

- Long-lived infrastructure credentials stay server-side.
- Private transport diagnostics are no longer a public endpoint in production.
- Direct Desktop transport credentials may exist only in the native Rust/runtime transport process for an active session; they must not be exposed to React UI or persisted as product data.
- BeatGaler Web must never receive infrastructure credentials. Web file access will require a later server-authorized temporary-access design.
- Production CORS is allowlist-based via `BEATGALER_ALLOWED_ORIGINS`; wildcard production CORS is not part of the architecture.

Account session credentials are separate from infrastructure secrets. For a future pure Web release, the preferred browser auth architecture is an HttpOnly/Secure/SameSite session cookie (or equivalent server-managed browser session), rather than exposing long-lived auth credentials to application JavaScript.

## 5. Paths / ZIP handling

- The backend never accepts a local filesystem path as authority for a remote file operation; uploaded bytes are placed in a server-owned temporary directory.
- Multipart text uses literal form fields; client text must not become command-line directives.
- PROJECT ZIP entry validation rejects absolute paths, drive paths and `..` traversal entries before the ZIP is accepted as a valid BeatGaler PROJECT.
- PROJECT ZIP entry count has a hard safety ceiling.
- Existing Backup/Backups exclusion remains separate product behavior.

Before any future server-side ZIP extraction is introduced, it must additionally enforce an extraction root, uncompressed-size ceiling, compression-ratio ceiling, symlink/reparse-point policy and per-entry size limits.

## Authenticated push events

SSE previously selected a tenant using only an installation id in the URL. Security v1 changes this to:

1. Authenticated POST `/events/ticket`.
2. Backend checks account -> installation ownership.
3. Backend returns a random one-use ticket valid for 60 seconds.
4. EventSource consumes that ticket once.

The BeatGaler account bearer token is therefore not placed in the EventSource URL.

## Private diagnostics

`/transport/status` is private:

- available from loopback in non-production development, or
- via `X-BeatGaler-Admin-Key` when `BEATGALER_ADMIN_KEY` is configured.

It is not a product/user endpoint.

## Explicitly not completed by this architecture pass

- Full security audit / penetration test.
- Billing enforcement and full plan quota enforcement.
- Web authentication migration to HttpOnly cookie sessions.
- V2 public profiles/shared-folder authorization model.
- Full ZIP bomb/symlink extraction defense, because BeatGaler does not add a new server-side extraction pipeline in this pass.
