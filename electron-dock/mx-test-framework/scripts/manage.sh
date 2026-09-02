#!/usr/bin/env bash
# MX Test Framework lifecycle.
#
# One entry point for local development and for the Internal Kubernetes
# deployment. `deploy` is idempotent: running it again reconciles.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_DOCK_DIR="$(cd "${ROOT_DIR}/.." && pwd)"
K8S_DIR="${ROOT_DIR}/deploy/k8s/internal"
COMPOSE_FILE="${ROOT_DIR}/deploy/compose/docker-compose.yml"
NAMESPACE="mx-test-framework"
IMAGE="${MXT_IMAGE:-mx-test-framework:latest}"

say() { printf '[mx-test-framework] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

usage() {
  cat <<'EOF'
MX Test Framework lifecycle

Local:
  bash scripts/manage.sh local up|down|logs      # docker compose: server + postgres
  bash scripts/manage.sh dev                     # in-memory server, no database
  bash scripts/manage.sh test                    # unit + API tests

Internal Kubernetes:
  bash scripts/manage.sh deploy                  # image -> migrate -> server -> smoke
  bash scripts/manage.sh migrate                 # run migrations only
  bash scripts/manage.sh verify                  # end-to-end smoke against the deployment
  bash scripts/manage.sh seed                    # 灌入示例数据，让新装的平台不是空的
  bash scripts/manage.sh status
  bash scripts/manage.sh logs [server|migrate]
  bash scripts/manage.sh clean                   # expired artifacts + finished runner Jobs
  bash scripts/manage.sh down                    # scale to zero; keeps PVC, Secret, database

Configuration is read from .env.internal when present (keep it mode 0600).
Required there: MXT_ADMIN_TOKEN —— 就这一个。

数据库默认由 deploy 自己拉起（namespace 内独立的 PostgreSQL，独立磁盘，
不与 mx-insight-hub 共实例），密码自动生成并留在 Secret 里。
Optional:
  MXT_DATABASE_URL —— 设了就改用外部实例，deploy 不再自建数据库。
  MXT_LAUNCHER_URL —— 设了才能用 mx-launcher 账号登录；不设时只能用
                      admin token 当密码登录。
  MXT_GIT_TOKEN    —— 被测仓库是私有库时用它 clone。
  MXT_PUBLIC_URL   —— 通知消息里的链接地址（例如 http://<内网 IP>:30879）。
                      不设时告警不带链接，其余功能不受影响。

密钥库的加密密钥（MXT_SECRET_KEY）首次部署自动生成，之后从 Secret 读回。
它加密的是被测应用的测试账号口令；因为每晚的 pg_dump 会进 OSS，
明文存库等于把口令放进对象存储。

`down` never deletes the PVC, the Secret or the database. Removing data is a
separate, explicit act.
EOF
}

load_env() {
  local file="${ROOT_DIR}/.env.internal"
  if [ -f "$file" ]; then
    # Operator-owned file, not untrusted input.
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

compose() {
  need docker
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    need docker-compose
    docker-compose -f "$COMPOSE_FILE" "$@"
  fi
}

kube() { kubectl -n "$NAMESPACE" "$@"; }

require_admin_token() {
  [ -n "${MXT_ADMIN_TOKEN:-}" ] || die "MXT_ADMIN_TOKEN is required (set it in .env.internal)"
}

# Whether this deployment brings its own database.
#
# Default: yes. MXT must not share a PostgreSQL instance with mx-insight-hub —
# its write-then-bulk-delete cycle would spend that instance's vacuum budget and
# connection slots on test data. See deploy/k8s/internal/15-postgres.yaml.
#
# Setting MXT_DATABASE_URL opts out and points the platform at whatever you
# name, which is how you would attach a managed instance later.
#
# The answer is recorded once, in its own variable, because `resolve_database`
# goes on to *set* MXT_DATABASE_URL when it decides to self-host. Testing the
# same variable later then reports "external", and `deploy_database` silently
# skips — leaving the migration Job to fail with `EAI_AGAIN` on a hostname that
# was never going to resolve because nothing ever created it.
MXT_OWNS_DATABASE=""
MXT_IMAGE_ID=""

decide_database_ownership() {
  MXT_OWNS_DATABASE=$([ -z "${MXT_DATABASE_URL:-}" ] && echo yes || echo no)
}

owns_database() { [ "$MXT_OWNS_DATABASE" = "yes" ]; }

# The generated password is read back from the live Secret on every redeploy, so
# a second `deploy` does not rotate the credential out from under a running
# database that still expects the old one.
resolve_database() {
  require_admin_token
  # Decide before touching MXT_DATABASE_URL, for the reason above.
  decide_database_ownership
  owns_database || { say "using the external database in MXT_DATABASE_URL"; return; }

  MXT_POSTGRES_PASSWORD=$(kube get secret mx-test-framework-secrets \
    -o "jsonpath={.data.MXT_POSTGRES_PASSWORD}" 2>/dev/null | base64 -d 2>/dev/null || true)
  if [ -z "${MXT_POSTGRES_PASSWORD:-}" ]; then
    need openssl
    MXT_POSTGRES_PASSWORD=$(openssl rand -hex 24)
    say "generated a password for the bundled database"
  fi
  export MXT_POSTGRES_PASSWORD
  export MXT_DATABASE_URL="postgres://mxt:${MXT_POSTGRES_PASSWORD}@mx-test-framework-postgres:5432/mx_test"
}

# Encryption key for the credential store. Read back rather than regenerated:
# a new key on every deploy would leave every stored password undecryptable,
# and the failure would surface as tests mysteriously failing to sign in.
resolve_secret_key() {
  if [ -z "${MXT_SECRET_KEY:-}" ]; then
    MXT_SECRET_KEY="$(kube get secret mx-test-framework-secrets \
      -o 'jsonpath={.data.MXT_SECRET_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  fi
  if [ -z "${MXT_SECRET_KEY:-}" ]; then
    need openssl
    MXT_SECRET_KEY="$(openssl rand -hex 32)"
    say "generated an encryption key for the credential store"
  fi
  export MXT_SECRET_KEY
}

deploy_database() {
  owns_database || return 0
  say "applying the bundled PostgreSQL"
  kubectl apply -f "${K8S_DIR}/15-postgres.yaml" >/dev/null
  say "waiting for the database"
  # `rollout status` on a StatefulSet waits for the readiness probe, which is
  # pg_isready — so this returns when the database can actually accept the
  # migration, not merely when the pod is scheduled.
  if ! kube rollout status statefulset/mx-test-framework-postgres --timeout=180s >/dev/null; then
    kube logs statefulset/mx-test-framework-postgres --tail=50 || true
    die "the bundled database did not become ready"
  fi
  say "database ready"
}

build_image() {
  need docker
  say "building ${IMAGE}"
  # Build context is electron-dock/ so the image can pull in ../mx-common.
  docker build -f "${ROOT_DIR}/Dockerfile" -t "$IMAGE" "$ELECTRON_DOCK_DIR"
}

# base64 with no line wrapping. GNU coreutils wants -w0; BSD/macOS has no such
# flag and never wraps, so the fallback is not a degradation.
b64() { base64 -w0 2>/dev/null || base64; }

apply_secret() {
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  # The manifest is assembled here and piped in, rather than letting `kubectl
  # create secret` read the values.
  #
  # Values must not reach kubectl's argv, which is readable by every other
  # process on the host — that rules out `--from-literal`. The obvious
  # alternative, `--from-env-file=/dev/stdin`, is a Unix-only path: kubectl on
  # Windows is a native binary and cannot open Git Bash's /dev/stdin, so the
  # deploy failed there with `error reading /proc/self/fd/0` and then
  # `no objects passed to apply`.
  #
  # `kubectl apply -f -` reads stdin on every platform, so building the YAML is
  # both portable and keeps the values off the command line.
  {
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: mx-test-framework-secrets\n  namespace: %s\ntype: Opaque\ndata:\n' "$NAMESPACE"
    for name in MXT_DATABASE_URL MXT_ADMIN_TOKEN MXT_LAUNCHER_URL \
                MXT_POSTGRES_PASSWORD MXT_GIT_TOKEN MXT_PUBLIC_URL MXT_SECRET_KEY; do
      # Indirect expansion: read the variable this loop is naming.
      eval "value=\${$name:-}"
      # Quoted: an unset variable would otherwise emit a bare `KEY:`, which YAML
      # reads as null rather than as the empty string, and kubectl rejects a
      # null in a Secret's data map.
      printf '  %s: "%s"\n' "$name" "$(printf '%s' "$value" | b64)"
    done
  } | kubectl apply -f - >/dev/null
  say "secret reconciled"
}

# Make the Pod template change when the image content changes.
#
# The image is always tagged `:latest`, so a rebuild leaves the Deployment's Pod
# template byte-identical. `kubectl apply` then correctly does nothing, no new
# ReplicaSet is created, and `rollout status` reports "successfully rolled out"
# — about the pods that were already running. The deploy prints `verify passed`
# having tested the *previous* build.
#
# That is the worst failure mode available to a deploy script: it is silent, it
# is green, and it makes every subsequent code change appear not to work. It was
# found by noticing a pod whose start time predated the image it supposedly ran.
#
# Stamping the image ID onto the template makes the rollout honest: identical
# image, no-op patch, no restart; different image, real rolling update. The
# annotation survives later `kubectl apply -k` runs because it was never part of
# the applied configuration, so apply's three-way merge leaves it alone.
stamp_image_id() {
  MXT_IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
  [ -n "$MXT_IMAGE_ID" ] || { say "WARNING: 读不到镜像 ID，无法确认新代码已上线"; return 0; }
  kube patch deployment/mx-test-framework -p     "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"mxt.qpjoy/image-id\":\"${MXT_IMAGE_ID}\"}}}}}"     >/dev/null
}

# The check that makes the stamp worth having: what is *running* must be the
# image that was just built. Without it the stamp is another thing that could
# quietly stop working, and the symptom would again be a green deploy of old
# code.
assert_running_image() {
  [ -n "${MXT_IMAGE_ID:-}" ] || return 0
  local running
  running="$(kube get pods -l app.kubernetes.io/name=mx-test-framework     -o jsonpath='{.items[*].status.containerStatuses[*].imageID}' 2>/dev/null || true)"
  case "$running" in
    *"${MXT_IMAGE_ID#sha256:}"*) return 0 ;;
  esac
  die "部署报告成功，但运行中的镜像不是刚构建的那个。
  已构建：${MXT_IMAGE_ID}
  运行中：${running:-<读不到>}"
}

wait_for_migration() {
  say "waiting for migrations"
  if ! kube wait --for=condition=complete job/mx-test-framework-migrate --timeout=180s >/dev/null; then
    kube logs job/mx-test-framework-migrate --tail=50 || true
    die "migration job did not complete"
  fi
  say "migrations applied"
}

# The address a person can open, for the link inside a notification. Derived
# from the node and the NodePort when not set, because an operator who has to
# remember one more variable will forget it, and the failure mode — alerts that
# arrive with no link — is invisible until someone is trying to act on one.
# The address that goes into notification links.
#
# It is derived, not guessed, and then *checked*: a link nobody can open is
# worse than no link, because it turns a working alert into a support question.
#
# The node's InternalIP is the right answer on the Internal server, where it is
# the LAN address. It is the wrong answer on Docker Desktop, where the node
# lives inside a VM and 192.168.65.x is unreachable from the very desktop that
# just ran the deploy. So each candidate is probed, in order of how widely the
# resulting link would work, and the first one that answers wins.
probe_url() { curl -fsS -o /dev/null -m 4 "$1/readyz" 2>/dev/null; }

resolve_public_url() {
  [ -z "${MXT_PUBLIC_URL:-}" ] || return 0
  local port node_ip candidate
  port="$(kube get service mx-test-framework-external -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || echo 30879)"
  node_ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"

  for candidate in ${node_ip:+"http://${node_ip}:${port}"} "http://127.0.0.1:${port}"; do
    probe_url "$candidate" || continue
    export MXT_PUBLIC_URL="$candidate"
    say "notification links will point at ${MXT_PUBLIC_URL}"
    case "$candidate" in
      http://127.0.0.1:*)
        say "WARNING: 只有本机能打开这个地址。内网部署时请在 .env.internal 里"
        say "         显式设置 MXT_PUBLIC_URL=http://<内网 IP>:${port}"
        ;;
    esac
    return 0
  done

  # Nothing answered — on a first deploy the Service does not exist yet, which
  # is expected rather than an error. Fall back to the derived address and say
  # so, instead of silently shipping links to a host that never replied.
  if [ -n "$node_ip" ]; then
    export MXT_PUBLIC_URL="http://${node_ip}:${port}"
    say "notification links will point at ${MXT_PUBLIC_URL} (未验证可达)"
  else
    say "WARNING: 无法推导 MXT_PUBLIC_URL，通知消息将不带链接"
  fi
}

cmd_deploy() {
  need kubectl
  load_env
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  resolve_database
  resolve_secret_key
  resolve_public_url
  build_image
  apply_secret
  deploy_database

  # The migration Job is immutable once created; delete it so a redeploy runs
  # the new image instead of silently reusing the previous run's result.
  kube delete job mx-test-framework-migrate --ignore-not-found >/dev/null 2>&1 || true

  say "applying manifests"
  kubectl apply -k "$K8S_DIR" >/dev/null
  stamp_image_id
  wait_for_migration

  say "waiting for the server"
  kube rollout status deployment/mx-test-framework --timeout=180s
  assert_running_image
  cmd_verify

  # Tell the operator where to actually point a browser. Without this the
  # deploy succeeds and leaves them to work out the address themselves.
  #
  # Reuse the address `resolve_public_url` already probed rather than deriving
  # it a second time: two derivations of the same thing drift, and this one
  # drifted the useful way round — the deploy printed a node IP that the very
  # machine running it could not open, right after the notification code had
  # correctly rejected that same address.
  if [ -n "${MXT_PUBLIC_URL:-}" ]; then
    say "界面： ${MXT_PUBLIC_URL}  （账号随便填，密码用 MXT_ADMIN_TOKEN）"
  else
    say "界面：kubectl -n ${NAMESPACE} port-forward service/mx-test-framework 8790:80"
  fi
}

cmd_migrate() {
  need kubectl
  load_env
  resolve_database
  apply_secret
  kube delete job mx-test-framework-migrate --ignore-not-found >/dev/null 2>&1 || true
  kubectl apply -f "${K8S_DIR}/20-migration-job.yaml" >/dev/null
  wait_for_migration
}

# End-to-end smoke: register an app, a suite and a catalog, create a task, run
# it, claim it as a runner, submit a summary, and read the result back. This is
# the P0 exit criterion, executed against the real deployment.
cmd_verify() {
  need kubectl
  need curl
  load_env
  require_admin_token

  local port="${MXT_VERIFY_PORT:-18790}"
  kube port-forward service/mx-test-framework "${port}:80" >/dev/null 2>&1 &
  local forward_pid=$!
  # The pid is expanded into the trap now, not read from the variable later:
  # `local` is out of scope by the time a RETURN trap fires, and under `set -u`
  # that turns a successful deploy into `forward_pid: unbound variable` after
  # every check has already passed.
  trap "kill $forward_pid 2>/dev/null || true" RETURN

  local base="http://127.0.0.1:${port}"
  # Wait for the tunnel to actually carry a request, rather than sleeping a
  # fixed three seconds and hoping.
  #
  # `deploy` runs this immediately after a rolling update, and `kubectl
  # port-forward` picks one pod out of the Service's endpoints — which, for a
  # few seconds, still includes the one being terminated. The forward then
  # dies mid-check and every assertion fails with `SocketError: other side
  # closed`, on a deployment that is in fact healthy. It looked like a real
  # failure twice before the pattern was visible.
  local attempt=0
  until probe_url "$base"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 20 ]; then
      die "端口转发起不来：${base} 一直没有响应"
    fi
    # A forward bound to a pod that then went away stays open and useless, so
    # replace it rather than waiting on it.
    if ! kill -0 "$forward_pid" 2>/dev/null; then
      kube port-forward service/mx-test-framework "${port}:80" >/dev/null 2>&1 &
      forward_pid=$!
      trap "kill $forward_pid 2>/dev/null || true" RETURN
    fi
    sleep 2
  done
  local suffix
  suffix="$(date +%s)"

  MXT_BASE_URL="$base" MXT_ADMIN_TOKEN="$MXT_ADMIN_TOKEN" MXT_VERIFY_SUFFIX="$suffix" \
    node "${ROOT_DIR}/scripts/verify.mjs"
}

