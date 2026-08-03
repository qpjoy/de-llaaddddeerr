# ADR-0004: federated identity and Hub-local product authorization

Status: accepted.

## Context

MX Launcher already owns organization login, human identity and the edge gateway. MX Insight Hub owns customer data-product state: tenants, consumers, API keys, platform grants, quotas, usage and future billing. Sharing user tables or databases would couple their releases, enlarge compromise scope and make Hub availability part of Launcher’s network path. Treating gateway admission as authorization would also allow a broad Launcher role to bypass platform grants and accounting.

## Decision

- Launcher remains authoritative for human and organization authentication and issues a future signed principal contract.
- Hub maps a verified principal by canonical `iss + sub + aud + organization` to a Hub-local member and tenant membership.
- Hub and Launcher do not share user tables, membership tables or databases.
- Hub validates the future Launcher token against an explicitly configured issuer, audience and JWKS; gateway headers alone are not identity.
- Hub remains authoritative for consumer/API-key identity, platform and dataset grants, quotas, usage evidence, credit ledgers and billing.
- Public and internal data-plane requests pass Hub product authorization after gateway routing; Launcher login does not bypass it.
- New platforms implement the common versioned module contract and reuse the same Hub policy/accounting pipeline.
- Hub integration is feature-gated, independently routed/deployed and offline-safe. Hub unavailability cannot block Launcher startup, MX-H2I networking or existing gateway routes.

## Consequences

- Identity disablement and Hub membership suspension are different operations and require explicit lifecycle/audit handling.
- Hub needs future identity-binding and membership data, strict JWT/JWKS validation, key-rotation caching and revocation/session-expiry tests.
- Some organization display metadata may be duplicated, but authoritative credentials and membership state are not.
- Service admin tokens remain appropriate for deployment and operational summary automation, not interactive SSO.
- Every new platform must supply module contract, readiness, metering and failure semantics before tenant grants can be enabled.
- The current Launcher integration is only lifecycle delegation plus an ops summary; this ADR does not claim that SSO or JWKS support exists.

## Rejected alternatives

- **Shared Launcher/Hub user database:** creates cross-service schema, outage and privilege coupling.
- **Gateway-only authorization:** cannot enforce Hub consumer grants, quotas, balances or platform-specific policy.
- **Hub-owned human passwords/MFA:** duplicates the platform identity system and fragments organization login.
- **Launcher-owned API keys and billing:** moves product semantics into a generic platform control plane and couples every data-module change to Launcher.

See [Unified identity and platform module integration](../architecture/unified-identity-and-platform-modules.md) for the claim contract, responsibility matrix, platform module shape and offline acceptance criteria.
