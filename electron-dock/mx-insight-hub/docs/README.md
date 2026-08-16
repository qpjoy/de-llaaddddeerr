# MX Insight Hub design index

Last reviewed: 2026-08-16.

This directory is the source of truth for MX Insight Hub. Night-All-specific implementation details remain in the Night-All repository; this project records only the stable dependency contract and ownership boundary.

## Current delivery

| Area | Current state |
| --- | --- |
| Modular monolith API | Implemented: multiple tenants, tenant rename, consumers, one-time API keys, explicit platform grants, per-platform limits, request idempotency, usage and health. Each consumer belongs to exactly one tenant. |
| Admin console | Implemented with the shared MX Launcher Neon Void design package, including platform-admin tenant create/list/rename and explicit tenant selection when creating a consumer. |
| Open capabilities | Implemented: platform-independent capability grants and quotas reuse the existing tenant/consumer/API Key lifecycle. `nlp.tokenize` is the first capability and reports the actual HanLP/Jieba/bigram backend plus degradation state. |
| Data Center | Implemented as an Admin-Token-only PostgreSQL canonical catalog with dataset aggregates, full Admin record detail, exact totals, numbered pages and direct page jumps. Elasticsearch supplies ranked search only; PostgreSQL remains the authoritative count. |
| Night-All adapter | Implemented for the private `/api/v1/data/search` facade; provider details are filtered. |
| Local lifecycle | Docker Compose, PostgreSQL, bootstrap and smoke commands. |
| Internal K8s | One-click lifecycle and manifests implemented: independent Hub namespace, a dedicated Hub database/role provisioned inside shared `mx-common` PostgreSQL, migration Job, split public/Admin Deployments, projector/ingest workers, Services and NetworkPolicy. A retired Hub-local PostgreSQL is decommissioned only by an explicit destructive command. |
| Launcher integration | Lifecycle delegation, offline-safe status summary and AppCenter entrypoint. |
| Unified identity | Launcher opaque-token sign-in/introspection, Hub-local external identity bindings, multi-tenant memberships, per-tenant roles, explicit platform-admin scope mapping and the global Admin Token break-glass path are implemented. Direct JWT/JWKS validation is not used because Launcher tokens are opaque. |
| Data ingest and serving plane | Admin-token-only PostgreSQL/file source management, browser upload, allowlisted server-file paths, content observations, reusable immutable format rules, canonical records/revisions/tombstones, projection outbox, durable queues/cursors, interpretation-aware file idempotency, PostgreSQL external pull and import-run evidence are implemented. PostgreSQL credentials live directly in `catalog.external_sources.connection`; catalog backups are therefore sensitive. `/shared_dir` directory watcher/landing agent, immutable object/cloud storage adapters, prompt CRUD, a generic CDC connector and non-PostgreSQL database connectors are not. |
| Telegram monitor sources | `telegram.monitor.chats.v1` and `telegram.monitor.messages.v1`, a fixed two-input business task, explicit idempotent source-contract preparation, source progress/import evidence, strict history, Night-All-v1-compatible stored search and fuzzy entity search are implemented. Preparation installs the database-enforced watermark/trigger/index contract with one-request DDL credentials while ordinary ingest stays read-only; activation remains fail-closed until probe and writer attestation pass. These canonical datasets have no `tenant_id`; all consumers with the `telegram` grant read the same corpus. |
| Telegram SQLite read API | `telegram.sqlite.chats.v1` and `telegram.sqlite.messages.v1` are a separate fixed, Admin-managed GET-only pipeline. It preserves raw JSON and deletion-marked rows in PostgreSQL, uses deterministic identities and Hub transaction idempotency, and performs an initial/manual full alignment followed by append-oriented overlap polling plus a bounded previous-day window at 02:00 Asia/Shanghai. It never schedules an automatic historical full scan and is not merged into the PostgreSQL public Telegram datasets. |
| Search/retrieval | Canonical projection outbox, projector, unified cross-platform stored search, strict Chinese relevance, PostgreSQL degradation paths, Admin semantic search and a guarded projector-only reindex command are implemented. The repository includes versioned allowlisted profiles and the content-v4 mapping; each deployed environment remains gated on its strict blue/green index validation. Elasticsearch remains rebuildable and is not required for canonical/history availability. |
| Private/public DNS routes | Deliberately not auto-created. They require route/TLS review and a deployed public Service. |
| Billing, BI and Data Agent | Designed as later phases; the MVP has mutable request/usage evidence, not an append-only billing ledger or invoice engine. |
| Backup/PITR and ELK/SLO | Target runbooks are documented but automation/exporters are not implemented yet; these remain production release gates. |

