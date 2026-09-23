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
state. Hub sends no email or OS push. The one outbound channel is the Feishu
bot delivery for supplier balance incidents described below; ledger-derived
incidents stay in this center.

Deploy through the existing independent Hub migration/build path. No Launcher,
MX-H2I, VPN, DNS or shared identity rollout is required.

## Supplier balance monitor (2026-09-17)

Migration `090_supplier_balance_monitor.sql` adds independent policies, account
observations and policy audit records. The Admin/combined listener owns the
monitor; the Public listener never constructs or starts it. No customer wallet,
dispatch, billing, circuit, identity or readiness state is changed by a probe.

| Provider | Read-only contract | Currency | Warning / critical |
| --- | --- | --- | --- |
| JustOne | `GET https://api.justoneapi.com/user/get-balance`, `code=0`, `data.balance`, `data.currency=CNY` | CNY | strictly below 5 / 3 |
| TikHub | `GET https://api.tikhub.io/api/v1/tikhub/user/get_user_info`, `code=200`, `user_data.balance` | USD | strictly below 5 / 3 |

Contracts were adapted from the user-supplied `/tmp/fee_monitor/monitor.py`.
A read-only `--dry-run` on 2026-09-17 confirmed JustOne's balance/currency shape;
TikHub's local script key was missing, so its live response remains unverified
in this environment. Never combine TikHub `free_credit` with cash or invent an
exchange rate. This monitors account balances, not supplier tariff changes;
the existing reviewed procurement price books continue to own endpoint prices.

Balance checks default to **every half hour (:00 and :30), Asia/Shanghai** (48 balance
reads per provider per day), independent of server timezone. Migration `109` adds
per-provider balance and reminder schedules. The application uses **Croner 10.0.1**
to parse Cron and wake at the exact next persisted PostgreSQL deadline; there is
no system crontab. A Croner reconciliation job at seconds :00/:30 notices changes
on other replicas and retries transient failures; ordinary execution does not wait
for that scan. A five-minute dispatch grace window applies. Older missed
slots after downtime are skipped. Initial deployment and saving/enabling a policy
wait for the next slot. Each slot is consumed atomically before network I/O,
so errors, crashes, expired leases and credential rotation cannot retry it.
A database lease admits one probe per provider across replicas; settings changes
invalidate in-flight results. Probes are bounded to 30 seconds / 64 KiB, reject redirects and use fixed
origins. Existing Hub database/environment credentials are resolved at probe
time; TikHub uses its existing System Proxy binding. No secrets or webhook URLs
are copied from `/tmp` or stored in observations. Ordinary monitoring reads never return webhook URLs;
the explicit reauthenticated reveal described below is the only exception.

