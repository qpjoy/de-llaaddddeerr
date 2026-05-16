# electron-server

QPJoy plugin marketplace — server side.

This is the upstream service that `@qpjoy/electron-market` clients sync from.
It is intentionally separate from the host workspace because its deployment
cadence is decoupled from the desktop app.

## Status

- 🟡 **Phase 2 (in progress)**: skeleton + Postgres schema being defined alongside the client-side `@qpjoy/marketplace-db`.
- ⚪ **Phase 4 (later)**: REST API + CDN JSON publishing + npm sync job.
- ⚪ **Phase 5 (later)**: auth (email + password / SMS / username), JWT.
- ⚪ **Phase 6 (later)**: server-side admin UI (reuses `electron-market/packages/admin-ui` Vue code).

See `electron-market/docs/ROADMAP.md` for the full plan.

## Planned layout

```
electron-server/
├─ src/
│  ├─ index.ts              # Fastify entry
│  ├─ api/
│  │  ├─ v1/
│  │  │  ├─ marketplace.ts  # GET /api/v1/marketplace/index
│  │  │  ├─ plugins.ts      # GET /api/v1/plugins/:id
│  │  │  ├─ migrations.ts   # GET /api/v1/migrations/:version.sql
│  │  │  ├─ auth.ts         # POST /api/v1/auth/login
│  │  │  └─ admin.ts        # admin routes (protected)
│  │  └─ version.ts         # GET /api/v1/version.json
│  ├─ db/
│  │  ├─ pool.ts            # postgres pool
│  │  └─ migrations/        # *.sql files for postgres
│  ├─ jobs/
│  │  └─ sync-npm.ts        # daily cron: scan @qpjoy/electron-*
│  └─ services/
│     ├─ marketplace.ts
│     └─ auth.ts
├─ scripts/
│  ├─ deploy.sh
│  └─ run-migration.ts
└─ docs/
   ├─ API.md
   ├─ SCHEMA.md
   └─ DEPLOY.md
```

## Schema parity with the client

The client (`@qpjoy/marketplace-db`, SQLite) and the server (this package, Postgres)
share **concepts** but not migration files. Reasons:

- Client has `installed_plugins`, `plugin_logs` — server doesn't care.
- Server has `users`, `entitlements`, `audit_logs`, `plugin_authors` — client doesn't care.
- SQL dialects differ enough (JSON types, RETURNING, sequences) that one source-of-truth would be a leaky abstraction.

Every concept that crosses the wire (e.g. `marketplace_entries`) **must** keep the field
names identical so the REST DTOs round-trip without translation.

## Configuration sketch

```
PORT=8080
DATABASE_URL=postgres://qpjoy:...@localhost:5432/qpjoy_market
JWT_SECRET=...
CDN_PUBLIC_URL=https://cdn.qpjoy.dev    # left blank during early ip+port phase
NPM_REGISTRY=https://registry.npmjs.org
NPM_SCOPE=@qpjoy
NPM_PREFIX=electron-                     # only sync @qpjoy/electron-*
```
