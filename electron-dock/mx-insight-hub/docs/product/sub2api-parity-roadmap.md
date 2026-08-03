# Sub2API parity and roadmap

The supplied Sub2API dashboard is used as an information-architecture reference, not a data-model or visual clone. MX Insight applies those operational patterns to data products instead of model channels.

## Mapping

| Sub2API concept | MX Insight concept |
| --- | --- |
| User / account | Tenant member / consumer application |
| API key | Consumer API key, one-time secret |
| Group / subscription | Versioned plan and subscription |
| Channel / model | Platform + capability + dataset |
| Token usage | Request, record, byte, agent-token and credit usage dimensions |
| Account balance | Customer credit account; separate from provider quota |
| Usage record | Idempotent mutable request/usage evidence now; immutable credit ledger later |
| Channel status | Night-All capability readiness and circuit state |

## MVP admin capabilities

- dashboard totals, request state, usage, latency and platform distribution;
- consumer creation and status;
- API-key issue/revoke with plaintext shown once;
- explicit platform enable/disable and per-platform request/page limits;
- usage filtering and runtime dependency health.

## Production backlog

1. Human login, role binding and audit trail through Launcher IAM.
2. Key rotation overlap, expiry, last-used metadata and IP/CIDR restrictions.
3. Versioned plans, subscriptions, credit ledger, coupons/recharge and invoice export.
4. Multi-dimensional quotas: requests, records, bytes, concurrency, jobs and Agent tokens.
5. Async job API and webhook delivery with signing/replay protection.
6. Dataset/field-level grants, retention policy and export approval.
7. Provider-cost reconciliation without exposing providers to customers.
8. BI catalog, semantic metrics, dashboards and Agent workbench.

The Admin UI must label operational `usage units` separately from model `tokens`. A record count is not a currency until a versioned price book defines it.

## Current capacity boundary

The MVP list endpoints are intentionally unpaginated and dashboard/usage aggregates query the transactional request table. Before production-scale Sub2API parity, add cursor pagination, maximum usage windows, `(tenant_id, consumer_id, created_at)` indexes, and hourly/materialized usage projections. Do not expose this build as an unbounded high-cardinality customer control plane.
