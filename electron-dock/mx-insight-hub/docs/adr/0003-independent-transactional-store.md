# ADR-0003: independent transactional store

Status: accepted.

Hub uses an independent logical PostgreSQL database and product role for
transactional state and the current mutable request/reservation/usage evidence.
An append-only commercial credit/billing ledger remains a later gate. In
Internal K8s the database is provisioned inside the shared `mx-common`
PostgreSQL instance; the instance is shared, the database/role/credentials and
ownership are not. Hub does not use Night-All’s PostgreSQL for customer state
and does not place high-frequency request/usage rows in Launcher’s generic
JSONB platform table.

Redis is optional acceleration, never the source of truth for balances or idempotency. BI/OpenSearch projections are rebuildable consumers, not authoritative stores.
