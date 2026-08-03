# ADR-0003: independent transactional store

Status: accepted.

Hub uses an independent PostgreSQL and append-only usage/credit evidence. It does not use Night-All’s PostgreSQL for customer state and does not place high-frequency ledger rows in Launcher’s generic JSONB platform table.

Redis is optional acceleration, never the source of truth for balances or idempotency. BI/OpenSearch projections are rebuildable consumers, not authoritative stores.

