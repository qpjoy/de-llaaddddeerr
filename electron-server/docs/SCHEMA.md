# Schema & storage backend

Phase 5/6 ships **two interchangeable storage backends**:

| Backend | Triggered by | Files / tables |
| --- | --- | --- |
| **JSON** | `DATABASE_URL` unset (default in dev) | `data/auth/*.json` |
| **Postgres** | `DATABASE_URL` set, e.g. `postgres://qpjoy:…@host/db` | `users`, `refresh_tokens`, `entitlements`, `verification_codes`, `audit_logs` |

Both implement the same async interface in `src/data/storage-types.ts`, so
route + service code is byte-identical across backends.

## Postgres bring-up

1. Create the database:
   ```sql
   CREATE DATABASE qpjoy_market;
   CREATE USER qpjoy WITH PASSWORD '…';
   GRANT ALL PRIVILEGES ON DATABASE qpjoy_market TO qpjoy;
   ```
2. Export `DATABASE_URL=postgres://qpjoy:…@localhost:5432/qpjoy_market`.
3. Start the server (`pnpm dev` or the systemd unit). Migrations run on
   first boot — you'll see `[pg] migration <N> (<name>) applied` lines.
4. Bootstrap an admin (works against either backend):
   ```
   DATABASE_URL=… pnpm admin:bootstrap -- --username root --password 'change-me'
   ```

The migration runner lives at `src/data/pg/pool.ts`. It:
- Auto-creates the `schema_migrations` tracking table.
- Reads `db/migrations/*.sql` in numeric order.
- Hashes each file with sha256, compares against the stored checksum on
  later boots. Drift = error, refuse to migrate (force the developer to
  fix the bad file).

## Migration file naming

```
db/migrations/
├─ 0001_initial.sql        # marketplace catalog tables
├─ 0002_auth.sql           # users + sessions + entitlements + codes
└─ 0003_audit_index.sql    # audit_logs indexes
```

Add new migrations as `0004_…sql`. Never rewrite an applied one — append a
new file that fixes the issue. The runner enforces this with checksum
validation.

## What lives where

| Concept | JSON file | Postgres table | Notes |
| --- | --- | --- | --- |
| Users | `auth/users.json` | `users` | First registration auto-promotes to `admin`. |
| Refresh tokens | `auth/refresh.json` | `refresh_tokens` | Rotated on every refresh. |
| Entitlements | `auth/entitlements.json` | `entitlements` | `kind: free | paid | trial`, optional `expires_at`. |
| Verification codes | `auth/codes.json` | `verification_codes` | TTL 10 min by default. |
| Audit log | `auth/audit.json` | `audit_logs` | Append-only; JSON capped at 5000 rows. |
| Marketplace catalog | `marketplace-index.json` + `plugins/*.json` | not yet | npm sync writes both to disk; either backend can serve them. |

## Migrating JSON → Postgres

A small CLI to copy a developer's JSON state into Postgres can be added
when needed — not shipped in this phase. Pattern: `pnpm data:export-json`
produces a dump, `pnpm data:import-pg` reads it. For now, treat the JSON
data as ephemeral dev state.

## Why we kept marketplace catalog on disk

The npm sync job (`pnpm sync:npm`) writes one JSON per plugin under
`data/plugins/`. That's already an excellent CDN payload: deploy by
copying the directory. Putting it in Postgres adds complexity without
helping the read path. When we add multi-instance write paths
(community submissions, etc.) the catalog moves into pg too — the
storage interface already has a place for it.
