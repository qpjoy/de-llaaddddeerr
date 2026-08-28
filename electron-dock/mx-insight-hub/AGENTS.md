# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## MX Insight Hub product context

- Treat `/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-launcher/demos/ui-design-neon-void` and `mx-launcher/ui-design` as the visual source of truth.
- Hub defaults new browser profiles to the cool light Neon Void theme and keeps the existing dark theme as a persisted user-selectable mode. Theme changes are presentation-only and must not change authentication, routing, or API behavior.
- Use the shared searchable `DropdownField` for every popup value selector in the Hub. Do not use native `<select>` for Hub product controls because its expanded menu cannot be themed consistently; region-picker dialogs and navigation accordions remain their own interaction patterns.
- For the governed source catalog, the real Hub `DashboardPage` command-center layout is the large-screen visual baseline. The existing external-source pipeline page is an execution-semantic reference only, not the dashboard reference.
- Keep `/source-catalog` as the governed business directory and `/sources` as the existing connection, mapping, import, and cleaning execution surface (shown as “数据清洗计划”). Do not merge their status models or storage.
- Source-catalog metadata is authoritative in PostgreSQL. Elasticsearch may later receive a rebuildable outbox projection, but application requests must never dual-write PG and ES.
- Source-catalog status has four independent delivered axes: coverage (`unknown/not_covered/partial/covered`), delivery (`exploring/planned/doing/blocked/complete/paused/retired`), field review, and runtime health. A `complete` delivery may still have unknown or degraded runtime health.
- Use the supplied Sub2API dashboard screenshot only as the information-architecture reference for accounts, API keys, plans, quotas, usage, channels, and operational metrics. Do not copy its branding.
- The primary workflow is: create a consumer, issue a one-time API key, grant explicit platform capabilities and limits, call Night-All through the Hub, and inspect usage/latency/error evidence.
- Night-All remains an internal data source. Never expose its provider credentials, provider names, endpoint IDs, `businessId`, or `availabilityMode` to public clients.
- MX Launcher owns deployment and human-operator access. MX Insight Hub owns tenants, consumers, API keys, grants, plans, credits, usage, request idempotency, and billing evidence.
- Agent Provider catalogs must use page-level table/list CRUD with explicit create, edit, delete, test, and secret-reveal actions. Do not put whole-catalog Provider creation/editing back into a vertically stacked modal. Proxy endpoints and Proxy Sequences likewise keep visible CRUD plus explicit Hub-global and per-Provider bindings on the page.
- Provider Catalog is an account directory, not a service default: Catalog order and the first record never imply a business default. Agent service order and defaults must be expressed through an explicit LLM Sequence, including the one-Provider case; Chat and Embedding may legitimately have no default.
- LLM Proxy is optional. Creating the first endpoint or Proxy Sequence never binds it; Hub-global and per-Provider bindings are explicit and clearable. With neither binding, describe the route as container/system egress, not as an implicit application Proxy or a Docker-daemon proxy.
- Reuse the shared Neon Void `qp-modal`/`qp-dialog` primitives and Hub `ConfirmDialog` for destructive browser actions. Do not add new `window.confirm` flows; dangerous dialogs initially focus Cancel and remain non-dismissible while busy.
- Server-file sources use a plain pasteable path input, never a directory/path dropdown. Treat the pasted absolute path as transient: runtime allowlists reduce it to `rootId + relativePath`, and catalog/log/response lineage must not persist the host path. “Archive by structure” means reuse an immutable format-rule version; never move or delete the source file.
- File registration may classify a value-free first/middle/last structural sample automatically. Known producers use a stable logical rule (for example `rule-twitter-canyie`) whose CSV/JSONL layouts become immutable versions under one dataset/platform/object-type scope.
- The Admin Token Data Center is an operator evidence surface: show the true canonical record, current revision payload, extensions and lineage without redaction. Public stored-search responses remain explicitly allowlisted and must never expose raw/source-private fields.
- Keep `/api/v1/data/search` backward-compatible with the Night-All adapter. Hub-owned canonical search is a separate endpoint; clients select logical dataset/platform/object filters, never a PostgreSQL database, Elasticsearch cluster, index, DSL or script.
