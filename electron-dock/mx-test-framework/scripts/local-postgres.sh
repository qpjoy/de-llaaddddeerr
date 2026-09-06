#!/usr/bin/env bash
# The platform on the host, against a real PostgreSQL in Docker.
#
# Between `manage.sh dev` (memory, no database) and `manage.sh local up`
# (everything in containers). It exists for the case that produced it: a machine
# with almost no room left on C:, where rebuilding the server image is the
# expensive part and PostgreSQL is the part worth having.
#
# It also runs the code in the working tree directly, so an edit is one restart
# away rather than one image build away.
#
#   bash scripts/local-postgres.sh
#
# `--preserve-symlinks` is needed because @qpjoy/mx-common is a file: dependency
# resolved through a symlink, and `pg` is installed here rather than there. In
# the container everything is installed side by side and the flag is not needed.
set -euo pipefail
cd "$(dirname "$0")/.."

export MXT_PG_PORT="${MXT_PG_PORT:-55500}"
export MXT_DATABASE_URL="${MXT_DATABASE_URL:-postgres://mxtest:local-dev-only@127.0.0.1:${MXT_PG_PORT}/mxt_local}"
export MXT_STORE=postgres
export MXT_ADMIN_TOKEN="${MXT_ADMIN_TOKEN:-local-admin-change-me}"
export MXT_PORT="${MXT_PORT:-8790}"
export MXT_ARTIFACTS_DIR="${MXT_ARTIFACTS_DIR:-E:/mxt-runner/platform-artifacts}"
# Plain HTTP on loopback: the session cookie cannot carry Secure here.
export MXT_INSECURE_COOKIES=true

mkdir -p "$MXT_ARTIFACTS_DIR"
docker compose -f deploy/compose/docker-compose.yml up -d postgres

echo "[local] waiting for postgres on ${MXT_PG_PORT}"
until docker exec mx-test-framework-postgres-1 pg_isready -U mxtest >/dev/null 2>&1; do sleep 1; done

# Migrations run *in the container*, always. Running them from a Windows host
# records CRLF checksums that the container then rejects — see migrations/README.md.
docker exec mx-test-framework-postgres-1 psql -U mxtest -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='mxt_local'" | grep -q 1 ||
  docker exec mx-test-framework-postgres-1 psql -U mxtest -d postgres -c "CREATE DATABASE mxt_local OWNER mxtest"
docker compose -f deploy/compose/docker-compose.yml run --rm \
  -e MXT_DATABASE_URL="postgres://mxtest:local-dev-only@postgres:5432/mxt_local" migrate

echo "[local] http://127.0.0.1:${MXT_PORT}  （密码就是 MXT_ADMIN_TOKEN）"
exec node --preserve-symlinks server/index.mjs
