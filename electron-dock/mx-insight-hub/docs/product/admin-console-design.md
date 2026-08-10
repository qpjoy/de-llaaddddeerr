# Admin console design

Status: implemented; direct data-source workflow updated on 2026-08-10.

## Sources

- Product structure: the supplied Sub2API dashboard reference informed the sidebar, KPI, time-control, chart/evidence and administration hierarchy.
- Visual language: `../mx-launcher/demos/ui-design-neon-void` and the shared `../mx-launcher/ui-design` package are authoritative for color, typography, density, radius, borders and interaction states.
- Icons: `@phosphor-icons/react`; no emoji, text-symbol or handcrafted SVG substitutes.

The console intentionally keeps Sub2API-like operational clarity while using the requested MX Neon Void identity. It is not a pixel clone of the reference palette.

## Information architecture

| Group | Page | Primary job |
| --- | --- | --- |
| Business governance | Dashboard | Observe callers, active keys, request outcomes, units and upstream latency. |
| Business governance | Consumers | Manage tenant-scoped business/application identities. |
| Business governance | API Keys | Issue one-time secrets, filter keys and perform explicit revocation. |
| Policy control | Plans and quotas | Explain and edit product-limit semantics. |
| Policy control | Platforms | Grant concrete platforms and configure consumer-specific windows/page size. |
| Data plane | External sources | Register/test PostgreSQL connections directly on paused sources; inspect schema/value shapes; review/approve mappings; activate, sync and inspect checkpoints/import-run counts. Direct file upload remains supported. |
| Observability | Usage | Inspect request evidence without exposing provider details. |
| Observability | Runtime | Separate liveness, store readiness and Night-All readiness. |

Admin authentication is a session-only bootstrap surface. The token is kept in browser session storage, never written to the URL, and automatically cleared on authorization failure or explicit logout.

The source UI deliberately separates connection health from synchronization
safety. A green source connection test proves a read-only session, not that a
table has a safe watermark; source activation remains blocked by
mapping/schema/index issues. PostgreSQL host, port, database, username,
password, SSL mode, schema/table and cursor fields live directly on the source.
The Admin Token can view and change them; Launcher-login admins and public API
keys cannot access this page or its routes. The password is intentionally stored
as plaintext catalog data for direct management, so the UI labels the database
and backups as credential-bearing. Connection changes require that source to be
paused and drained; the UI keeps the last-known-good values on a failed probe
and surfaces `source_draining` or `source_busy` directly.
Task cards show durable cursor/queue and import-run row/changed/deleted/rejected
evidence without displaying raw rejected rows. Cloud/object/warehouse choices
are not shown until their adapters and checkpoint semantics exist; today the
implemented source types are PostgreSQL and direct CSV/TSV, JSONL/NDJSON,
TXT/MD and XLSX/XLSM files.
Checkpoint reset is shown only for paused database sources and requires typing
the exact source key. If a pull still owns the source advisory lock, the UI
surfaces `409 source_busy`; the operator waits for that pull to exit and retries
instead of racing its cursor acknowledgement.

Source pause is shown as draining while its cursor remains `running`: no new
batch starts, the in-flight batch reaches its checkpoint boundary, and
connection/mapping/reactivation controls stay disabled with `source_draining`.
File preview is local inference by default. The Agent toggle is explicit and its
disclosure says “column names only”; source values/sample rows are never sent to
the model.

## Generated brand asset

The visible mark is `public/assets/mx-insight-logo-mark.png`. It was created with the built-in ImageGen workflow from this art direction:

> Original M-shaped data gateway/prism emblem; Neon Void cyan and violet light; subtle magenta key/access accent; dark transparent-ready background; geometric, technical, compact, no text, no copied trademark.

The generated source was cropped into a standalone mark for the 42–64 px sidebar/auth slots. `mx-insight-logo.png` and `mx-insight-logo-chroma.png` retain higher-resolution source variants for future release assets.

## Responsive and accessibility behavior

- At desktop widths, navigation remains persistent and metrics use four columns before collapsing to two.
- Below 900 px, navigation becomes an explicit drawer; below 640 px, metrics/forms become single-column.
- Tables remain horizontally scrollable instead of squeezing action labels into unusable widths.
- Navigation, dialogs, forms, tables, status regions and primary controls have semantic accessible names.
- Empty, loading and error states are first-class components rather than blank panels.

See the repository-root `design-qa.md` for the reference/implementation comparison, tested interactions, console review and final QA status.
