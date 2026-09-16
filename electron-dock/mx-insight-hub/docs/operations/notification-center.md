# Admin notification center

The Hub Admin sidebar exposes **可观测性 → 通知中心** (`#/notifications`).
It is restricted to the existing Hub Admin Token, both in navigation and every
API handler. Launcher members and consumer API keys cannot read supplier alerts
or change their state. This does not change MX-H2I login or connectivity.

## Categories and evidence

The first source is the completed JustOne provider-call ledger:

| Category | Trigger | Severity |
| --- | --- | --- |
| `upstream.balance` | `upstream_balance_exhausted` / 601 | critical |
| `upstream.token_limit` | `upstream_token_limit_exceeded` / 602 | warning |

601 concerns the supplier account's shared funds; 602 concerns the token's
cumulative spending limit. Neither is a Hub customer's wallet alert. No verified
public balance-query API was found in JustOne's official catalog/usage guide as
of 2026-09-16. These are observed failure alerts, not numeric balance estimates
or advance low-balance warnings.

Incidents retain category, severity, source, credential revision scope, first/last
occurrence, count and latest Hub request ID. Each source event retains the
provider-call ID, request ID, marketplace, credential revision and occurrence
time. No upstream response body, query, URL or credential is copied.

## Collection and retention

Migration `085_admin_notifications.sql` creates independent incident/event tables.
No triggers or changes are made to provider dispatch, billing or identity tables.
The Admin/combined listener starts an asynchronous collector every 30 seconds;
the Public listener does not construct or run it. Collection failures are caught,
logged without credentials, and displayed separately from the existing list.
They are not readiness dependencies.

Each batch reads at most 100 completed balance/limit failures whose **start time
is within the last seven days**, oldest completion first. The first run also
imports those recent historical failures; an old failure is not proof of a
current outage. Long collector outages or a backlog older than seven days are
outside this first source's capture window. The UI reports the last successful
collection time; `ready` means a batch completed, not that the entire backlog is
drained. No upstream request is sent, including when opening/refreshing the page.

A transaction-level advisory lock serializes collectors across replicas. Unique
provider-call IDs deduplicate persisted source events, including after restart
or late source commits. One non-closed incident per supplier + credential revision
+ error code merges repetitions. Other errors and circuit expiry do not remove
the incident. Collected incidents and timeline records have no automatic deletion.
The list and timeline use bounded 50-record keyset pages.

## Handling and traceability

- **待处理 → 已确认** records that an operator has taken ownership.
- **待处理/已确认 → 已关闭** requires a non-empty handling explanation.
- Repeated failures keep adding evidence to a confirmed but non-closed incident.
- A failure newly collected after closure creates a new incident rather than
  silently rewriting the closed history. During initial backlog import this may
  be historical evidence; always inspect the occurrence timestamp.
- Retrying an already-completed state action is idempotent and does not duplicate
  the audit event. Closing an incident does not reset a circuit, mutate a supplier
  credential, charge a customer or prove that service/balance has recovered.
- Shared Admin Token operations are attributed to `admin-token`, not an invented
  named person. Do not place secrets in the free-text handling explanation.

The JustOne platform overview/detail also shows its latest balance/limit error
with a link to this center. That transient indicator follows current provider
state; the center retains history independently until an operator closes it.

## API

All routes use the existing Admin Token header:

- `GET /internal/v1/admin/notifications?status=active&category=all&before=...`
- `GET /internal/v1/admin/notifications/:id?before=...`
- `POST /internal/v1/admin/notifications/:id/actions`
  with `{ "action": "acknowledge" | "close", "reason": "..." }`

Status filters are `active`, `open`, `acknowledged`, `closed`, `all`. Active includes
open and acknowledged incidents. Counts cover all stored incidents; filters apply
to the displayed list. PostgreSQL-less local environments show an explicit unavailable
state. There is no email, webhook, OS push or external message delivery in this release.

Deploy through the existing independent Hub migration/build path. No Launcher,
MX-H2I, VPN, DNS or shared identity rollout is required.
