# Observability and SLO

> Target baseline — not yet wired. The service currently emits process logs and health endpoints; metrics exporters, traces, ELK/OpenSearch persistence, alert rules and SLO burn-rate checks remain implementation work.

## Signals

- request rate, outcome and latency by public operation/platform/status;
- idempotent replay, conflict and `unknown` counts;
- reserved/committed/released units and reconciliation age;
- Night-All dependency latency/circuit state without provider credential labels;
- PostgreSQL connections, transaction latency, locks, storage and backup age;
- Admin key issuance/revocation/grant-change audit events;
- source-provider health with bounded machine error code (never host/user/password);
- per-source cursor status/age, last successful run and scheduled-vs-running age;
- import row/ingested/changed/deleted/rejected counts, active-run resume and
  `checkpoint_reset` termination; outcome-unknown batch/finalize/reset errors
  must retain source/run/batch correlation without including page values;
- bounded `source_busy`, `source_lock_lost`, `source_draining`,
  `provider_pause_required` and `provider_topology_changed` conflicts (alert on
  sustained contention/drain, not one expected operator retry);
- durable batch replay count and source-page fingerprint mismatch/
  `pageDrifted` incident count; never emit the page or raw row as a label;
- external-pull/ingest/projector queue depth, lease age, outbox/DLQ lag and
  canonical-to-search projection freshness;
- content current-index reconcile/alias-switch result, chunk pending
  materialization/embedding/projection/deletion and mixed embedding-model alarm.

Never label metrics with full API keys, query text, user-entered URLs or unrestricted tenant names. Use internal IDs and bounded platform/capability labels.

Alert on a failed cursor, a running cursor with no live lease/progress, repeated
schema-probe drift, unresolved rejected rows, unhealthy provider, or projection
lag beyond the dataset SLO. A zero-row idle poll is normal and must not page by
itself. `ingest.rejected_rows.raw_row` may contain business content; it stays in
restricted incident storage and never becomes a metric/log label or Admin
preview payload.

An `external_*_outcome_unknown` is not a normal failed-run terminal state and
must not trigger automated reset. Alert if same-run retry does not resolve it;
the run ID, batch key and stored cursor are the recovery identity. A paused
source whose cursor remains running is expected briefly at a batch boundary but
pages when drain time exceeds the source query/transaction budget.

## Initial SLOs

| Objective | Target |
| --- | --- |
| Public API availability excluding explicit upstream platform outage | 99.9% / 30 days |
| Auth/policy decision p95 | < 50 ms |
| Hub overhead p95 excluding Night-All | < 100 ms |
| Control-plane readiness detection | < 60 s |
| Unknown request reconciliation | 99% < 15 min |
| PITR recovery point | <= 5 min |
| Restore time objective | <= 60 min after infrastructure is available |

## ELK/OpenSearch

Ship structured stdout logs through the shared K8s collector to a persistent index lifecycle: hot 7 days, warm 30 days, archived object storage as policy requires. Add trace IDs across gateway -> Hub -> Night-All. This improves diagnosis and cold log retention but remains separate from transactional backup.

Kibana is an internal engineering/data-quality surface, not the customer BI product. Filebeat/Elastic Agent may tail host/container logs, but `/shared_dir` business files must use the manifest/parser pipeline in [the file-ingestion runbook](shared-directory-ingestion.md); Logstash/Filebeat do not own canonical identity, schema or checkpoint decisions. The opt-in local sample is documented in [Search and observability stack](search-and-observability-stack.md).
