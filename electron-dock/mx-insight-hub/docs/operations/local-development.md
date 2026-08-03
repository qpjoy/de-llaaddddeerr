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
