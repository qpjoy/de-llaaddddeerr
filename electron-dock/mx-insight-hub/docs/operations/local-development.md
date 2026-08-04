# Local development

## Prerequisites

- Docker with Compose;
- Node.js 22 for direct tests and smoke scripts;
- local isolated Night-All on `127.0.0.1:18141` only for live data tests.

## One command

```bash
bash scripts/manage.sh up
```

This builds from the `electron-dock` parent context so the real sibling `mx-launcher/ui-design` package is available, starts PostgreSQL and the combined Hub, runs migrations, bootstraps local records and performs a control-plane smoke.

Endpoints:

- Admin UI/API: `127.0.0.1:18180`
- PostgreSQL: `127.0.0.1:15440`
- one-time local API key: `.runtime/local-api-key`

The bootstrap key grants only `xiaohongshu` and `weibo`. Use the Admin UI to issue or revoke keys and change grants.

## Verification

```bash
bash scripts/manage.sh status
bash scripts/manage.sh smoke
bash scripts/manage.sh data-smoke  # invokes Night-All and may consume provider quota
bash scripts/manage.sh logs
```

Normal smoke validates health and Admin auth but deliberately does not call paid providers. `data-smoke` performs one result search and must be intentional.

## Isolation

The Compose stack has its own PostgreSQL volume and never mounts the Night-All source directory or database. It calls Night-All only over its documented HTTP facade. Stopping Hub does not stop or mutate host Night-All.

## Optional search development stack

The Elasticsearch/Kibana sample is independent and is not required for the current Hub API:

```bash
cp deploy/compose/search/.env.example deploy/compose/search/.env
bash scripts/manage.sh search plan
bash scripts/manage.sh search up
bash scripts/manage.sh search status
```

It binds only to loopback and must not be treated as a production deployment. See [Search and observability stack](search-and-observability-stack.md).

## When a Night-All snapshot is actually needed

Do not migrate production data for contract, schema or static architecture work. When real history is needed for parser/quality/UI verification, use Night-All's existing custom-format snapshot and `docker/manage.sh restore-snapshot` into a new Compose project/state directory/port. That workflow disables provider credentials and schedulers by default and refuses to overwrite an existing candidate. Never copy production Redis, and treat the PG dump as secret-bearing because the current Night-All credential tables may contain plaintext provider secrets.

After the server-side snapshot archive has been checksum-verified and safely extracted, the local restore command is:

```bash
cd /Users/qpjoy/workspace/mingxi/Night-All
export NIGHTALL_COMPOSE_PROJECT_NAME=nightall-internal-snapshot
export NIGHTALL_DOCKER_STATE_DIR=/Users/qpjoy/workspace/mingxi/.nightall-runtime/nightall-internal-snapshot
export NIGHTALL_DOCKER_PORT=18143
./docker/manage.sh restore-snapshot /absolute/path/to/extracted-snapshot
```

Use a fresh project, empty state directory and port other than protected `18141/18142`. Keep provider credentials disabled unless one explicitly approved sandbox call is needed. The full export, checksum, transfer, source-revision and restore procedure remains authoritative in Night-All `specs/DEPLOYMENT_DATA_AND_OPERATIONS.md`.
