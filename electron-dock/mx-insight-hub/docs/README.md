# MX Insight Hub design index

Last reviewed: 2026-08-04.

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
| Data ingest and serving plane | Detailed storage, canonical identity, checkpoint, cache/fallback, file-ingest, PostGIS and ES projection design is complete. Runtime schemas/workers/object storage/cache/projector are not implemented. |
| Local search stack | Opt-in Elasticsearch/Kibana development sample and strict customer-safe mapping exist under `deploy/compose/search`; the Hub API does not write or query it yet. |
| Private/public DNS routes | Deliberately not auto-created. They require route/TLS review and a deployed public Service. |
| Billing, BI and Data Agent | Designed as later phases; the MVP has mutable request/usage evidence, not an append-only billing ledger or invoice engine. |
| Backup/PITR and ELK/SLO | Target runbooks are documented but automation/exporters are not implemented yet; these remain production release gates. |

## Read in this order

1. [System context](architecture/system-context.md)
2. [Trust and runtime boundaries](architecture/trust-runtime-boundaries.md)
3. [Unified identity and platform module integration](architecture/unified-identity-and-platform-modules.md)
4. [Night-All integration](architecture/night-all-integration.md)
5. [Data and ledger model](architecture/data-and-ledger-model.md)
6. [Data-platform storage and serving](architecture/data-platform-storage-and-serving.md)
7. [Ingestion, cache and fallback](architecture/ingestion-cache-and-fallback.md)
8. [`/shared_dir` file ingestion](operations/shared-directory-ingestion.md)
9. [Search and observability stack](operations/search-and-observability-stack.md)
10. [Commercial control plane](product/commercial-control-plane.md)
11. [Sub2API parity and roadmap](product/sub2api-parity-roadmap.md)
12. [Admin console design](product/admin-console-design.md)
13. [Public API v1](contracts/public-api-v1.md)
   - Machine-readable contract: [OpenAPI](contracts/openapi.yaml)
14. [Key lifecycle](security/key-lifecycle.md)
15. [Local development](operations/local-development.md)
16. [Internal K8s deployment](operations/internal-k8s-deployment.md)
17. [Backup and restore](operations/backup-restore.md)
18. [Observability and SLO](operations/observability-slo.md)
19. [BI and Data Agent evolution](architecture/bi-and-data-agent-evolution.md)

## Decisions

- [ADR-0001: sibling project and ownership](adr/0001-sibling-project-and-ownership.md)
- [ADR-0002: modular monolith with split listeners](adr/0002-modular-monolith-split-listeners.md)
- [ADR-0003: independent transactional store](adr/0003-independent-transactional-store.md)
- [ADR-0004: federated identity and Hub-local product authorization](adr/0004-federated-identity-and-product-authorization.md)
- [ADR-0005: authoritative data and rebuildable search projections](adr/0005-authoritative-data-and-search-projections.md)
- [ADR-0006: idempotent ingestion and independent checkpoints](adr/0006-idempotent-ingestion-and-checkpoints.md)