cmd_seed() {
  need node
  load_env
  require_admin_token
  local port="${MXT_VERIFY_PORT:-18790}"
  kube port-forward service/mx-test-framework "${port}:80" >/dev/null 2>&1 &
  local forward_pid=$!
  # The pid is expanded into the trap now, not read from the variable later:
  # `local` is out of scope by the time a RETURN trap fires, and under `set -u`
  # that turns a successful deploy into `forward_pid: unbound variable` after
  # every check has already passed.
  trap "kill $forward_pid 2>/dev/null || true" RETURN
  sleep 3
  MXT_BASE_URL="http://127.0.0.1:${port}" MXT_ADMIN_TOKEN="$MXT_ADMIN_TOKEN" \
    node "${ROOT_DIR}/scripts/seed.mjs"
}

cmd_clean() {
  need kubectl
  load_env
  local days="${MXT_ARTIFACT_RETAIN_DAYS:-30}"
  say "removing artifact directories older than ${days} days"
  kube exec deployment/mx-test-framework -- \
    sh -c "find /data/artifacts/runs -mindepth 1 -maxdepth 1 -type d -mtime +${days} -exec rm -rf {} + 2>/dev/null; true"
  say "removing finished runner Jobs"
  kube delete jobs -l app.kubernetes.io/component=runner \
    --field-selector status.successful=1 --ignore-not-found >/dev/null 2>&1 || true

  # Every `deploy` rebuilds mx-test-framework:latest, which leaves the previous
  # image untagged. Those <none> layers are invisible in `docker images` output
  # but are the single largest thing this project accumulates on the host.
  if command -v docker >/dev/null 2>&1; then
    say "pruning dangling images and build cache"
    docker image prune -f >/dev/null 2>&1 || true
    docker builder prune -f >/dev/null 2>&1 || true
  fi

  say "clean complete (run records are kept; only bytes were removed)"
  if command -v docker >/dev/null 2>&1; then
    docker system df 2>/dev/null | sed 's/^/[mx-test-framework] /' || true
  fi
}

