# API key lifecycle

## Storage

An issued key has a public prefix and random secret. The plaintext is returned once. PostgreSQL stores only an HMAC digest calculated with `MX_INSIGHT_API_KEY_PEPPER`, plus non-secret prefix/last-four metadata.

The pepper is a K8s Secret, not a database field. A database dump alone must not permit offline key verification.

## Lifecycle

1. Issue under one consumer. The current Admin UI signs `live` keys only.
2. Select a subset of the consumer's current platform/capability grants. The server freezes those entitlements and their request/page ceilings into an immutable key snapshot; omission selects all grants that exist at issuance time.
3. Record last-used/request evidence without storing the plaintext.
4. Rotate by issuing a second key, verifying traffic, then revoking the old key.
5. Revocation is immediate for database-backed auth; caches must have bounded TTL and explicit invalidation later.

The client normally receives one ordinary Hub Public API key; there is no
provider-specific key format. A request is allowed only by the intersection of
the key snapshot and the consumer's current grants. Consumer revocation therefore
takes effect immediately, while a later grant or higher ceiling does not silently
expand an existing key: issue a replacement and explicitly select the new scope.
Keys created before the entitlement migration are marked `legacy_dynamic` and
should be rotated. A consumer may now issue sibling keys for different platforms
or workloads while keeping usage attribution per key; a separate consumer remains
the stronger boundary for independent business identity or shared-budget isolation.

The backend continues to recognize `environment=test` as compatibility metadata,
but it does **not** provide an isolated sandbox. The Admin UI therefore issues only
`mih_live_` keys. External ecommerce acquisition is explicitly live-only even when
a legacy `mih_test_` key is otherwise valid:

- `GET /api/v1/data/capabilities` keeps an explicitly granted `ecommerce` entry but
  reports `ready=false` for a Test key;
- product search and product media return `403 test_key_not_supported` before a
  usage reservation, committed-result/media lookup or provider dispatch; and
- the rejection creates no usage reservation and invokes neither the ecommerce
  provider nor the media loader.

This route-specific safety gate does not turn Test into a general zero-cost
credential; every other public route retains its own documented contract. If an
older workbench left an ambiguous Test-key request in browser recovery state, the
page keeps the exact body, original `Idempotency-Key` and one-way credential
fingerprint as operational evidence and never sends the Test secret to ecommerce.
After a current Live key passes its zero-cost capability check, the main search
action performs the consumer-scoped status GET automatically. The page asks for
neither a UUID nor manual ownership review. An explicit `unknown` may be followed
by one new-key acquisition when the operator selects `refresh` and presses the
main button; the page adds `X-MX-Insight-Retry-Of` itself. `reserved` and failed
lookups remain blocked.

## Separation

- Caller key: identifies a customer consumer and carries no provider secret.
- Admin token: permits internal operator API access; never accepted by public routes.
- Night-All service token: workload identity on the private Hub-to-Night-All hop.
- Night-All upstream/provider credentials: remain in Night-All Credential Center.
- Hub external-platform credentials: JustOne and TikHub environment fallbacks are
  injected only into the Public/combined runtime. Prefer the Admin-token UI, which stores
  the value in isolated `control.external_platform_provider_credentials`; safe
  DTOs return only source/revision/configured metadata, and reveal requires a
  second Admin Token check. Saving or rotating this credential does not open the
  independent contract-verification gate.
- Hub model-provider credential: used only by the bounded mapping/embedding
  Agent. Environment bootstrap keeps it in the model-key K8s Secret. When an
  operator explicitly switches the chain to database mode, the plaintext is
  stored in the isolated `control.agent_provider_credentials` table; Admin
  responses and UI expose only `keyConfigured` and provide no reveal path.
- Direct PostgreSQL source password: accepted and readable only through the
  Admin-token source surface and stored as plaintext in
  `catalog.external_sources.connection`. It is never accepted by or returned to
  public API-key callers or Launcher-login sessions. Database and backup access
  therefore grants access to source credentials and must be restricted/audited.

Database-mode external-platform/model credentials and source passwords make
PostgreSQL dumps, WAL, replicas and restore artifacts secret-bearing. The
restricted exact provider-response table may also contain signed bearer-style
media URLs even though request credentials and request URLs are never archived.
Migration 059 explicitly revokes `PUBLIC` privileges from the external-platform
credential and setting tables. This is table-permission hardening, not at-rest
encryption: the current shared Hub database owner can still read them and cannot
enforce workload-level `SELECT` isolation. Splitting migration, credentialed
runtime and ordinary workload roles remains required before treating the
database as a least-privilege credential store. Storage-volume, backup, WAL and
replica encryption must be enforced and audited by the deployment environment;
the application does not currently provide column-level credential encryption.

Development defaults in Compose are intentionally local-only. Internal
production requires an explicit Admin token and API-key pepper in
`.env.internal` or the environment. Night-All may use either an explicit
reviewed URL or the documented host-local default. The shared `mx-common` plane
may generate and retain the Hub database password; pinning it is optional.

Source passwords are changed directly with
`PUT /internal/v1/admin/sources/:key` while the source is paused and drained,
then verified through `POST /internal/v1/admin/sources/:key/test`. No additional
provider credential key is deployed or restored.