## Search evolution boundary

- The repository declares content v4; an environment whose read alias still
  points to content v3 stays on v3 until a strict PG-to-ES rebuild has populated
  and validated v4. The v4 capability set is deliberately bounded: raw
  standard, HanLP coarse pre-segmented, title/body CJK bigram and title-only
  edge-prefix fields.
- Search behavior is expressed as immutable allowlisted profiles. The strict
  baseline is `canonical.balanced.v1`; `canonical.phrase.v1`,
  `canonical.terms-all.v1`, `canonical.zh-recall.v1` and
  `canonical.title-prefix.v1` cover public product intents, while
  `canonical.cjk-bigram.v1` and `canonical.legacy-or.v1` stay in the Admin
  Search Lab for comparison.
- Default `canonical.balanced.v1` still sends each first-page query to HanLP and,
  when that primary backend is healthy, applies all generated terms to the
  legacy-named `*Hanlp` pre-segmented fields with AND alongside raw phrase. If
  HanLP degrades to Jieba/bigram, those incompatible fallback terms are reported
  but are not compared with HanLP postings: the applied profile becomes
  `canonical.phrase.v1`. The signed cursor preserves the first page's profile,
  tokens and backend for every later page. CJK bigram only joins a healthy
  `canonical.zh-recall.v1` query as a lower-weight branch.
- Query-time scoring/operator/analyzer selection over existing compatible
  postings does not require a rebuild. A new index-time token representation
  always uses a schema-versioned blue/green rebuild; adding a multi-field without
  replaying historical records is not considered complete.
- Public callers never receive arbitrary Elasticsearch index, field, analyzer,
  DSL, script, boost or full explain controls. The IK max-word/smart principle is
  represented by separate MX token views plus a narrower query profile, without
  installing IK or HanLP inside Elasticsearch.
- The authoritative lifecycle and guardrails are documented in
  [Data-platform storage and serving](architecture/data-platform-storage-and-serving.md#43-版本化搜索-profiles),
  [Search and observability stack](operations/search-and-observability-stack.md#42-content-v4-与搜索-profile-变更手册),
  and [ADR-0009](adr/0009-unified-canonical-search.md#search-profiles-and-analysis-lifecycle).

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
13. [Open API v1](contracts/public-api-v1.md)
   - Machine-readable contract: [OpenAPI](contracts/openapi.yaml)
14. [Key lifecycle](security/key-lifecycle.md)
15. [Local development](operations/local-development.md)
16. [Internal K8s deployment](operations/internal-k8s-deployment.md)
17. [Telegram monitor PostgreSQL ingestion](operations/telegram-monitor-ingestion.md)
18. [Telegram SQLite read-API ingestion](operations/telegram-sqlite-api-ingestion.md)
19. [Backup and restore](operations/backup-restore.md)
20. [Observability and SLO](operations/observability-slo.md)
21. [BI and Data Agent evolution](architecture/bi-and-data-agent-evolution.md)
22. [Agent provider settings](operations/agent-provider-settings.md)
23. [Open capabilities, file rules and bounded classification cost](adr/0008-open-capabilities-file-rules-and-classification.md)

## Decisions

- [ADR-0001: sibling project and ownership](adr/0001-sibling-project-and-ownership.md)
- [ADR-0002: modular monolith with split listeners](adr/0002-modular-monolith-split-listeners.md)
- [ADR-0003: independent transactional store](adr/0003-independent-transactional-store.md)
- [ADR-0004: federated identity and Hub-local product authorization](adr/0004-federated-identity-and-product-authorization.md)
- [ADR-0005: authoritative data and rebuildable search projections](adr/0005-authoritative-data-and-search-projections.md)
- [ADR-0006: idempotent ingestion and independent checkpoints](adr/0006-idempotent-ingestion-and-checkpoints.md)
- [ADR-0007: managed data sources and change watermarks](adr/0007-managed-data-sources-and-change-watermarks.md)
- [ADR-0008: open capabilities, file rules and bounded classification cost](adr/0008-open-capabilities-file-rules-and-classification.md)
- [ADR-0009: unified canonical search](adr/0009-unified-canonical-search.md)
