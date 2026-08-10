# Backup and restore

> Target baseline — not yet automated. The Hub has a dedicated database/role in
> the shared `mx-common` PostgreSQL instance; backup ownership is therefore a
> coordinated `mx-common` operation, not a Hub-local PVC. pgBackRest/WAL-G,
> off-node object storage, CronJobs and per-product restore verification must be
> implemented before production gate cutover.

## What must be backed up

| Data | Mechanism | RPO target |
| --- | --- | --- |
| Hub PostgreSQL base + WAL | pgBackRest/WAL-G to versioned object storage | 5 minutes |
| Daily logical dump | encrypted `pg_dump -Fc`, off-node | 24 hours |
| K8s manifests/config schema | Git | per change |
| Secrets | external secret manager or encrypted operator escrow | per rotation |
| Logs/traces | ELK/OpenSearch/object retention | diagnostic only |

Shared PostgreSQL PVC snapshots are useful for fast instance recovery but are
not a per-product logical restore plan and cannot be the only backup.
Elasticsearch cannot reconstruct balances, idempotency records or API-key
state.

Night-All data and Hub data have separate backup owners and restore drills. Restoring one does not silently rewind the other.

`MX_INSIGHT_API_KEY_PEPPER` and `MX_INSIGHT_PROVIDER_MASTER_KEY` are restore
dependencies, not ordinary regeneratable configuration. A database dump without
the pepper cannot validate existing API keys; a dump without the provider
master key cannot decrypt registered source passwords. Keep both in independent
encrypted escrow/external secret management, and never write plaintext values
into backup logs or manifests.

## Restore order

1. Create a new isolated namespace/database target.
2. Restore PostgreSQL base backup and replay WAL to the selected point.
3. Run schema compatibility checks without starting public traffic.
4. Restore the original API-key pepper and provider master key into the isolated
   Admin/ingest workloads (not the public listener); test decryptability through
   a redacted provider connection test.
5. Start Admin mode, verify tenants/keys/grants/request and ledger invariants.
6. Compare `unknown` requests with Night-All audit evidence and reconcile explicitly.
7. Start public mode behind a temporary internal route and run non-billable smoke.
8. Move the gateway route only after evidence is recorded.

## Required drills

- monthly logical restore into a clean database;
- quarterly PITR rehearsal and measured RTO;
- API-key digest/pepper recovery validation without printing plaintext keys;
- provider-envelope/master-key recovery and read-only connection validation
  without printing a source password or driver connection string;
- reconciliation check proving credits and immutable entries balance;
- restore evidence stored outside the recovered cluster.
