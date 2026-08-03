# MX Insight Hub design index

Last reviewed: 2026-08-03.

This directory is the source of truth for MX Insight Hub. Night-All-specific implementation details remain in the Night-All repository; this project records only the stable dependency contract and ownership boundary.

## Current delivery

| Area | Current state |
| --- | --- |
| Modular monolith API | Implemented: tenants, consumers, one-time API keys, explicit platform grants, per-platform limits, request idempotency, usage and health. |
| Admin console | Implemented with the shared MX Launcher Neon Void design package. |
| Night-All adapter | Implemented for the private `/api/v1/data/search` facade; provider details are filtered. |
| Local lifecycle | Docker Compose, PostgreSQL, bootstrap and smoke commands. |
| Internal K8s | Manifests and one-click lifecycle implemented: independent namespace, PostgreSQL PVC, migration Job, split public/admin Deployments, Services and NetworkPolicy. Not yet deployed/verified on the internal server. |
| Launcher integration | Lifecycle delegation, offline-safe status summary and AppCenter entrypoint. |
| Unified identity | Boundary and claim mapping designed. Launcher SSO bearer validation, JWKS verification, identity bindings and tenant-member administration are not implemented yet. |
| Private/public DNS routes | Deliberately not auto-created. They require route/TLS review and a deployed public Service. |
| Billing, BI and Data Agent | Designed as later phases; the MVP has mutable request/usage evidence, not an append-only billing ledger or invoice engine. |
| Backup/PITR and ELK/SLO | Target runbooks are documented but automation/exporters are not implemented yet; these remain production release gates. |

## Read in this order

1. [System context](architecture/system-context.md)
2. [Trust and runtime boundaries](architecture/trust-runtime-boundaries.md)
3. [Unified identity and platform module integration](architecture/unified-identity-and-platform-modules.md)
4. [Night-All integration](architecture/night-all-integration.md)
5. [Data and ledger model](architecture/data-and-ledger-model.md)
6. [Sub2API parity and roadmap](product/sub2api-parity-roadmap.md)
7. [Admin console design](product/admin-console-design.md)
8. [Public API v1](contracts/public-api-v1.md)
   - Machine-readable contract: [OpenAPI](contracts/openapi.yaml)
9. [Key lifecycle](security/key-lifecycle.md)
10. [Local development](operations/local-development.md)
11. [Internal K8s deployment](operations/internal-k8s-deployment.md)
12. [Backup and restore](operations/backup-restore.md)
13. [Observability and SLO](operations/observability-slo.md)
14. [BI and Data Agent evolution](architecture/bi-and-data-agent-evolution.md)

## Decisions

- [ADR-0001: sibling project and ownership](adr/0001-sibling-project-and-ownership.md)
- [ADR-0002: modular monolith with split listeners](adr/0002-modular-monolith-split-listeners.md)
- [ADR-0003: independent transactional store](adr/0003-independent-transactional-store.md)
- [ADR-0004: federated identity and Hub-local product authorization](adr/0004-federated-identity-and-product-authorization.md)
