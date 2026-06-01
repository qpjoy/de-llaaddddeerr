# electron-server REST API

Stable across Phase 4. Versioned at `/api/v1/`. JSON in / JSON out. No auth
in Phase 4 (everything served is public). Phase 5 adds bearer-token routes.

All responses include CORS headers (`Access-Control-Allow-Origin: *`) so the
desktop host's renderer can fetch them directly.

## `GET /healthz`

Liveness probe.

```json
{ "ok": true, "ts": "2026-05-14T12:00:00.000Z" }
```

## `GET /api/v1/version.json`

Small, frequently-polled "what's the state of the world" payload.

```json
{
  "release": "2026-05-14-bootstrap",
  "minClientRelease": null,
  "marketSpecVersion": 1,
  "supportedSpecRange": ">=1 <=1",
  "migrationsHead": 1,
  "manifestEtag": "sha256:9f...e2",
  "publishedAt": "2026-05-14T00:00:00.000Z"
}
```

Field meanings:

- `release` — opaque monotonic tag the server bumps on every published change.
- `minClientRelease` — clients older than this get an "upgrade nag" hint. Null = no minimum.
- `marketSpecVersion` — bumped when the plugin manifest schema (`qpjoyPlugin.specVersion`) changes shape.
- `supportedSpecRange` — semver range of plugin manifest specs this server can serve.
- `migrationsHead` — highest schema migration version available; clients with a lower local head pull deltas.
- `manifestEtag` — ETag of the marketplace index; clients compare and skip re-download when unchanged.

`cache-control: public, max-age=30` — clients should poll at most every ~30s.

## `GET /api/v1/marketplace/index.json`

The full plugin catalog. Supports `If-None-Match` for ETag conditional fetch.

```json
{
  "generatedAt": "2026-05-14T00:00:00.000Z",
  "release": "2026-05-14-bootstrap",
  "entries": [
    {
      "id": "qpjoy.electron-tunnel",
      "npm": "@qpjoy/electron-plugin-tunnel",
      "name": "QPJoy Tunnel",
      "description": "...",
      "latestVersion": "0.1.3",
      "manifestUrl": "...",
      "tarballUrl": "...",
      "homepage": "...",
      "author": "qpjoy",
      "category": "network",
      "verified": true,
      "bootstrap": true,
      "visibility": "public",
      "specVersion": 1,
      "metadata": null
    }
  ]
}
```

The field names are byte-for-byte identical to `@qpjoy/marketplace-db`'s
`MarketplaceEntry`. The host's `RemoteSyncJob` writes them straight into
SQLite without translation.

## `GET /api/v1/plugins/:id`

Full plugin detail — versions list + latest manifest + screenshots, etc.

```jsonc
{
  "id": "qpjoy.electron-tunnel",
  "npm": "@qpjoy/electron-plugin-tunnel",
  "name": "...",
  // ...all index fields...
  "versions": [
    {
      "version": "0.1.3",
      "changelog": null,
      "releasedAt": "2026-05-01T10:00:00Z",
      "minHostVersion": null,
      "maxHostVersion": null,
      "deprecated": false,
      "yanked": false,
      "manifestChecksum": "sha256:...",
      "tarballChecksum": "sha1:...",
      "tarballUrl": "https://registry.npmjs.org/.../-/electron-plugin-tunnel-0.1.3.tgz"
    }
  ],
  "latestManifest": { /* the actual plugin.manifest.json */ },
  "extra": null
}
```

Used by the plugin detail page in the admin UI.

## `GET /api/v1/migrations`

Lightweight list of every schema migration the server has — used by clients
to figure out what to fetch when their `migrationsHead` is behind.

```json
[
  { "version": 1, "name": "initial schema", "checksum": "sha256:..." },
  { "version": 2, "name": "add audit_logs", "checksum": "sha256:..." }
]
```

## `GET /api/v1/migrations/:version`

Single migration body. The client applies it through
`@qpjoy/marketplace-db`'s `Migrator.register()` then `Migrator.up()`.

```json
{
  "version": 2,
  "name": "add audit_logs",
  "checksum": "sha256:...",
  "up": "CREATE TABLE audit_logs (...);",
  "down": "DROP TABLE audit_logs;"
}
```

`cache-control: public, max-age=300` — once published, migrations never
mutate. (Re-publishing a different body under the same version is
a server bug and will trip the client's checksum drift detection.)

## `POST /api/v1/games/:gameId/scores`

Authenticated. Submits one completed game score for the logged-in marketplace
user. For `suduku`, the server keeps the best score per user and mode.

```json
{
  "pluginId": "qpjoy.electron-game-suduku",
  "mode": "9x9",
  "score": 1180,
  "elapsedSeconds": 18,
  "completedAt": "2026-05-18T00:00:00.000Z"
}
```

## `POST /api/v1/updates/check`

Desktop hosts call this when `serverBaseUrl` is configured. The request carries
the stable `installId`, platform/arch, app + market versions, capabilities, and
installed plugin states. The server evaluates active release plans and returns
only actions the client cohort should see.

```json
{
  "serverTime": "2026-06-01T00:00:00.000Z",
  "subject": "4b7c...",
  "actions": [
    {
      "actionId": "plan-id:0.1.34",
      "planId": "plan-id",
      "targetKind": "plugin",
      "targetId": "qpjoy.electron-plugin-hdo",
      "pluginId": "qpjoy.electron-plugin-hdo",
      "npm": "@qpjoy/electron-plugin-hdo",
      "fromVersion": "0.1.33",
      "toVersion": "0.1.34",
      "mode": "auto",
      "restartPolicy": "plugin",
      "channel": "canary",
      "tarballUrl": "https://registry.npmjs.org/...",
      "autoGrant": "manifest",
      "autoActivate": true,
      "force": false
    }
  ]
}
```

## `POST /api/v1/updates/report`

Clients report `seen`, `applied`, `failed`, `skipped`,
`restart_required`, or `awaiting_grant` for each returned action. Reports are
stored server-side and shown in the admin release page.

## `GET /api/v1/games/:gameId/leaderboard?mode=9x9&limit=20`

Returns the server high-score ranking. With `DATABASE_URL` set, the backing
store is Postgres.

```json
{
  "source": "remote-postgres",
  "gameId": "suduku",
  "mode": "9x9",
  "rows": [
    {
      "rank": 1,
      "userId": "…",
      "playerName": "Joy",
      "bestScore": 1180,
      "bestTime": 18,
      "rounds": 3
    }
  ]
}
```

## Sync flow (client side)

1. `GET /api/v1/version.json` (cheap, every interval).
2. If `version.migrationsHead > localHead`:
   - For each `v` in `localHead+1..migrationsHead`: `GET /api/v1/migrations/:v`, register + `up()`.
3. If `version.manifestEtag !== local.cachedEtag`:
   - `GET /api/v1/marketplace/index.json` (with `If-None-Match: <local.cachedEtag>`).
   - On 200: `bulkUpsertEntries`. On 304: no-op.
4. Persist `version.release` and the new etag.
5. Update `remote_sync` row (success/failure).

## Errors

All errors are `4xx` or `5xx` with body `{ "error": "..." }`. Clients should
not crash on any error; the host falls back to its local DB cache.
