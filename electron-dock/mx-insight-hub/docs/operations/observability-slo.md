# Observability and SLO

> Target baseline — not yet wired. The service currently emits process logs and health endpoints; metrics exporters, traces, ELK/OpenSearch persistence, alert rules and SLO burn-rate checks remain implementation work.

## Signals

- request rate, outcome and latency by public operation/platform/status;
- idempotent replay, conflict and `unknown` counts;
- reserved/committed/released units and reconciliation age;
- Night-All dependency latency/circuit state without provider credential labels;
- PostgreSQL connections, transaction latency, locks, storage and backup age;
- Admin key issuance/revocation/grant-change audit events;
- queue/job saturation when async fan-out is introduced.

Never label metrics with full API keys, query text, user-entered URLs or unrestricted tenant names. Use internal IDs and bounded platform/capability labels.

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
