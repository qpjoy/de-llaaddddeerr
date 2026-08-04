# Local search stack

This is an opt-in local/controlled-development Elasticsearch and Kibana stack for MX Insight Hub. It is not part of the default Hub lifecycle and it is not wired to the API yet.

```bash
cp .env.example .env
docker compose config
docker compose up -d
docker compose ps
```

From the MX Insight Hub root, the same independent lifecycle is available as:

```bash
bash scripts/manage.sh search plan
bash scripts/manage.sh search up
bash scripts/manage.sh search status
bash scripts/manage.sh search logs
bash scripts/manage.sh search down
```

Endpoints bind to loopback by default:

- Elasticsearch: `http://127.0.0.1:19200`
- Kibana: `http://127.0.0.1:15601`

The setup container installs a content projection template, a log data-stream template/ILM policy, and a local filesystem snapshot repository. It does not create or populate a business index.

Do not attach an existing Elasticsearch 8.13.4 data directory to the 9.x sample. Production requires authentication/TLS, reviewed storage and snapshots, resource sizing, network policy, and a supported upgrade or clean reindex plan.

See `../../../docs/operations/search-and-observability-stack.md` for the architecture and production boundaries.
