#!/usr/bin/env bash
# mx-base lifecycle: shared platform services.
#
# Today that is Jenkins. The hard constraint (docs/adr/0001) is that nothing
# here may become a runtime dependency of mx-test-framework: `down` on this
# project must not stop a single test from running.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K8S_DIR="${ROOT_DIR}/deploy/k8s/internal"
NAMESPACE="mx-base"
IMAGE="${MX_BASE_JENKINS_IMAGE:-mx-base-jenkins:latest}"

say() { printf '[mx-base] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }
kube() { kubectl -n "$NAMESPACE" "$@"; }

usage() {
  cat <<'EOF'
mx-base —— 共享平台设施（目前是 Jenkins）

  bash scripts/manage.sh deploy     # 镜像 -> 配置 -> Jenkins -> 等就绪
  bash scripts/manage.sh status
  bash scripts/manage.sh logs
  bash scripts/manage.sh password   # 打印 admin 密码
  bash scripts/manage.sh agent-cmd  # 打印把一台机器接成静态 agent 的命令
  bash scripts/manage.sh down       # 停服务，保留 PVC 与 Secret

配置读 .env.internal（保持 0600 权限）。必填：无。
可选：
  JENKINS_ADMIN_PASSWORD  不设则首次部署自动生成，之后从 Secret 读回
  JENKINS_URL             不设则用 http://<节点 IP>:30880

Jenkins 只做「构建产物」和「外部触发」。测试的调度、报告与历史在
mx-test-framework —— 日常工作在那边，这里只在排查构建问题时打开。
EOF
}

load_env() {
  local file="${ROOT_DIR}/.env.internal"
  if [ -f "$file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

node_ip() {
  kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true
}

# Read the existing password back rather than rotating it on every deploy: a new
# password on each redeploy would lock out anyone who wrote the old one down.
resolve_secrets() {
  JENKINS_ADMIN_PASSWORD="${JENKINS_ADMIN_PASSWORD:-$(kube get secret mx-base-secrets \
    -o 'jsonpath={.data.JENKINS_ADMIN_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)}"
  if [ -z "${JENKINS_ADMIN_PASSWORD:-}" ]; then
    need openssl
    JENKINS_ADMIN_PASSWORD="$(openssl rand -hex 20)"
    say "generated an admin password (read it back with: manage.sh password)"
  fi
  export JENKINS_ADMIN_PASSWORD

  if [ -z "${JENKINS_URL:-}" ]; then
    local ip
    ip="$(node_ip)"
    [ -n "$ip" ] || die "cannot determine a node IP; set JENKINS_URL in .env.internal"
    JENKINS_URL="http://${ip}:30880/"
  fi
  export JENKINS_URL
}

cmd_deploy() {
  need kubectl
  need docker
  load_env
  kubectl apply -f "${K8S_DIR}/00-namespace.yaml" >/dev/null
  resolve_secrets

  say "building ${IMAGE}"
  docker build -t "$IMAGE" "${ROOT_DIR}/jenkins"

  # Passed on stdin, never as arguments: kubectl's argv is visible to every
  # other process on the host.
  kubectl create secret generic mx-base-secrets --namespace "$NAMESPACE" \
    --from-env-file=/dev/stdin --dry-run=client -o yaml <<EOF | kubectl apply -f - >/dev/null
JENKINS_ADMIN_PASSWORD=${JENKINS_ADMIN_PASSWORD}
EOF
  kubectl create configmap mx-base-jenkins-config --namespace "$NAMESPACE" \
    --from-literal=JENKINS_URL="${JENKINS_URL}" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl create configmap mx-base-jenkins-casc --namespace "$NAMESPACE" \
    --from-file=casc.yaml="${ROOT_DIR}/jenkins/casc.yaml" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  say "configuration reconciled"

  kubectl apply -f "${K8S_DIR}/05-rbac.yaml" >/dev/null
  kubectl apply -f "${K8S_DIR}/10-home-pvc.yaml" >/dev/null

  # JCasC is mounted from a ConfigMap, and changing a ConfigMap does not restart
  # anything. Stamping its checksum onto the pod template is what makes an
  # edited casc.yaml actually take effect on the next deploy.
  local checksum
  checksum="$(cksum "${ROOT_DIR}/jenkins/casc.yaml" | awk '{print $1}')"
  sed "s/REPLACED_BY_MANAGE_SH/${checksum}/" "${K8S_DIR}/30-jenkins.yaml" \
    | kubectl apply -f - >/dev/null

  say "waiting for Jenkins (first boot installs nothing but is still slow)"
  kube rollout status deployment/mx-base-jenkins --timeout=600s
  say "Jenkins： ${JENKINS_URL}   admin / $(cmd_password)"
  say "日常测试工作不在这里 —— 请开 mx-test-framework 后台。"
}

cmd_password() {
  load_env
  kube get secret mx-base-secrets -o 'jsonpath={.data.JENKINS_ADMIN_PASSWORD}' 2>/dev/null \
    | base64 -d 2>/dev/null || die "no secret yet; run deploy first"
}

# Windows and macOS builds cannot run in a Linux container, so they need a
# static agent. This is the only long-lived agent and the only part of mx-base
# that someone has to maintain by hand.
cmd_agent_cmd() {
  load_env
  local ip
  ip="$(node_ip)"
  cat <<EOF

把一台 Windows / macOS 机器接成构建 agent：

  1. Jenkins 里新建节点：${JENKINS_URL:-http://${ip}:30880/}computer/new
     名字例如 win-build，Launch method 选 "Launch agent by connecting it to the controller"
  2. 在那台机器上装 JDK 21，然后运行页面上给出的命令，形如：

     java -jar agent.jar -url http://${ip}:30880/ -secret <SECRET> -name win-build -workDir C:\\jenkins

  3. 给节点打标签 windows，Jenkinsfile 里用 agent { label 'windows' }

注意：**构建 agent 不是测试执行机**。跑 Electron 测试的机器接的是 MXT：
  npx mxt-runner enroll --server http://<MXT 地址>:30879 --code <后台生成的接入码>
两者可以是同一台物理机，但是两个不同的进程、两套不同的凭据。

EOF
}

cmd_status() { load_env; kube get pods,svc,pvc -o wide; }
cmd_logs()   { load_env; kube logs deployment/mx-base-jenkins --tail="${2:-200}" -f; }
cmd_down() {
  load_env
  say "scaling to zero (PVC, Secret and build history are kept)"
  kube scale deployment/mx-base-jenkins --replicas=0 >/dev/null
  say "down. mx-test-framework is unaffected — it does not depend on this."
}

case "${1:-}" in
  deploy)     cmd_deploy ;;
  password)   cmd_password ;;
  agent-cmd)  cmd_agent_cmd ;;
  status)     cmd_status ;;
  logs)       cmd_logs "$@" ;;
  down)       cmd_down ;;
  ""|-h|--help|help) usage ;;
  *) die "unknown command: $1" ;;
esac
