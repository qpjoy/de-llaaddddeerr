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
- Direct source-provider password: write-only Hub Admin input, encrypted in the
  catalog with AES-256-GCM and never exposed to public/Admin read responses.
- `MX_INSIGHT_PROVIDER_MASTER_KEY`: platform trust root for those encrypted
  source passwords; present only in Admin/combined and ingest workloads, never
  in the public listener.

Development defaults in Compose are intentionally local-only. Internal
production requires an explicit Admin token, API-key pepper, provider master
key in `.env.internal` or the environment. Night-All may use either an explicit
reviewed URL or the documented host-local default. The shared `mx-common` plane
may generate and retain the Hub database password; pinning it is optional.

The provider master key must be restored together with catalog backups and must
not be silently replaced. The deployment blocks drift once retained because an
uncoordinated change makes every registered source password undecryptable.
Rotate with a reviewed decrypt/re-encrypt procedure and a rollback copy; source
password rotation is independent and uses
`PUT /internal/v1/admin/source-providers/:key` followed by a read-only
connection test.
