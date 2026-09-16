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
cumulative spending limit. Neither is a Hub customer's wallet alert. These
ledger-derived incidents remain distinct from the numeric balance monitor added
on 2026-09-17 below; the earlier absence of a verified balance contract no longer
applies to JustOne's reviewed `user/get-balance` endpoint.

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
state. There is no email, webhook, OS push or external message delivery from Hub.

Deploy through the existing independent Hub migration/build path. No Launcher,
MX-H2I, VPN, DNS or shared identity rollout is required.

## Supplier balance monitor (2026-09-17)

Migration `090_supplier_balance_monitor.sql` adds independent policies, account
observations and policy audit records. The Admin/combined listener owns the
monitor; the Public listener never constructs or starts it. No customer wallet,
dispatch, billing, circuit, identity or readiness state is changed by a probe.

| Provider | Read-only contract | Currency | Warning / critical |
| --- | --- | --- | --- |
| JustOne | `GET https://api.justoneapi.com/user/get-balance`, `code=0`, `data.balance`, `data.currency=CNY` | CNY | strictly below 30 / 20 |
| TikHub | `GET https://api.tikhub.io/api/v1/tikhub/user/get_user_info`, `code=200`, `user_data.balance` | USD | strictly below 5 / 3 |

Contracts were adapted from the user-supplied `/tmp/fee_monitor/monitor.py`.
A read-only `--dry-run` on 2026-09-17 confirmed JustOne's balance/currency shape;
TikHub's local script key was missing, so its live response remains unverified
in this environment. Never combine TikHub `free_credit` with cash or invent an
exchange rate. This monitors account balances, not supplier tariff changes;
the existing reviewed procurement price books continue to own endpoint prices.

The schedule is fixed at **10:00 and 22:00 Asia/Shanghai every day** (two balance
reads per provider per day), independent of server timezone. PostgreSQL calculates
the next wall-clock slot; this is not a rolling 12-hour interval. The scheduler
scans every 60 seconds with a five-minute dispatch grace window. Older missed
slots after downtime are skipped. Initial deployment and saving/enabling a policy
wait for the next slot. Each slot is consumed atomically before network I/O,
so errors, crashes, expired leases and credential rotation cannot retry it.
A database lease admits one probe per provider across replicas; settings changes
invalidate in-flight results. Probes are bounded to 30 seconds / 64 KiB, reject redirects and use fixed
origins. Existing Hub database/environment credentials are resolved at probe
time; TikHub uses its existing System Proxy binding. No secrets or webhook URLs
are copied from `/tmp`, stored in observations, or returned by the monitoring API.

Read-only does not mean free. As of 2026-09-17, the reviewed public documentation
does not explicitly confirm whether these specific account queries incur charges:
[TikHub account endpoint](https://docs.tikhub.io/186826050e0) describes the response
but no price; [JustOne's usage guide](https://docs.justoneapi.com/zh/usage) describes
general success billing and directs users to the dashboard for endpoint prices.
Do not apply the generic business-API rate to account queries or claim they are
free without endpoint-specific evidence. The twice-daily schedule reduces
scheduled balance reads from the original 48 to 2 per provider per day; it can
delay a new low-balance alert until the next 10:00/22:00 check (up to 12 hours
during normal operation). Policy changes do not schedule extra reads.
The standalone Feishu script has its own schedule and, if running alongside Hub,
adds independent supplier requests.

The external-platform overview and detail show the latest balance, currency,
thresholds and successful observation time. UI refresh reads cached Hub state
only. Failed probes preserve the last successful balance for the same credential
scope; results older than 24 hours or followed by failure are marked
stale. Credential rotation hides the previous account's balance pending a new
successful query. Missing keys and unexpected responses remain unknown, never 0.

`supplier.cost` incidents merge low observations for one provider/credential
scope. A warning becoming critical reopens an acknowledged incident for attention.
Successful balance recovery to the warning threshold or above records a separate
`balance_recovered` event and `recovered_at`, then closes the active incident.
Failure, timeout, pause and a new credential cannot prove recovery. Manual closure
retains its existing meaning; another low observation creates a new incident.
Each monitoring event links to a persisted observation and the thresholds used.

Admin Token only:

- `GET /internal/v1/admin/supplier-balances` — cached observations/settings only.
- `PUT /internal/v1/admin/supplier-balances/:provider` — `enabled`,
  `warningThreshold`, `criticalThreshold`, `expectedRevision`. The schedule is fixed.

The existing Python Feishu notifications remain independent, with their original
thresholds/cooldown. Hub neither starts that script nor sends duplicate Feishu
messages; changing a Hub threshold does not reconfigure the standalone script.
Future platforms add a reviewed adapter in `balance-adapters.mjs`, a credential
resolver/egress binding and a seeded policy; the scheduler, persistence and
notification lifecycle are shared. Never allow an arbitrary query URL from UI.
