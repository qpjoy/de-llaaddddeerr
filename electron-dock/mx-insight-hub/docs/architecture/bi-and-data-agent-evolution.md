# BI and Data Agent evolution

MX Insight Hub starts as a governed data API, then grows into an intelligent BI and Agent center without moving Night-All’s collection responsibilities.

## Phase 1: governed data access

- stable capabilities and search contract;
- tenants, consumers, keys and explicit grants;
- request/credit limits, idempotency and evidence;
- public/admin split, deployment, SLO and backups.

## Phase 2: data products and semantic BI

- dataset catalog with owner, schema version, freshness, quality and lineage;
- metrics/semantic layer with governed dimensions and measures;
- saved queries, dashboards, row/column policies and export controls;
- reproducible projections from Night-All through outbox/CDC;
- analytical store chosen by measured workload: PostgreSQL replicas/materialized views first, ClickHouse/OpenSearch only when concurrency, scan volume or full-text facets justify them.

OpenSearch/ELK is a searchable projection and log-retention tool, not a backup of either PostgreSQL database.

## Phase 3: Data Agent

- Agent identity separate from human and public API keys;
- policy-bound tools that reference dataset/capability IDs, never arbitrary Night-All routes;
- budgets for rows, calls, credits, model tokens, concurrency and wall-clock time;
- approval checkpoints for exports, high-cost fan-out and sensitive fields;
- run graph, prompt/tool/version provenance, evidence citations and replay;
- asynchronous jobs for all-platform work with total deadline, cancellation and partial results.

The Agent is a governed consumer of MX Insight datasets. It never receives provider credentials, Night-All database access, or a generic proxy tool.

