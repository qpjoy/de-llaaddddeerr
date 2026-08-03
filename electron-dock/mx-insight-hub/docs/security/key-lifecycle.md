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
- Provider key: lives only in Night-All Credential Center.

Development defaults in Compose are intentionally local-only. Internal production deployment refuses to proceed without explicit admin token, API-key pepper, PostgreSQL password and Night-All URL in `.env.internal` or the environment.