Read-only does not mean free. As of 2026-09-17, the reviewed public documentation
does not explicitly confirm whether these specific account queries incur charges:
[TikHub account endpoint](https://docs.tikhub.io/186826050e0) describes the response
but no price; [JustOne's usage guide](https://docs.justoneapi.com/zh/usage) describes
general success billing and directs users to the dashboard for endpoint prices.
Do not apply the generic business-API rate to account queries or claim they are
free without endpoint-specific evidence. The default introduced by migration `108_balance_schedule_and_reminders.sql`
raises scheduled balance reads from 24 to 48 per provider per day (2026-09-23),
so a new low balance is detected at the next half-hour slot (up to 30 minutes,
plus scheduler/network delay during normal operation). The configurable schedules
in migration `109` may change that frequency. Saving does not trigger an extra
off-schedule supplier read.
The standalone `/tmp/fee_monitor` script is superseded by this monitor plus the
Feishu delivery below. Do not run it alongside Hub: it would add independent
supplier requests and double-post to the same group.

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
  `warningThreshold`, `criticalThreshold`, `expectedRevision`, optional `feishuWebhook`
  plus optional `balanceSchedule` and `feishuSchedule`. Both accept
  `{ mode: 'cron', expression: '*/30 * * * *' }` or
  `{ mode: 'interval', minutes: 45 }` (integer 1–1440). Omitted fields preserve
  their stored values. The list DTO returns both schedules, plus `schedule`
  as the balance schedule with `timeZone: 'Asia/Shanghai'`.
  Legacy `feishuReminderMinutes` remains accepted as a rolling interval, but cannot
  be combined with `feishuSchedule` in the same request.
- `POST /internal/v1/admin/supplier-balances/:provider/feishu-webhook/reveal` —
  requires the Admin Token header plus a freshly entered `{ adminToken }` body.
  Returns `{ provider, feishuWebhook }` with `Cache-Control: no-store`; Launcher
  sessions, tenant sessions and Public API keys cannot reveal it. Records only
  `action: feishu_webhook_revealed`, provider and revision in the settings audit.

Deploy migrations `108` and `109` before the Hub server/frontend. They preserve thresholds,
hooks, incident history, delivery timestamps, credentials and paused state. Future
hourly slots are pulled forward when needed, while due slots and leases stay intact.
No Launcher/MX-H2I deployment or identity/network configuration change is required.
Upgrade maps existing `feishuReminderMinutes` into the same rolling interval and
backfills `next_reminder_at` from `notified_at`; it does not silently realign existing
reminders. Deploy all Admin replicas together: old binaries do not understand custom
schedules and must not keep running beside the new scheduler after operator edits.

### Cron and simple controls

The two editors independently configure balance checks and **repeat** Feishu alerts.
They share parsing and future-run calculations with the server:

| Simple configuration | Cron / mode | Meaning (Beijing time) |
| --- | --- | --- |
| Every 30 minutes, aligned | `*/30 * * * *` | :00 and :30 |
| Every two hours, aligned | `0 */2 * * *` | 00:00, 02:00, ... |
| Every day at 09:00 | `0 9 * * *` | 09:00 every day |
| Weekdays at 09:00 and 18:00 | `0 9,18 * * MON-FRI` | Retained as custom Cron |
| Exactly every 45 minutes | `{ mode: 'interval', minutes: 45 }` | Uniform duration from its anchor |

Changing a simple aligned interval/daily control updates Cron. Entering a recognized
Cron updates the simple controls; complex Cron stays intact. `*/45 * * * *` means
:00/:45, alternating 45- and 15-minute gaps, so it must not be labelled “every 45 minutes”.
Nonrepresentable aligned intervals fall back explicitly to true interval mode.
An existing rolling interval has its own anchor and cannot be converted to aligned
Cron without changing meaning; the UI makes that switch explicit. Balance interval
anchors start on schedule save, survive restart, and advance from their previous
deadline rather than completion time. Reminder intervals start at successful delivery.

Only five-field Cron is accepted (minute/hour/day/month/weekday); numeric fields,
English month/weekday names, lists, ranges and steps are supported. Seconds, nicknames
and extended calendar modifiers are rejected. Day-of-month and weekday use standard
Cron OR semantics. Impossible dates are rejected before saving. The editor shows
the next three times; interval previews are examples from the current time, while
the balance card's next-check value is the persisted execution deadline.

Croner uses in-process timers. Event-loop stalls, database/network delays, stopped
processes and host clock skew can delay execution/delivery; this is not a hard
real-time guarantee. Database claims consume balance slots before I/O. Reminder
claims recheck current policy/state and use leases; only successful bot replies
advance the persisted next reminder. Do not claim exactly-once external delivery
across a crash after Feishu accepted a message but before the DB commit.

Library reference: [Croner configuration](https://croner.56k.guru/usage/configuration/)
and [Croner patterns](https://croner.56k.guru/usage/pattern/).

## Feishu delivery (2026-09-18)

Migration `098_feishu_balance_alerts.sql` adds delivery state and `notified` /
`notify_failed` timeline events. `server/notifications-feishu.mjs` ports the
reviewed standalone script's rules, with state in PostgreSQL rather than its
`state.json`, so reminders survive restarts and are not duplicated by a replica:

- A new `supplier_balance_low` incident is delivered on the next pass (≤30s).
- While it stays open, repeat reminders follow that provider's `feishuSchedule`.
  Calendar schedules use the next fixed slot; intervals are measured from the last
  confirmed delivery. Local edits re-arm the deadline immediately; other replicas
  pick up changes within 30 seconds, with no restart. Delivery timestamps are not
  reset. Shortening a rolling interval may make an incident immediately due;
  changing Cron begins at the next future slot. Calendar reminders missed by more
  than five minutes are skipped; a failed send inside the grace window retries
  on the next reconciliation without consuming the slot.
- Escalation from warning to critical is delivered immediately; a de-escalation
  back to warning waits out the window.
- Recovery closes the incident. A later drop is a new incident and alerts at once
  rather than inheriting a cooldown.
- Only a bot reply of `code: 0` starts the cooldown. An HTTP error, a rejection,
  an oversized or non-JSON body and a timeout are all retried on the next pass.
  A persistently broken hook records one `notify_failed` per hour, not one per
  pass.

## Unreadable balances and recovery (2026-09-18)

Migration `100_probe_failure_and_recovery_alerts.sql` closes two gaps that both
ended in silence.

**A monitor that cannot read a balance now says so.** A failed probe used to
record an error code and stop there, so an expired credential or a broken egress
left the card stale and nobody was told. A failed probe now opens a
`supplier_balance_unreadable` incident (`supplier.cost`, warning), delivered by
the same notifier under the same rules. It opens on the **second consecutive**
failure, not the first: one blip is noise, two in a row means the monitor has
stopped protecting anything. The previous attempt's error code on the monitor row
provides that, so no counter column exists to drift. The message names the error
code and the last successful read, and never renders an unknown balance as a
number. A low-balance incident stays open independently -- a failed probe still
cannot prove recovery.

Any successful read closes the unreadable incident, including after the
credential was replaced, so it closes by provider rather than by credential scope.

**Recovery is announced.** Closing a balance or probe incident records
`recovered_at`, and the notifier delivers one recovery message. Two guards keep
it honest: only an incident whose problem was actually delivered
(`notified_at IS NOT NULL`) produces a recovery, so the group is never told that
something it never heard about has cleared; and only a monitor-recorded recovery
counts, because a manual closure in this center leaves `recovered_at` null.
`recovery_notified_at` makes it exactly once. A balance recovery quotes the
restored balance; a probe recovery claims nothing about the balance, only that
reads work again.

When both recoveries for one provider are pending in the same pass, only the
balance message is sent: a restored balance already proves reads work, so two
messages would describe one event. The probe recovery is marked delivered and
recorded as `notify_merged`, which is what keeps it from resurfacing as a second
message on a later pass. A probe recovery with no balance recovery behind it is
still delivered on its own.

The new timeline kinds (`probe_failed`, `probe_recovered`, `notify_merged`)
appear in the incident detail alongside `notified` / `notify_failed`.

Each provider has its own bot in the shared group. The hook is **operator policy
on the balance monitor row, not deployment environment**: migration
`099_balance_feishu_webhook.sql` adds the column and seeds the two groups that
the standalone script already notified, so the first deploy is not silent, and
`PUT /internal/v1/admin/supplier-balances/:provider` accepts a `feishuWebhook`
field. The notifier re-reads the column on every pass, so an edit in 外部数据平台
takes effect on the next pass without restarting or redeploying anything. Only
the Admin listener delivers; Public never does, because two senders would
double-post. Both bots are keyword-gated on `额度`, which is why the first message
line carries it.

`feishuWebhook` is optional on save. Omitting it leaves the stored hook alone.
The console keeps the revealed address separate from the edit field, so an ordinary
threshold or reminder save cannot echo a stale hook back. An explicit empty string clears it and stops
notifying that group. A malformed value is rejected with `invalid_feishu_webhook`
and never reaches the row.

**Providers are fully isolated**: a missing, invalid or unreachable hook for one
platform never stops the other's alert and never consumes its reminder window;
the blocked platform records a `notify_failed` event instead of going silent. An
unset hook leaves that platform's alerts in this center only.

A hook is secret-bearing. It is stored in the Hub database like other
UI-managed source credentials, and is never logged or returned by ordinary reads,
never copied into an observation and never written to the settings audit trail --
that records `unchanged` / `set:<tail>` / `cleared`. The monitoring DTO exposes
only `feishu.configured` plus a six-character tail, enough to tell two bots apart.
The explicit reveal is visible only in its transient modal and is cleared when
the modal closes; neither the revealed hook nor the reauthentication input is
persisted in browser storage.
Because the seeds live in a tracked migration, treat the seeded hooks as
published to anyone with repository access; rotate the bot in Feishu and save the
new hook in the console if that matters. Delivery is not a readiness dependency
and cannot change dispatch, billing, MX-H2I login or networking.

Migration `097` aligns JustOne's warning line with the original script's 5 CNY
and keeps a 3 CNY critical tier, matching TikHub's existing 5/3 USD shape.
Future platforms add a reviewed adapter in `balance-adapters.mjs`, a credential
resolver/egress binding and a seeded policy; the scheduler, persistence and
notification lifecycle are shared. Never allow an arbitrary query URL from UI.
