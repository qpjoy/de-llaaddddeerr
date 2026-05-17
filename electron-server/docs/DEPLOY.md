# Deployment

Two flavors covered today:

1. **Bare metal / VPS**: single Node process, file-backed storage, daily npm sync via cron.
2. **Docker**: same code, persistent volume for `/app/data`, optional reverse proxy.

Postgres is supported via `DATABASE_URL` (see `docs/SCHEMA.md` for the
schema blueprint); the storage adapter swap is mechanical and lands when
the first multi-instance deployment shows up.

## 1. Bare metal

```bash
# Initial setup
git clone …
cd electron-server
pnpm install --frozen-lockfile=false
pnpm build

# Bootstrap an admin
JWT_SECRET=$(openssl rand -hex 48) pnpm admin:bootstrap -- \
  --username root --password 'change-me-later'

# Manual one-off sync
pnpm sync:npm
```

### systemd unit

```ini
# /etc/systemd/system/qpjoy-market.service
[Unit]
Description=QPJoy Plugin Marketplace
After=network.target

[Service]
User=qpjoy
WorkingDirectory=/opt/qpjoy-market/electron-server
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=HOST=127.0.0.1
EnvironmentFile=/etc/qpjoy/market.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/qpjoy/market.env`:

```
JWT_SECRET=<openssl rand -hex 48>
NPM_SCOPE=@qpjoy
NPM_PREFIX=electron-
REQUIRE_VERIFICATION=0
```

### nginx in front

```nginx
server {
  listen 443 ssl http2;
  server_name market.qpjoy.dev;

  ssl_certificate     /etc/letsencrypt/live/market.qpjoy.dev/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/market.qpjoy.dev/privkey.pem;

  # Rate limit login attempts (declared in nginx.conf):
  #   limit_req_zone $binary_remote_addr zone=market_login:10m rate=5r/s;

  location /api/v1/auth/login {
    limit_req zone=market_login burst=10 nodelay;
    proxy_pass http://127.0.0.1:8080;
    include /etc/nginx/snippets/proxy-headers.conf;
  }

  location / {
    proxy_pass http://127.0.0.1:8080;
    include /etc/nginx/snippets/proxy-headers.conf;
  }
}
```

### Daily sync cron

```cron
# /etc/cron.d/qpjoy-market-sync
17 4 * * *  qpjoy  cd /opt/qpjoy-market/electron-server && /usr/bin/pnpm sync:npm >> /var/log/qpjoy/sync.log 2>&1
```

## 2. Docker

```bash
docker build -t qpjoy/market-server .

docker run -d --name qpjoy-market \
  -e JWT_SECRET="$(openssl rand -hex 48)" \
  -e NODE_ENV=production \
  -e PORT=8080 \
  -p 127.0.0.1:8080:8080 \
  -v /srv/qpjoy/market-data:/app/data \
  qpjoy/market-server
```

The data volume persists `version.json`, `marketplace-index.json`, the
`plugins/` snapshots, and the auth JSON files (`auth/users.json`,
`auth/refresh.json`, etc.). Treat it like state — back it up.

## 3. Required env vars

| Var | Purpose | Default |
| --- | --- | --- |
| `PORT` | listen port | `8080` |
| `HOST` | listen address | `0.0.0.0` |
| `JWT_SECRET` | HS256 secret. **Set in prod.** | dev: generated to `data/.jwt-secret` |
| `NPM_REGISTRY` | upstream npm index | `https://registry.npmjs.org` |
| `NPM_SCOPE` | scope to scan | `@qpjoy` |
| `NPM_PREFIX` | name prefix filter | `electron-` |
| `REQUIRE_VERIFICATION` | enforce email/SMS code on register | `0` (dev), set `1` in prod |
| `NODE_ENV` | pretty logger off when `production` | unset |
| `DATABASE_URL` | switch to Postgres backend; runs migrations at boot | unset → JSON file backend |
| `PG_POOL_MAX` | pg pool size | `8` |
| `SPA_DIST` | path to admin-ui dist served at `/admin/*` | `data/spa-dist` locally, `/app/spa-dist` in Docker |
| `SYNC_ENABLED` | run the in-process npm sync scheduler | `1` |
| `SYNC_ON_BOOT` | trigger one sync ~3s after server start | `1` |
| `SYNC_INTERVAL_MS` | interval between scheduled syncs (min 60s, default 1h) | `3600000` |
| `SYNC_JITTER_MS` | ± randomness on the interval to spread fleet load | `30000` |

### In-container sync scheduler

The server runs its own scheduler — **no system cron needed**. It:

- waits ~3s after boot, runs the first sync (gated by `SYNC_ON_BOOT`)
- loops on `SYNC_INTERVAL_MS ± SYNC_JITTER_MS`
- holds a process-local mutex so two runs never overlap
- writes each result into `audit_logs` (`action = system.sync` or `system.sync.fail`)
- admin can poll status via `GET /api/v1/admin/sync` and force a run via `POST /api/v1/admin/sync`

Common overrides:

```
# disable entirely (offline dev)
SYNC_ENABLED=0

# tight loop for testing
SYNC_INTERVAL_MS=120000 SYNC_JITTER_MS=5000

# never auto-run on boot
SYNC_ON_BOOT=0
```

The 1-h default is conservative; npm package metadata doesn't change
often enough to warrant more.

## 4. Health + readiness

- `GET /healthz` → 200 always (process is up)
- Future: `GET /readyz` → 200 only after data load (Phase 6)

## 5. Migrations

Phase 5 ships the SQLite migration v1 to clients but doesn't run any
Postgres migrations server-side (no Postgres yet). The blueprint files at
`db/migrations/00*.sql` are ready to be applied by your migration tool of
choice when you switch.