cmd_status() {
  need kubectl
  kube get deployment,pod,pvc,job -o wide || true
}

cmd_logs() {
  need kubectl
  case "${1:-server}" in
    migrate) kube logs job/mx-test-framework-migrate --tail=200 ;;
    *) kube logs deployment/mx-test-framework --tail=200 -f ;;
  esac
}

cmd_down() {
  need kubectl
  say "scaling to zero; PVC, Secret and database are preserved"
  kube scale deployment/mx-test-framework --replicas=0
}

cmd_dev() {
  need node
  # The design system ships its CSS from a generated dist/, which is absent in a
  # fresh checkout; without this the UI renders unstyled with no error anywhere.
  node "${ELECTRON_DOCK_DIR}/mx-launcher/ui-design/scripts/build.mjs" >/dev/null
  say "starting in-memory server on :${MXT_PORT:-8790} (no database, no persistence)"
  say "登录：账号随便填，密码用 MXT_ADMIN_TOKEN（默认 local-admin-change-me）"
  MXT_STORE=memory \
  MXT_PORT="${MXT_PORT:-8790}" \
  MXT_ADMIN_TOKEN="${MXT_ADMIN_TOKEN:-local-admin-change-me}" \
  MXT_INSECURE_COOKIES=true \
  MXT_ARTIFACTS_DIR="${ROOT_DIR}/.runtime/artifacts" \
    node "${ROOT_DIR}/server/index.mjs"
}

cmd_test() {
  need node
  cd "$ROOT_DIR"
  node --test tests/*.test.mjs
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  deploy) cmd_deploy "$@" ;;
  migrate) cmd_migrate "$@" ;;
  verify) cmd_verify "$@" ;;
  seed) cmd_seed "$@" ;;
  clean) cmd_clean "$@" ;;
  status) cmd_status "$@" ;;
  logs) cmd_logs "$@" ;;
  down) cmd_down "$@" ;;
  dev) cmd_dev "$@" ;;
  test) cmd_test "$@" ;;
  local)
    case "${1:-up}" in
      up) compose up -d --build ;;
      down) compose down ;;
      logs) compose logs -f ;;
      *) usage; exit 1 ;;
    esac
    ;;
  help | -h | --help) usage ;;
  *) usage; exit 1 ;;
esac
