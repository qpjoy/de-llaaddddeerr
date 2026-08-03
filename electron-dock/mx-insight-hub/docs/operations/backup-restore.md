# Backup and restore

> Target baseline — not yet automated. The current manifests provide one PostgreSQL PVC only; pgBackRest/WAL-G, off-node object storage, CronJobs and restore verification must be implemented before production gate cutover.

## What must be backed up

| Data | Mechanism | RPO target |
| --- | --- | --- |
| Hub PostgreSQL base + WAL | pgBackRest/WAL-G to versioned object storage | 5 minutes |
| Daily logical dump | encrypted `pg_dump -Fc`, off-node | 24 hours |
| K8s manifests/config schema | Git | per change |
| Secrets | external secret manager or encrypted operator escrow | per rotation |
| Logs/traces | ELK/OpenSearch/object retention | diagnostic only |

PVC snapshots are useful for fast local recovery but are not the only backup. ELK/OpenSearch cannot reconstruct balances, idempotency records or API-key state.

Night-All data and Hub data have separate backup owners and restore drills. Restoring one does not silently rewind the other.

## Restore order

1. Create a new isolated namespace/database target.
2. Restore PostgreSQL base backup and replay WAL to the selected point.
3. Run schema compatibility checks without starting public traffic.
4. Start Admin mode, verify tenants/keys/grants/request and ledger invariants.
5. Compare `unknown` requests with Night-All audit evidence and reconcile explicitly.
6. Start public mode behind a temporary internal route and run non-billable smoke.
7. Move the gateway route only after evidence is recorded.

## Required drills

- monthly logical restore into a clean database;
- quarterly PITR rehearsal and measured RTO;
- API-key digest/pepper recovery validation without printing plaintext keys;
- reconciliation check proving credits and immutable entries balance;
- restore evidence stored outside the recovered cluster.
