# API key lifecycle

## Storage

An issued key has a public prefix and random secret. The plaintext is returned once. PostgreSQL stores only an HMAC digest calculated with `MX_INSIGHT_API_KEY_PEPPER`, plus non-secret prefix/last-four metadata.

The pepper is a K8s Secret, not a database field. A database dump alone must not permit offline key verification.

## Lifecycle

1. Issue under one consumer and environment (`test` or `live`).
2. MVP grants concrete mutable platforms and limits to the consumer; every key resolves them on each request. The production grant-set snapshot per key/subscription remains a planned migration.
3. Record last-used/request evidence without storing the plaintext.
4. Rotate by issuing a second key, verifying traffic, then revoking the old key.
5. Revocation is immediate for database-backed auth; caches must have bounded TTL and explicit invalidation later.

## Separation

- Caller key: identifies a customer consumer and carries no provider secret.
- Admin token: permits internal operator API access; never accepted by public routes.
- Night-All service token: workload identity on the private Hub-to-Night-All hop.
- Night-All upstream/provider credentials: remain in Night-All Credential Center.
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

Database-mode model credentials and source passwords make PostgreSQL dumps,
WAL, replicas and restore artifacts secret-bearing. The current shared Hub
database owner cannot enforce workload-level `SELECT` isolation; splitting
migration, Agent writer/runtime and ordinary workload roles remains required
before treating the database as a least-privilege credential store.

Development defaults in Compose are intentionally local-only. Internal
production requires an explicit Admin token and API-key pepper in
`.env.internal` or the environment. Night-All may use either an explicit
reviewed URL or the documented host-local default. The shared `mx-common` plane
may generate and retain the Hub database password; pinning it is optional.

Source passwords are changed directly with
`PUT /internal/v1/admin/sources/:key` while the source is paused and drained,
then verified through `POST /internal/v1/admin/sources/:key/test`. No additional
provider credential key is deployed or restored.
