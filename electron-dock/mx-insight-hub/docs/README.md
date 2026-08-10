# MX Insight Hub design index

Last reviewed: 2026-08-10.

This directory is the source of truth for MX Insight Hub. Night-All-specific implementation details remain in the Night-All repository; this project records only the stable dependency contract and ownership boundary.

## Current delivery

| Area | Current state |
| --- | --- |
| Modular monolith API | Implemented: multiple tenants, tenant rename, consumers, one-time API keys, explicit platform grants, per-platform limits, request idempotency, usage and health. Each consumer belongs to exactly one tenant. |
| Admin console | Implemented with the shared MX Launcher Neon Void design package, including platform-admin tenant create/list/rename and explicit tenant selection when creating a consumer. |
| Night-All adapter | Implemented for the private `/api/v1/data/search` facade; provider details are filtered. |
| Local lifecycle | Docker Compose, PostgreSQL, bootstrap and smoke commands. |
| Internal K8s | One-click lifecycle and manifests implemented: independent Hub namespace, a dedicated Hub database/role provisioned inside shared `mx-common` PostgreSQL, migration Job, split public/Admin Deployments, projector/ingest workers, Services and NetworkPolicy. A retired Hub-local PostgreSQL is decommissioned only by an explicit destructive command. |
| Launcher integration | Lifecycle delegation, offline-safe status summary and AppCenter entrypoint. |
| Unified identity | Launcher opaque-token sign-in/introspection, Hub-local external identity bindings, multi-tenant memberships, per-tenant roles, explicit platform-admin scope mapping and the global Admin Token break-glass path are implemented. Direct JWT/JWKS validation is not used because Launcher tokens are opaque. |
| Data ingest and serving plane | PostgreSQL source providers with encrypted passwords, source objects, canonical records/revisions/tombstones, projection outbox, durable queues/cursors, direct file import, versioned mappings, PostgreSQL external pull and import-run evidence are implemented. `/shared_dir` watcher, immutable object/cloud storage adapters, a generic CDC connector and non-PostgreSQL database connectors are not. |
| Telegram monitor sources | `telegram.monitor.chats.v1` and `telegram.monitor.messages.v1`, provider/source/schema/shape/sync/import-run Admin paths, strict history, Night-All-v1-compatible stored search and fuzzy entity search are implemented. The real source schema is recorded, but both sources remain paused until the source owner supplies a safe unified change watermark/index/commit-order contract—especially messages, where `collected_at` misses later edits/deletions. These canonical datasets have no `tenant_id`; all consumers with the `telegram` grant read the same corpus. |
| Search/retrieval | Canonical projection outbox, projector, customer-safe Elasticsearch full-text/name fields, PostgreSQL degradation paths, Admin semantic search and shared `mx-common` search deployment are implemented. Elasticsearch remains rebuildable and is not required for canonical/history availability. |
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
17. [Telegram monitor PostgreSQL ingestion](operations/telegram-monitor-ingestion.md)
18. [Backup and restore](operations/backup-restore.md)
19. [Observability and SLO](operations/observability-slo.md)
20. [BI and Data Agent evolution](architecture/bi-and-data-agent-evolution.md)

## Decisions

- [ADR-0001: sibling project and ownership](adr/0001-sibling-project-and-ownership.md)
- [ADR-0002: modular monolith with split listeners](adr/0002-modular-monolith-split-listeners.md)
- [ADR-0003: independent transactional store](adr/0003-independent-transactional-store.md)
- [ADR-0004: federated identity and Hub-local product authorization](adr/0004-federated-identity-and-product-authorization.md)
- [ADR-0005: authoritative data and rebuildable search projections](adr/0005-authoritative-data-and-search-projections.md)
- [ADR-0006: idempotent ingestion and independent checkpoints](adr/0006-idempotent-ingestion-and-checkpoints.md)
- [ADR-0007: managed source providers and change watermarks](adr/0007-managed-source-providers-and-change-watermarks.md)
