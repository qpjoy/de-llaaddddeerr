#!/usr/bin/env bash
# MX Launcher solution management helper.
#
# This starts as a local control surface for the unified mx-launcher project.
# Future deploy/admin actions should call the same underlying operations so the
# CLI and admin console stay consistent.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

cmd="${1:-menu}"
shift || true

say() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  bash scripts/manage.sh
  bash scripts/manage.sh menu
  bash scripts/manage.sh help
  bash scripts/manage.sh doctor [--role internal|domestic|oversea]
  bash scripts/manage.sh check
  bash scripts/manage.sh ui-design build|pack|demo [port]
  bash scripts/manage.sh desktop-check
  bash scripts/manage.sh desktop-typecheck
  bash scripts/manage.sh server-typecheck
  bash scripts/manage.sh profile internal|domestic|oversea|h-endpoint-dev
  bash scripts/manage.sh smoke platform-kernel
  bash scripts/manage.sh smoke server-http [base-url]
  bash scripts/manage.sh shadow admin-assets|build|up|smoke|logs|down
  bash scripts/manage.sh ops guide
  bash scripts/manage.sh ops doctor
  bash scripts/manage.sh ops config feature-list [feature-key]
  bash scripts/manage.sh ops config feature-set <feature-key> <true|false> [plan-only|readonly-execute|remote-execute|disabled] [global|site|profile] [scope-id]
  bash scripts/manage.sh ops admin dashboard
  bash scripts/manage.sh ops admin actions [token]
  bash scripts/manage.sh ops admin site-slot-pipelines [plan-id]
  bash scripts/manage.sh ops site-slot domestic-plan <domestic-host|-> [oversea-host]
  bash scripts/manage.sh ops site-slot oversea-plan <oversea-host|->
  bash scripts/manage.sh ops site-slot materialize [oversea|domestic|all]
  bash scripts/manage.sh ops site-slot domestic-wg-secret-upsert <site-id> <endpoint>
  bash scripts/manage.sh ops site-slot domestic-wg-materialize <site-id> <endpoint> [rotate]
  bash scripts/manage.sh ops site-slot materialize-domestic-ready <site-id>
  bash scripts/manage.sh ops site-slot internal-service-peer-handoff [status|command|apply] [config-path]
  bash scripts/manage.sh ops site-slot internal-service-peer-host-runner [port]
  bash scripts/manage.sh ops site-slot native-host-runner status|start|install|uninstall [port]
  bash scripts/manage.sh ops site-slot cleanup-v1-wireguard [--apply] [hdo-home hdo-internal ...]
  bash scripts/manage.sh ops site-slot refresh-tunnel-cli [version|--from-local DIR|--from-tarball FILE]
  bash scripts/manage.sh ops site-slot ssh-profiles
  bash scripts/manage.sh ops site-slot ssh-profile-upsert <site-id> <domestic|oversea> [host]
  bash scripts/manage.sh ops site-slot ssh-profile-readiness <profile-id> [plan-only|execute]
  bash scripts/manage.sh ops site-slot oversea-readonly-test <site-id> <host>
  bash scripts/manage.sh ops site-slot oversea-remote-test <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute]
  bash scripts/manage.sh ops site-slot preflight <plan-id> [dry-run|manual|ssh]
  bash scripts/manage.sh ops site-slot apply <plan-id> [manual|dry-run|ssh]
  bash scripts/manage.sh ops site-slot executions [plan-id]
  bash scripts/manage.sh ops site-slot runner-start <run-id> [simulate|remote-ssh|awx-shadow]
  bash scripts/manage.sh ops site-slot runner-sessions [run-id]
  bash scripts/manage.sh ops site-slot worker-job <session-id>
  bash scripts/manage.sh ops site-slot worker-gate <job-id> [confirm]
  bash scripts/manage.sh ops site-slot worker-handoff <job-id> [confirm]
  bash scripts/manage.sh ops site-slot domestic-relay-append-ssh-prepare <apply-run-id> [confirm]
  bash scripts/manage.sh ops site-slot worker-run <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec]
  bash scripts/manage.sh ops site-slot worker-report <job-id> [running|passed|failed|blocked]
  bash scripts/manage.sh ops site-slot rollback-start <report-id> [simulate|manual]
  bash scripts/manage.sh ops site-slot rollback-report <rollback-execution-id> [running|passed|failed|blocked]
  bash scripts/manage.sh ops local-shadow plan|cycle|build|up|status|smoke|logs|down
  bash scripts/manage.sh ops internal-local plan|dry-run|cycle|build|apply|status|port-forward [local-port] [bind-address]|gate|gate-manual|manual-evidence|smoke|logs|db-summary|reset-data|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down
  bash scripts/manage.sh ops k8s-shadow plan|dry-run|cycle|build|apply|status|gate|gate-manual|manual-evidence|smoke|logs|db-summary|reset-data|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down
  bash scripts/manage.sh ops awx-shadow plan|dry-run|install|status|port-forward [local-port]|logs|password|down
  bash scripts/manage.sh ops awx-provider list|upsert [provider-id] [base-url]|check <provider-id>
  bash scripts/manage.sh ops local-platform plan|dry-run|cycle [local-port]|status|down
  bash scripts/manage.sh ops internal-production plan|deploy|apply|status|gateway-smoke [gateway-url]|down
  bash scripts/manage.sh ops internal-production cleanup-smoke-fixtures [--apply]
  bash scripts/manage.sh k8s plan internal-shadow
  bash scripts/manage.sh k8s explain internal-shadow
  bash scripts/manage.sh k8s render internal-shadow
  bash scripts/manage.sh k8s dry-run internal-shadow
  bash scripts/manage.sh k8s apply internal-shadow
  bash scripts/manage.sh k8s status internal-shadow
  bash scripts/manage.sh k8s port-forward internal-local [local-port] [bind-address]
  bash scripts/manage.sh k8s logs internal-shadow
  bash scripts/manage.sh k8s db-summary internal-shadow
  bash scripts/manage.sh k8s gateway-smoke internal-shadow [gateway-url]
  MX_K8S_SHADOW_CONFIRM_RESET=1 bash scripts/manage.sh k8s reset-data internal-shadow
  bash scripts/manage.sh k8s cleanup-smoke-fixtures internal-shadow [--apply]
  bash scripts/manage.sh k8s remote-runner internal-shadow enable|disable
  bash scripts/manage.sh k8s readonly-probe internal-shadow enable|disable
  bash scripts/manage.sh k8s ssh-bootstrap internal-shadow enable|disable
  bash scripts/manage.sh k8s gate internal-shadow [local-port]
  bash scripts/manage.sh k8s gate-manual internal-shadow <evidence-json> [local-port]
  bash scripts/manage.sh k8s smoke internal-shadow [local-port]
  bash scripts/manage.sh k8s down internal-shadow

Planned:
  bash scripts/manage.sh internal up
  bash scripts/manage.sh domestic up
  bash scripts/manage.sh oversea up --site oversea-sg-1
  bash scripts/manage.sh client build --platform win32-x64
  bash scripts/manage.sh migrate export-domestic
  bash scripts/manage.sh test e2e --suite hdi-shadow-e2e --topology h-d-i-o-shadow
  bash scripts/manage.sh kit export --target /Volumes/MX-SALES
EOF
}

role_modules() {
  case "$1" in
    internal)
      echo "iam,app-center,config-center,deploy-center,release-center,artifact-center,runner-controller,test-center,audit-center,observability,sdk-gateway,launcher-network-control,hdi-compat,dns-control,edge-sync"
      ;;
    domestic)
      echo "edge-api,relay-facade,h2i-proxy,snapshot-cache,observability-forwarder"
      ;;
    oversea)
      echo "access-node,site-agent,runner-worker,observability-forwarder"
      ;;
    h-endpoint-dev)
      echo "launcher-dev-api,observability-forwarder"
      ;;
    *)
      die "Unknown profile role: $1"
      ;;
  esac
}

tsc_bin() {
  if [ -x "$ROOT/node_modules/.bin/tsc" ]; then
    echo "$ROOT/node_modules/.bin/tsc"
    return
  fi
  if [ -x "$ROOT/desktop/node_modules/.bin/tsc" ]; then
    echo "$ROOT/desktop/node_modules/.bin/tsc"
    return
  fi
  if [ -x "$ROOT/server/node_modules/.bin/tsc" ]; then
    echo "$ROOT/server/node_modules/.bin/tsc"
    return
  fi
  if [ -x "$ROOT/../../electron-server/node_modules/.bin/tsc" ]; then
    echo "$ROOT/../../electron-server/node_modules/.bin/tsc"
    return
  fi
  return 1
}

run_tsc() {
  local tsc
  if ! tsc="$(tsc_bin)"; then
    die "typescript is not installed. Run pnpm install in $ROOT first."
  fi
  "$tsc" "$@"
}

pnpm_version_for_dir() {
  local dir="$1"
  node -e '
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    try {
      const packageJson = JSON.parse(readFileSync(join(process.argv[1], "package.json"), "utf8"));
      const match = String(packageJson.packageManager || "").match(/^pnpm@(.+)$/);
      if (match) process.stdout.write(match[1]);
    } catch {
      process.exit(0);
    }
  ' "$dir"
}

run_pnpm_dir() {
  local dir="$1"
  shift
  local version
  version="$(pnpm_version_for_dir "$dir")"
  if [ -n "$version" ] && command -v corepack >/dev/null 2>&1; then
    corepack "pnpm@$version" --dir "$dir" "$@"
    return
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required for package scripts"
  pnpm --dir "$dir" "$@"
}

need_kubectl() {
  command -v kubectl >/dev/null 2>&1 || die "kubectl is required for k8s actions"
}

k8s_detect_lan_ip() {
  if [ -n "${MX_K8S_APISERVER_ADVERTISE_ADDRESS:-}" ]; then
    echo "$MX_K8S_APISERVER_ADVERTISE_ADDRESS"
    return
  fi
  if [ -n "${K8S_APISERVER_ADVERTISE_ADDRESS:-}" ]; then
    echo "$K8S_APISERVER_ADVERTISE_ADDRESS"
    return
  fi
  if command -v ip >/dev/null 2>&1; then
    ip -4 route get "${MX_K8S_LAN_PROBE_IP:-1.1.1.1}" 2>/dev/null \
      | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}'
    return
  fi
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{print $1; exit}'
  fi
}

k8s_is_usable_lan_ip() {
  case "$1" in
    ""|0.*|127.*|169.254.*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

k8s_apply_requested_os_hostname() {
  local requested="${MX_K8S_OS_HOSTNAME:-}"
  local current
  [ -n "$requested" ] || return 0
  case "$requested" in
    *[!a-zA-Z0-9.-]*|.*|*.|*-|*-.|*..*|"")
      die "invalid MX_K8S_OS_HOSTNAME: $requested"
      ;;
  esac
  current="$(hostname 2>/dev/null || true)"
  [ "$current" != "$requested" ] || return 0
  command -v hostnamectl >/dev/null 2>&1 || die "hostnamectl is required to set MX_K8S_OS_HOSTNAME"
  say "set OS hostname: $current -> $requested"
  hostnamectl set-hostname "$requested"
}

k8s_existing_node_name() {
  kubectl get nodes -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
}

k8s_etcd_manifest_node_name() {
  local file=/etc/kubernetes/manifests/etcd.yaml
  [ -f "$file" ] || return 0
  sed -n 's/^[[:space:]]*-[[:space:]]*--name=\([^[:space:]]*\).*$/\1/p' "$file" | head -n 1
}

k8s_is_valid_node_name() {
  local value="$1"
  [ -n "$value" ] || return 1
  [ "${#value}" -le 253 ] || return 1
  printf '%s\n' "$value" \
    | grep -Eq '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
}

k8s_sanitize_node_name() {
  local value="$1"
  value="$(printf '%s' "$value" \
    | tr '[:upper:]_' '[:lower:]-' \
    | sed -E 's/[^a-z0-9.-]+/-/g; s/[.][.-]+/./g; s/[-][.-]+/-/g; s/^[^a-z0-9]+//; s/[^a-z0-9]+$//')"
  value="$(printf '%.253s' "$value" | sed -E 's/[^a-z0-9]+$//')"
  if k8s_is_valid_node_name "$value"; then
    echo "$value"
  else
    echo "localhost"
  fi
}

k8s_detect_node_name() {
  local requested existing etcd_name host_name
  if [ -n "${MX_K8S_NODE_NAME:-}" ]; then
    requested="$MX_K8S_NODE_NAME"
    k8s_is_valid_node_name "$requested" || die "invalid MX_K8S_NODE_NAME: $requested"
    echo "$requested"
    return
  fi
  if [ -n "${K8S_NODE_NAME:-}" ]; then
    requested="$K8S_NODE_NAME"
    k8s_is_valid_node_name "$requested" || die "invalid K8S_NODE_NAME: $requested"
    echo "$requested"
    return
  fi
  existing="$(k8s_existing_node_name | awk 'NF {print; exit}')"
  if [ -n "$existing" ]; then
    k8s_is_valid_node_name "$existing" && echo "$existing" || k8s_sanitize_node_name "$existing"
    return
  fi
  etcd_name="$(k8s_etcd_manifest_node_name)"
  if [ -n "$etcd_name" ]; then
    k8s_is_valid_node_name "$etcd_name" && echo "$etcd_name" || k8s_sanitize_node_name "$etcd_name"
    return
  fi
  host_name="$(hostname 2>/dev/null || true)"
  [ -n "$host_name" ] || host_name="localhost"
  k8s_is_valid_node_name "$host_name" && echo "$host_name" || k8s_sanitize_node_name "$host_name"
}

k8s_kubeadm_endpoint_files() {
  local home_dir="${HOME:-}"
  local candidates=(
    /root/.kube/config
    /etc/kubernetes/admin.conf
    /etc/kubernetes/super-admin.conf
    /etc/kubernetes/kubelet.conf
    /etc/kubernetes/controller-manager.conf
    /etc/kubernetes/scheduler.conf
    /etc/kubernetes/manifests/kube-apiserver.yaml
    /etc/kubernetes/manifests/etcd.yaml
    /etc/kubernetes/manifests/kube-controller-manager.yaml
    /etc/kubernetes/manifests/kube-scheduler.yaml
    /var/lib/kubelet/kubeadm-flags.env
    /etc/sysconfig/kubelet
    /etc/default/kubelet
  )
  local file
  for file in "${candidates[@]}"; do
    [ -f "$file" ] && printf '%s\n' "$file"
  done
  if [ -n "$home_dir" ] && [ "$home_dir" != "/root" ] && [ -f "$home_dir/.kube/config" ]; then
    printf '%s\n' "$home_dir/.kube/config"
  fi
}

k8s_kubeadm_endpoint_ips() {
  local file
  while IFS= read -r file; do
    grep -Eho \
      'https://([0-9]{1,3}\.){3}[0-9]{1,3}:(6443|2379|2380)|--advertise-address=([0-9]{1,3}\.){3}[0-9]{1,3}|advertiseAddress:[[:space:]]*([0-9]{1,3}\.){3}[0-9]{1,3}|host:[[:space:]]*([0-9]{1,3}\.){3}[0-9]{1,3}|--node-ip=([0-9]{1,3}\.){3}[0-9]{1,3}' \
      "$file" 2>/dev/null \
      | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' || true
  done < <(k8s_kubeadm_endpoint_files)
}

k8s_backup_file_to_dir() {
  local backup_dir="$1"
  local file="$2"
  local rel dst
  rel="${file#/}"
  dst="$backup_dir/$rel"
  mkdir -p "$(dirname "$dst")"
  cp -a "$file" "$dst"
}

k8s_sed_ip_literal() {
  printf '%s\n' "$1" | sed 's/\./\\./g'
}

k8s_node_internal_ips() {
  kubectl get nodes \
    -o jsonpath='{range .items[*]}{range .status.addresses[?(@.type=="InternalIP")]}{.address}{"\n"}{end}{end}' \
    2>/dev/null || true
}

k8s_node_internal_ip_repair_needed() {
  local current_ip="$1"
  local ips ip has_current
  ips="$(k8s_node_internal_ips)"
  [ -n "$ips" ] || return 1
  has_current=0
  for ip in $ips; do
    [ "$ip" = "$current_ip" ] && has_current=1
    if k8s_is_usable_lan_ip "$ip" && [ "$ip" != "$current_ip" ]; then
      return 0
    fi
  done
  [ "$has_current" = "1" ] || return 0
  return 1
}

k8s_kubelet_flags_need_repair() {
  local current_ip="$1"
  local node_name="$2"
  local file="${MX_K8S_KUBELET_FLAGS_FILE:-/var/lib/kubelet/kubeadm-flags.env}"
  [ -f "$file" ] || return 0
  grep -Eq "(^|[[:space:]\"])--node-ip=${current_ip}([[:space:]\"]|$)" "$file" || return 0
  grep -Eq "(^|[[:space:]\"])--hostname-override=${node_name}([[:space:]\"]|$)" "$file" || return 0
  return 1
}

k8s_upsert_kubelet_identity_flags() {
  local current_ip="$1"
  local node_name="$2"
  local backup_dir="$3"
  local file="${MX_K8S_KUBELET_FLAGS_FILE:-/var/lib/kubelet/kubeadm-flags.env}"
  local tmp
  [ -n "$file" ] || return 0
  [ -f "$file" ] && k8s_backup_file_to_dir "$backup_dir" "$file"
  mkdir -p "$(dirname "$file")"
  tmp="$(mktemp)"
  if [ -f "$file" ]; then
    awk -v ip="$current_ip" -v node_name="$node_name" '
      function emit(line, raw) {
        raw = substr(line, length("KUBELET_KUBEADM_ARGS=") + 1)
        gsub(/^"/, "", raw)
        gsub(/"$/, "", raw)
        gsub(/(^|[[:space:]])--node-ip=[^[:space:]]+/, "", raw)
        gsub(/(^|[[:space:]])--hostname-override=[^[:space:]]+/, "", raw)
        gsub(/[[:space:]]+/, " ", raw)
        sub(/^ /, "", raw)
        sub(/ $/, "", raw)
        if (raw != "") raw = raw " "
        print "KUBELET_KUBEADM_ARGS=\"" raw "--node-ip=" ip " --hostname-override=" node_name "\""
      }
      /^KUBELET_KUBEADM_ARGS=/ { emit($0); found = 1; next }
      { print }
      END {
        if (!found) print "KUBELET_KUBEADM_ARGS=\"--node-ip=" ip " --hostname-override=" node_name "\""
      }
    ' "$file" >"$tmp"
  else
    printf 'KUBELET_KUBEADM_ARGS="--node-ip=%s --hostname-override=%s"\n' "$current_ip" "$node_name" >"$tmp"
  fi
  mv "$tmp" "$file"
  say "updated kubelet identity flags in $file"
}

k8s_wait_node_internal_ip() {
  local current_ip="$1"
  local attempts="${MX_K8S_NODE_IP_REPAIR_WAIT_ATTEMPTS:-60}"
  local ips ip i ok
  say "wait Kubernetes node InternalIP to become $current_ip"
  for i in $(seq 1 "$attempts"); do
    ips="$(k8s_node_internal_ips)"
    ok=1
    for ip in $ips; do
      if k8s_is_usable_lan_ip "$ip" && [ "$ip" != "$current_ip" ]; then
        ok=0
      fi
    done
    if printf '%s\n' "$ips" | grep -Fxq "$current_ip" && [ "$ok" = "1" ]; then
      say "Kubernetes node InternalIP is $current_ip"
      return 0
    fi
    sleep 2
  done
  say "Kubernetes node InternalIP is still: $(printf '%s' "$(k8s_node_internal_ips)" | tr '\n' ' ')"
  return 1
}

k8s_repair_kubelet_identity_if_needed() {
  local current_ip="$1"
  local node_name="$2"
  local backup_dir="$3"
  if ! k8s_node_internal_ip_repair_needed "$current_ip" \
    && ! k8s_kubelet_flags_need_repair "$current_ip" "$node_name"; then
    return 0
  fi
  say "repair kubelet identity to node=$node_name ip=$current_ip"
  k8s_upsert_kubelet_identity_flags "$current_ip" "$node_name" "$backup_dir"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
    systemctl restart kubelet || say "kubelet restart failed while repairing kubelet identity"
  fi
  k8s_wait_node_internal_ip "$current_ip" || true
}

k8s_apiserver_cert_has_ip() {
  local ip="$1"
  k8s_cert_has_ip /etc/kubernetes/pki/apiserver.crt "$ip"
}

k8s_cert_has_ip() {
  local cert="$1"
  local ip="$2"
  [ -f "$cert" ] || return 1
  command -v openssl >/dev/null 2>&1 || return 1
  openssl x509 -in "$cert" -noout -text 2>/dev/null \
    | grep -q "IP Address:$ip"
}

k8s_write_kubeadm_cert_repair_config() {
  local current_ip="$1"
  local path="$2"
  local api_version="$3"
  local extra_sans="${4:-}"
  local node_name san
  node_name="$(k8s_detect_node_name)"
  [ -n "$node_name" ] || node_name="localhost"
  cat >"$path" <<EOF
apiVersion: kubeadm.k8s.io/${api_version}
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: ${current_ip}
nodeRegistration:
  name: ${node_name}
---
apiVersion: kubeadm.k8s.io/${api_version}
kind: ClusterConfiguration
apiServer:
  certSANs:
EOF
  [ -n "$extra_sans" ] || extra_sans="$current_ip,127.0.0.1,localhost"
  for san in $(printf '%s' "$extra_sans" | tr ',' ' '); do
    [ -n "$san" ] || continue
    printf '  - "%s"\n' "$san" >>"$path"
  done
  cat >>"$path" <<EOF
etcd:
  local:
    dataDir: /var/lib/etcd
EOF
}

k8s_kubeadm_phase_certs_with_repair_config() {
  local phase="$1"
  local current_ip="$2"
  local backup_dir="$3"
  local extra_sans="${4:-}"
  local config api_version
  config="$backup_dir/kubeadm-cert-repair.yaml"
  for api_version in v1beta4 v1beta3; do
    k8s_write_kubeadm_cert_repair_config "$current_ip" "$config" "$api_version" "$extra_sans"
    if kubeadm init phase certs "$phase" --config "$config"; then
      return 0
    fi
  done
  return 1
}

k8s_kubeadm_cert_repair_needed_for_ip() {
  local current_ip="$1"
  if [ -f /etc/kubernetes/pki/apiserver.crt ] \
    && ! k8s_apiserver_cert_has_ip "$current_ip"; then
    return 0
  fi
  [ -f /etc/kubernetes/manifests/etcd.yaml ] || return 1
  if [ -f /etc/kubernetes/pki/etcd/server.crt ] \
    && ! k8s_cert_has_ip /etc/kubernetes/pki/etcd/server.crt "$current_ip"; then
    return 0
  fi
  if [ -f /etc/kubernetes/pki/etcd/peer.crt ] \
    && ! k8s_cert_has_ip /etc/kubernetes/pki/etcd/peer.crt "$current_ip"; then
    return 0
  fi
  return 1
}

k8s_repair_apiserver_cert_if_needed() {
  local current_ip="$1"
  local old_ips="$2"
  local backup_dir="$3"
  local extra_sans old_ip
  [ -f /etc/kubernetes/pki/apiserver.crt ] || return 0
  if k8s_apiserver_cert_has_ip "$current_ip"; then
    return 0
  fi
  command -v kubeadm >/dev/null 2>&1 || {
    say "apiserver cert does not include $current_ip, but kubeadm is unavailable; skip cert repair"
    return 0
  }
  say "renew apiserver certificate SAN for $current_ip"
  k8s_backup_file_to_dir "$backup_dir" /etc/kubernetes/pki/apiserver.crt
  [ -f /etc/kubernetes/pki/apiserver.key ] && k8s_backup_file_to_dir "$backup_dir" /etc/kubernetes/pki/apiserver.key
  rm -f /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key
  extra_sans="$current_ip,127.0.0.1,localhost"
  for old_ip in $old_ips; do
    extra_sans="$extra_sans,$old_ip"
  done
  if ! k8s_kubeadm_phase_certs_with_repair_config apiserver "$current_ip" "$backup_dir" "$extra_sans"; then
    cp -a "$backup_dir/etc/kubernetes/pki/apiserver.crt" /etc/kubernetes/pki/apiserver.crt 2>/dev/null || true
    cp -a "$backup_dir/etc/kubernetes/pki/apiserver.key" /etc/kubernetes/pki/apiserver.key 2>/dev/null || true
    die "failed to renew apiserver certificate; restored previous certificate from $backup_dir"
  fi
}

k8s_repair_etcd_cert_phase_if_needed() {
  local phase="$1"
  local cert="$2"
  local key="$3"
  local current_ip="$4"
  local backup_dir="$5"
  [ -f "$cert" ] || return 0
  if k8s_cert_has_ip "$cert" "$current_ip"; then
    return 0
  fi
  command -v kubeadm >/dev/null 2>&1 || {
    say "$phase cert does not include $current_ip, but kubeadm is unavailable; skip cert repair"
    return 0
  }
  say "renew $phase certificate SAN for $current_ip"
  k8s_backup_file_to_dir "$backup_dir" "$cert"
  [ -f "$key" ] && k8s_backup_file_to_dir "$backup_dir" "$key"
  rm -f "$cert" "$key"
  if ! k8s_kubeadm_phase_certs_with_repair_config "$phase" "$current_ip" "$backup_dir"; then
    cp -a "$backup_dir/${cert#/}" "$cert" 2>/dev/null || true
    cp -a "$backup_dir/${key#/}" "$key" 2>/dev/null || true
    die "failed to renew $phase certificate; restored previous certificate from $backup_dir"
  fi
}

k8s_repair_etcd_certs_if_needed() {
  local current_ip="$1"
  local backup_dir="$2"
  [ -f /etc/kubernetes/manifests/etcd.yaml ] || return 0
  k8s_repair_etcd_cert_phase_if_needed \
    etcd-server \
    /etc/kubernetes/pki/etcd/server.crt \
    /etc/kubernetes/pki/etcd/server.key \
    "$current_ip" \
    "$backup_dir"
  k8s_repair_etcd_cert_phase_if_needed \
    etcd-peer \
    /etc/kubernetes/pki/etcd/peer.crt \
    /etc/kubernetes/pki/etcd/peer.key \
    "$current_ip" \
    "$backup_dir"
}

k8s_wait_apiserver_after_endpoint_repair() {
  local current_ip="$1"
  local attempts="${MX_K8S_APISERVER_REPAIR_WAIT_ATTEMPTS:-60}"
  local i
  say "wait kube-apiserver on $current_ip:6443"
  for i in $(seq 1 "$attempts"); do
    if kubectl --request-timeout=5s get --raw=/version >/dev/null 2>&1; then
      say "kube-apiserver endpoint is healthy"
      return 0
    fi
    sleep 2
  done
  die "kube-apiserver did not become reachable after endpoint repair"
}

k8s_restart_static_pod_containers() {
  [ "${MX_K8S_RESTART_STATIC_PODS:-1}" = "1" ] || return 1
  local name ids id restarted
  restarted=0
  if command -v crictl >/dev/null 2>&1; then
    for name in "$@"; do
      ids="$(crictl ps --name "$name" -q 2>/dev/null || true)"
      if [ -z "$ids" ]; then
        say "no running $name static-pod container found via crictl"
        continue
      fi
      say "restart $name static-pod container via crictl"
      for id in $ids; do
        crictl stop "$id" >/dev/null 2>&1 || true
        restarted=1
      done
    done
    [ "$restarted" = "1" ]
    return
  fi
  if [ -d /etc/kubernetes/manifests ]; then
    k8s_nudge_static_pod_manifests "$@"
    return
  fi
  if command -v systemctl >/dev/null 2>&1; then
    say "crictl unavailable; restart kubelet and wait for static pod reconciliation"
    systemctl restart kubelet || true
    return 0
  fi
  return 1
}

k8s_nudge_static_pod_manifests() {
  local name file tmp moved
  moved=0
  say "crictl unavailable; nudge static pod manifests for: $*"
  for name in "$@"; do
    file="/etc/kubernetes/manifests/$name.yaml"
    [ -f "$file" ] || continue
    tmp="$file.mx-restart.$$"
    mv "$file" "$tmp" || continue
    sleep 2
    mv "$tmp" "$file"
    moved=1
    say "nudged $file"
  done
  [ "$moved" = "1" ]
}

k8s_wait_control_plane_observers() {
  local attempts="${MX_K8S_CONTROL_PLANE_WAIT_ATTEMPTS:-60}"
  local i component phase
  say "wait kube-controller-manager and kube-scheduler"
  for i in $(seq 1 "$attempts"); do
    for component in kube-controller-manager kube-scheduler; do
      phase="$(kubectl -n kube-system get pods -l "component=$component" \
        -o jsonpath='{range .items[*]}{.status.phase}{"\n"}{end}' 2>/dev/null \
        | head -n 1 || true)"
      [ "$phase" = "Running" ] || break
    done
    [ "$component" = "kube-scheduler" ] && [ "$phase" = "Running" ] && return 0
    sleep 2
  done
  return 1
}

k8s_flannel_url() {
  echo "${K8S_FLANNEL_URL:-${MX_K8S_FLANNEL_URL:-https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml}}"
}

k8s_flannel_subnet_ready() {
  [ -s "${MX_K8S_FLANNEL_SUBNET_ENV:-/run/flannel/subnet.env}" ]
}

k8s_flannel_daemonset_ready() {
  kubectl -n kube-flannel rollout status daemonset/kube-flannel-ds --timeout="${1:-5s}" >/dev/null 2>&1
}

k8s_flannel_diagnostics() {
  local pods pod
  say "flannel diagnostics: subnet env"
  ls -la /run/flannel 2>/dev/null || true
  [ -f /run/flannel/subnet.env ] && cat /run/flannel/subnet.env || true
  say "flannel diagnostics: namespace resources"
  kubectl -n kube-flannel get pods,daemonset,configmap -o wide || true
  say "flannel diagnostics: daemonset detail"
  kubectl -n kube-flannel describe daemonset kube-flannel-ds || true
  pods="$(kubectl -n kube-flannel get pods -o name 2>/dev/null || true)"
  for pod in $pods; do
    say "flannel diagnostics: describe $pod"
    kubectl -n kube-flannel describe "$pod" || true
    say "flannel diagnostics: logs $pod"
    kubectl -n kube-flannel logs "$pod" --all-containers --tail=160 || true
  done
  say "flannel diagnostics: recent events"
  kubectl -n kube-flannel get events --sort-by=.lastTimestamp || true
}

k8s_wait_flannel_subnet_env() {
  local attempts="${MX_K8S_FLANNEL_SUBNET_WAIT_ATTEMPTS:-60}"
  local i
  say "wait Flannel subnet env"
  for i in $(seq 1 "$attempts"); do
    if k8s_flannel_subnet_ready; then
      say "Flannel subnet env is ready"
      return 0
    fi
    sleep 2
  done
  return 1
}

k8s_repair_flannel_apiserver_env() {
  [ "${MX_K8S_FLANNEL_DIRECT_APISERVER:-1}" = "1" ] || return 0
  local host port
  host="${MX_K8S_FLANNEL_APISERVER_HOST:-$(k8s_detect_lan_ip | head -n 1)}"
  port="${MX_K8S_FLANNEL_APISERVER_PORT:-6443}"
  if ! k8s_is_usable_lan_ip "$host"; then
    say "skip Flannel direct apiserver env; cannot detect a usable LAN IP"
    return 0
  fi
  say "point Flannel at kube-apiserver $host:$port"
  kubectl -n kube-flannel set env daemonset/kube-flannel-ds -c kube-flannel \
    "KUBERNETES_SERVICE_HOST=$host" \
    "KUBERNETES_SERVICE_PORT=$port"
}

k8s_detect_cluster_pod_cidr() {
  if [ -n "${MX_K8S_POD_CIDR:-}" ]; then
    echo "$MX_K8S_POD_CIDR"
    return
  fi
  if [ -n "${POD_CIDR:-}" ]; then
    echo "$POD_CIDR"
    return
  fi
  if [ -n "${K8S_POD_CIDR:-}" ]; then
    echo "$K8S_POD_CIDR"
    return
  fi
  local cidr
  cidr="$(kubectl -n kube-system get configmap kubeadm-config \
    -o go-template='{{ index .data "ClusterConfiguration" }}' 2>/dev/null \
    | awk '/podSubnet:/ {print $2; exit}' || true)"
  if [ -n "$cidr" ]; then
    echo "$cidr"
    return
  fi
  if [ -f /etc/kubernetes/manifests/kube-controller-manager.yaml ]; then
    awk -F= '/--cluster-cidr=/ {
      value = $2
      gsub(/[",[:space:]]/, "", value)
      print value
      exit
    }' /etc/kubernetes/manifests/kube-controller-manager.yaml
  fi
}

k8s_patch_flannel_pod_cidr() {
  local cidr current compact net_conf escaped
  K8S_FLANNEL_POD_CIDR_PATCHED=0
  kubectl -n kube-flannel get configmap kube-flannel-cfg >/dev/null 2>&1 || return 0
  cidr="$(k8s_detect_cluster_pod_cidr | head -n 1 || true)"
  if [ -z "$cidr" ]; then
    say "skip Flannel pod CIDR patch; cannot detect cluster pod CIDR"
    return 0
  fi
  current="$(kubectl -n kube-flannel get configmap kube-flannel-cfg \
    -o jsonpath='{.data.net-conf\.json}' 2>/dev/null || true)"
  compact="$(printf '%s' "$current" | tr -d '[:space:]')"
  case "$compact" in
    *"\"Network\":\"$cidr\""*)
      say "Flannel pod CIDR already matches: $cidr"
      return 0
      ;;
  esac
  net_conf="{\"Network\":\"${cidr}\",\"Backend\":{\"Type\":\"vxlan\"}}"
  escaped="$(printf '%s' "$net_conf" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  say "configure Flannel pod CIDR: $cidr"
  kubectl -n kube-flannel patch configmap kube-flannel-cfg \
    --type merge \
    -p "{\"data\":{\"net-conf.json\":\"$escaped\"}}"
  K8S_FLANNEL_POD_CIDR_PATCHED=1
}

k8s_repair_flannel_cni() {
  [ "${MX_K8S_REPAIR_FLANNEL:-1}" = "1" ] || return 0
  [ -f /etc/kubernetes/manifests/kube-apiserver.yaml ] || return 0
  local url repo version cni_version timeout flannel_cidr_patched
  timeout="${MX_K8S_FLANNEL_ROLLOUT_TIMEOUT:-300s}"
  k8s_patch_flannel_pod_cidr
  flannel_cidr_patched="${K8S_FLANNEL_POD_CIDR_PATCHED:-0}"
  if [ "$flannel_cidr_patched" != "1" ] && k8s_flannel_subnet_ready && k8s_flannel_daemonset_ready 5s; then
    return 0
  fi
  url="$(k8s_flannel_url)"
  repo="${K8S_FLANNEL_IMAGE_REPOSITORY:-${MX_K8S_FLANNEL_IMAGE_REPOSITORY:-}}"
  version="${K8S_FLANNEL_VERSION:-${MX_K8S_FLANNEL_VERSION:-v0.28.5}}"
  cni_version="${K8S_FLANNEL_CNI_PLUGIN_VERSION:-${MX_K8S_FLANNEL_CNI_PLUGIN_VERSION:-v1.9.1-flannel1}}"
  say "repair Flannel CNI"
  say "apply Flannel manifest: $url"
  kubectl apply --validate=false -f "$url"
  k8s_patch_flannel_pod_cidr
  if [ -n "$repo" ]; then
    say "override Flannel images with $repo"
    kubectl -n kube-flannel set image daemonset/kube-flannel-ds \
      "install-cni-plugin=${repo}/flannel-cni-plugin:${cni_version}" \
      "install-cni=${repo}/flannel:${version}" \
      "kube-flannel=${repo}/flannel:${version}"
  fi
  if kubectl -n kube-flannel get daemonset kube-flannel-ds >/dev/null 2>&1; then
    k8s_repair_flannel_apiserver_env
    kubectl -n kube-flannel rollout restart daemonset/kube-flannel-ds || true
    if ! kubectl -n kube-flannel rollout status daemonset/kube-flannel-ds --timeout="$timeout"; then
      k8s_flannel_diagnostics
      die "Flannel rollout failed"
    fi
  fi
  if ! k8s_wait_flannel_subnet_env; then
    k8s_flannel_diagnostics
    die "Flannel did not create /run/flannel/subnet.env"
  fi
}

k8s_cluster_dns_diagnostics() {
  say "cluster dns diagnostics: kube-dns service"
  kubectl -n kube-system get svc kube-dns -o wide || true
  kubectl -n kube-system describe svc kube-dns || true
  say "cluster dns diagnostics: coredns workload"
  kubectl -n kube-system get deployment coredns -o wide || true
  kubectl -n kube-system describe deployment coredns || true
  say "cluster dns diagnostics: coredns pods"
  kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide || true
  kubectl -n kube-system get pods -l k8s-app=kube-dns -o name 2>/dev/null | while IFS= read -r pod; do
    [ -n "$pod" ] || continue
    kubectl -n kube-system describe "$pod" || true
    kubectl -n kube-system logs "$pod" --all-containers --tail=120 || true
  done
  say "cluster dns diagnostics: recent kube-system events"
  kubectl -n kube-system get events --sort-by=.lastTimestamp || true
}

k8s_recover_cluster_dns() {
  [ "${MX_K8S_RECOVER_CLUSTER_DNS:-1}" = "1" ] || return 0
  kubectl -n kube-system get deployment coredns >/dev/null 2>&1 || return 0
  local desired available
  desired="$(kubectl -n kube-system get deployment coredns -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  available="$(kubectl -n kube-system get deployment coredns -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)"
  desired="${desired:-1}"
  available="${available:-0}"
  if [ "$available" != "$desired" ]; then
    say "restart kube-system coredns after network recovery: available=$available desired=$desired"
    kubectl -n kube-system rollout restart deployment/coredns
  fi
  say "wait kube-system coredns rollout"
  if ! k8s_rollout_status kube-system deployment coredns "${MX_K8S_CLUSTER_DNS_ROLLOUT_TIMEOUT:-180s}"; then
    k8s_cluster_dns_diagnostics
    die "kube-system coredns rollout failed"
  fi
}

k8s_repair_kubeadm_endpoint() {
  [ "${MX_K8S_AUTO_REPAIR_KUBEADM_ENDPOINT:-1}" = "1" ] || return 0
  [ -f /etc/kubernetes/manifests/kube-apiserver.yaml ] || return 0
  local current_ip desired_node_name old_ips old_ip file escaped_old touched changed backup_dir stamp cert_repair_needed kubelet_identity_repair_needed
  k8s_apply_requested_os_hostname
  current_ip="$(k8s_detect_lan_ip | head -n 1)"
  desired_node_name="$(k8s_detect_node_name | head -n 1)"
  [ -n "$desired_node_name" ] || desired_node_name="localhost"
  if ! k8s_is_usable_lan_ip "$current_ip"; then
    say "skip kubeadm endpoint repair; cannot detect a usable LAN IP"
    return 0
  fi
  old_ips="$(k8s_kubeadm_endpoint_ips \
    | grep -v -E "^(127\.0\.0\.1|0\.0\.0\.0|${current_ip//./\\.})$" \
    | sort -u || true)"
  cert_repair_needed=0
  if k8s_kubeadm_cert_repair_needed_for_ip "$current_ip"; then
    cert_repair_needed=1
  fi
  kubelet_identity_repair_needed=0
  if k8s_node_internal_ip_repair_needed "$current_ip" \
    || k8s_kubelet_flags_need_repair "$current_ip" "$desired_node_name"; then
    kubelet_identity_repair_needed=1
  fi
  if [ -z "$old_ips" ] && [ "$cert_repair_needed" != "1" ] && [ "$kubelet_identity_repair_needed" != "1" ]; then
    return 0
  fi

  stamp="$(date +%Y%m%d%H%M%S)"
  backup_dir="/etc/kubernetes/mx-kubeadm-endpoint-repair-$stamp"
  if [ -n "$old_ips" ]; then
    say "repair kubeadm endpoint IP(s): $(printf '%s' "$old_ips" | tr '\n' ' ') -> $current_ip"
  elif [ "$cert_repair_needed" = "1" ]; then
    say "repair kubeadm certificate SANs for $current_ip"
  else
    say "repair Kubernetes node identity: $desired_node_name / $current_ip"
  fi
  say "backup kubeadm files to $backup_dir"
  mkdir -p "$backup_dir"
  changed=0
  while IFS= read -r file; do
    touched=0
    for old_ip in $old_ips; do
      if grep -Fq "$old_ip" "$file" 2>/dev/null; then
        touched=1
      fi
    done
    [ "$touched" = "1" ] || continue
    k8s_backup_file_to_dir "$backup_dir" "$file"
    for old_ip in $old_ips; do
      escaped_old="$(k8s_sed_ip_literal "$old_ip")"
      sed -i "s#${escaped_old}#${current_ip}#g" "$file"
    done
    changed=1
    say "updated $file"
  done < <(k8s_kubeadm_endpoint_files)

  [ "$changed" = "1" ] || [ "$cert_repair_needed" = "1" ] || [ "$kubelet_identity_repair_needed" = "1" ] || return 0
  k8s_repair_apiserver_cert_if_needed "$current_ip" "$old_ips" "$backup_dir"
  k8s_repair_etcd_certs_if_needed "$current_ip" "$backup_dir"
  k8s_repair_kubelet_identity_if_needed "$current_ip" "$desired_node_name" "$backup_dir"
  if command -v systemctl >/dev/null 2>&1; then
    say "restart kubelet to reload kubeadm static pod manifests"
    systemctl restart kubelet || say "kubelet restart failed; waiting for static pod reconciliation anyway"
  fi
  if [ "$changed" = "1" ] || [ "$kubelet_identity_repair_needed" = "1" ]; then
    k8s_restart_static_pod_containers etcd kube-apiserver kube-controller-manager kube-scheduler || true
  else
    k8s_restart_static_pod_containers kube-controller-manager kube-scheduler || true
  fi
  k8s_wait_apiserver_after_endpoint_repair "$current_ip"
  k8s_wait_node_internal_ip "$current_ip" || true
  k8s_wait_control_plane_observers || say "control-plane observers did not report Running yet"
}

k8s_namespace() {
  case "$1" in
    internal-local|internal-shadow)
      echo "mx-internal-shadow"
      ;;
    *)
      die "Unknown k8s target: $1"
      ;;
  esac
}

k8s_manifest_dir() {
  case "$1" in
    internal-local|internal-shadow)
      echo "$ROOT/deploy/k8s/internal-shadow"
      ;;
    *)
      die "Unknown k8s target: $1"
      ;;
  esac
}

qp_tunnel_cli_fallback_ready() {
  local dir="$1"
  local required=(
    package.json
    README.md
    README.setup.md
    dist/index.js
    dist/hdo.js
    dist/index.d.ts
    dist/hdo.d.ts
    resources/mihomo-client.sh
  )
  local file
  for file in "${required[@]}"; do
    [ -f "$dir/$file" ] || return 1
  done
}

qp_tunnel_cli_fallback_version() {
  local dir="$1"
  node -e "try { console.log(require(process.argv[1]).version || '') } catch { process.exit(1) }" "$dir/package.json" 2>/dev/null || true
}

wireguard_runtime_ready() {
  local plugin_root="$1"
  local core="$plugin_root/packages/electron-core-wireguard"
  local engine engine_root
  [ -f "$core/package.json" ] || return 1
  [ -f "$core/README.md" ] || return 1
  [ -d "$core/dist" ] || return 1
  for engine in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64; do
    engine_root="$plugin_root/packages/wireguard-engines/$engine"
    [ -f "$engine_root/package.json" ] || return 1
    [ -f "$engine_root/README.md" ] || return 1
    [ -d "$engine_root/resources" ] || return 1
  done
}

shadow_image_refresh_tunnel_cli_from_npm() {
  local target_dir="$ROOT/site-slots/domestic/qp-tunnel-cli"
  local version="${MX_SHADOW_QP_TUNNEL_CLI_VERSION:-latest}"
  local strict="${MX_SHADOW_REFRESH_QP_TUNNEL_CLI_STRICT:-0}"
  local before after
  [ "${MX_SHADOW_REFRESH_QP_TUNNEL_CLI_FROM_NPM:-1}" = "0" ] && return 0
  before="$(qp_tunnel_cli_fallback_version "$target_dir")"
  say "refresh mx-launcher qp-tunnel-cli fallback from npm @qpjoy/tunnel-cli@$version${before:+ (current $before)}"
  if node server/scripts/site-slot-refresh-tunnel-cli.mjs "$version"; then
    after="$(qp_tunnel_cli_fallback_version "$target_dir")"
    say "qp-tunnel-cli fallback ready: ${after:-unknown}"
    return 0
  fi
  if [ "$strict" = "1" ]; then
    die "failed to refresh qp-tunnel-cli fallback from npm @qpjoy/tunnel-cli@$version"
  fi
  if qp_tunnel_cli_fallback_ready "$target_dir"; then
    say "warning: npm refresh failed; continuing with existing qp-tunnel-cli fallback $(qp_tunnel_cli_fallback_version "$target_dir")"
    return 0
  fi
  die "qp-tunnel-cli fallback is missing and npm refresh failed"
}

shadow_image_tunnel_cli_fallback() {
  local target_dir="$ROOT/site-slots/domestic/qp-tunnel-cli"
  local plugin_root="$ROOT/../../electron-plugin"
  local cli_source="$plugin_root/packages/tunnel-cli"
  local build_full="${MX_SHADOW_BUILD_ELECTRON_PLUGIN_FALLBACK:-0}"
  shadow_image_refresh_tunnel_cli_from_npm
  if qp_tunnel_cli_fallback_ready "$target_dir"; then
    if [ -f "$cli_source/package.json" ] && qp_tunnel_cli_fallback_ready "$cli_source" && wireguard_runtime_ready "$plugin_root"; then
      local target_version=""
      local source_version=""
      target_version="$(qp_tunnel_cli_fallback_version "$target_dir")"
      source_version="$(qp_tunnel_cli_fallback_version "$cli_source")"
      if [ -n "$source_version" ] && [ "$target_version" != "$source_version" ]; then
        say "refresh mx-launcher qp-tunnel-cli fallback from local electron-plugin package ($target_version -> $source_version)"
        node server/scripts/site-slot-refresh-tunnel-cli.mjs --from-local "$cli_source"
      fi
    fi
    return 0
  fi
  if [ -f "$cli_source/package.json" ] && qp_tunnel_cli_fallback_ready "$cli_source" && wireguard_runtime_ready "$plugin_root"; then
    say "refresh mx-launcher qp-tunnel-cli fallback from local electron-plugin package"
    node server/scripts/site-slot-refresh-tunnel-cli.mjs --from-local "$cli_source"
    return 0
  fi
  if [ "$build_full" != "1" ]; then
    say "qp-tunnel-cli full fallback is not prebuilt; use server-safe degraded fallback for image materialization"
    say "set MX_SHADOW_BUILD_ELECTRON_PLUGIN_FALLBACK=1 on a build host to produce the full electron-plugin fallback"
    return 0
  fi
  [ -f "$cli_source/package.json" ] || die "missing qp-tunnel-cli source: $cli_source"
  if ! qp_tunnel_cli_fallback_ready "$cli_source" || ! wireguard_runtime_ready "$plugin_root"; then
    if [ ! -d "$plugin_root/node_modules" ]; then
      say "install electron-plugin workspace dependencies for qp-tunnel-cli fallback"
      run_pnpm_dir "$plugin_root" install --frozen-lockfile
    fi
    say "build WireGuard runtime for qp-tunnel-cli fallback"
    run_pnpm_dir "$plugin_root" --filter @qpjoy/electron-core-wireguard build
    say "build qp-tunnel-cli fallback dist"
    run_pnpm_dir "$plugin_root" --filter @qpjoy/tunnel-cli build
  fi
  qp_tunnel_cli_fallback_ready "$cli_source" || die "qp-tunnel-cli source dist is missing after build: $cli_source/dist"
  wireguard_runtime_ready "$plugin_root" || die "electron-core-wireguard runtime artifacts are missing after build"
  say "refresh mx-launcher qp-tunnel-cli fallback from local electron-plugin package"
  node server/scripts/site-slot-refresh-tunnel-cli.mjs --from-local "$cli_source"
}

shadow_image_artifacts() {
  shadow_image_tunnel_cli_fallback
  say "materialize site-slot artifacts for shadow image"
  MX_SITE_SLOT_ALLOW_DEGRADED_QP_TUNNEL_CLI="${MX_SITE_SLOT_ALLOW_DEGRADED_QP_TUNNEL_CLI:-1}" \
    node server/scripts/site-slot-artifact-materializer.mjs all --out-dir server/artifacts/site-slots
}

shadow_image_admin_assets() {
  local out_dir="$ROOT/server/artifacts/admin"
  local three_build_dir="$ROOT/desktop/node_modules/three/build"
  [ -f "$ROOT/desktop/index.html" ] || die "missing desktop/index.html"
  [ -f "$ROOT/desktop/renderer.js" ] || die "missing desktop/renderer.js"
  [ -f "$ROOT/desktop/styles.css" ] || die "missing desktop/styles.css"
  [ -f "$three_build_dir/three.module.js" ] || die "missing desktop/node_modules/three; run pnpm --dir desktop install"
  say "sync browser admin assets for shadow image"
  rm -rf "$out_dir"
  mkdir -p "$out_dir/node_modules/three/build"
  cp "$ROOT/desktop/index.html" "$out_dir/index.html"
  cp "$ROOT/desktop/renderer.js" "$out_dir/renderer.js"
  cp "$ROOT/desktop/styles.css" "$out_dir/styles.css"
  cp "$three_build_dir"/*.js "$out_dir/node_modules/three/build/"
}

shadow_image_build() {
  shadow_image_artifacts
  shadow_image_admin_assets
  (cd server && docker compose -f docker-compose.shadow.yml build internal)
  shadow_image_cleanup
}

containerd_import_docker_image() {
  local image="$1"
  local safe archive refs
  command -v docker >/dev/null 2>&1 || die "docker is required to export $image"
  command -v ctr >/dev/null 2>&1 || die "ctr is required to import $image into containerd"
  docker image inspect "$image" >/dev/null
  safe="${image//\//_}"
  safe="${safe//:/_}"
  archive="${TMPDIR:-/tmp}/mx-k8s-image-${safe}.tar"
  say "import $image into containerd namespace k8s.io"
  rm -f "$archive"
  docker save "$image" -o "$archive"
  ctr -n k8s.io images import "$archive"
  rm -f "$archive"
  containerd_ensure_image_refs "$image"
  refs="$(containerd_present_image_refs "$image" | tr '\n' ' ')"
  say "containerd image refs ready: $refs"
}

containerd_image_ref_aliases() {
  local image="$1"
  local first
  printf '%s\n' "$image"
  if [[ "$image" == */* ]]; then
    first="${image%%/*}"
    if [[ "$first" == *.* || "$first" == *:* || "$first" == "localhost" ]]; then
      return 0
    fi
    printf 'docker.io/%s\n' "$image"
    return 0
  fi
  printf 'docker.io/library/%s\n' "$image"
}

containerd_image_ref_present() {
  local ref="$1"
  ctr -n k8s.io images ls -q | grep -Fx -- "$ref" >/dev/null 2>&1
}

containerd_present_image_refs() {
  local image="$1"
  local ref
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    containerd_image_ref_present "$ref" && printf '%s\n' "$ref"
  done < <(containerd_image_ref_aliases "$image")
}

containerd_first_present_ref() {
  local image="$1"
  local ref
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    if containerd_image_ref_present "$ref"; then
      printf '%s\n' "$ref"
      return 0
    fi
  done < <(containerd_image_ref_aliases "$image")
  return 1
}

containerd_image_ref_is_short() {
  local ref="$1"
  local first
  if [[ "$ref" != */* ]]; then
    return 0
  fi
  first="${ref%%/*}"
  [[ "$first" != *.* && "$first" != *:* && "$first" != "localhost" ]]
}

containerd_ensure_image_refs() {
  local image="$1"
  local source ref
  if ! source="$(containerd_first_present_ref "$image")"; then
    die "containerd import did not create an image ref for $image in namespace k8s.io"
  fi
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    if ! containerd_image_ref_present "$ref"; then
      if containerd_image_ref_is_short "$ref"; then
        say "containerd short ref not present: $ref; kubelet will use the canonical Docker ref"
        continue
      fi
      say "tag containerd image $source as $ref"
      ctr -n k8s.io images tag "$source" "$ref" >/dev/null
    fi
  done < <(containerd_image_ref_aliases "$image")
}

shadow_image_import_containerd() {
  local mode="${MX_SHADOW_CONTAINERD_IMPORT:-1}"
  local image="qpjoy/mx-launcher-server:shadow"
  case "$mode" in
    0|false|off|skip)
      say "skip containerd import for local-only image because MX_SHADOW_CONTAINERD_IMPORT=$mode"
      return 0
      ;;
    auto)
      if ! command -v ctr >/dev/null 2>&1; then
        say "ctr not found; assuming Kubernetes can resolve the local Docker image directly"
        return 0
      fi
      ;;
    1|true|on|required)
      command -v ctr >/dev/null 2>&1 || die "ctr is required to deploy local-only image $image; set MX_SHADOW_CONTAINERD_IMPORT=0 only if your K8s runtime can see Docker images directly"
      ;;
    *)
      die "Unknown MX_SHADOW_CONTAINERD_IMPORT value: $mode"
      ;;
  esac
  if ! command -v ctr >/dev/null 2>&1; then
    say "ctr not found; assuming Kubernetes can resolve the local Docker image directly"
    return 0
  fi
  containerd_import_docker_image "$image"
}

k8s_preload_runtime_images() {
  local mode="${MX_K8S_PRELOAD_RUNTIME_IMAGES:-auto}"
  local images image
  [ "$mode" = "0" ] && return 0
  images="${MX_K8S_RUNTIME_IMAGES:-postgres:16-alpine coredns/coredns:1.11.3 caddy:2.8.4-alpine}"
  if ! command -v ctr >/dev/null 2>&1; then
    [ "$mode" = "1" ] && die "ctr is required when MX_K8S_PRELOAD_RUNTIME_IMAGES=1"
    say "ctr not found; assuming Kubernetes can pull runtime images directly"
    return 0
  fi
  command -v docker >/dev/null 2>&1 || die "docker is required to preload K8s runtime images"
  for image in $images; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      say "pull K8s runtime image through Docker: $image"
      docker pull "$image"
    fi
    containerd_import_docker_image "$image"
  done
}

shadow_image_cleanup() {
  local cleanup="${MX_SHADOW_IMAGE_CLEANUP:-1}"
  local prune_cache="${MX_SHADOW_BUILDKIT_PRUNE:-1}"
  local cache_until="${MX_SHADOW_BUILDKIT_PRUNE_UNTIL:-168h}"
  local keep_storage="${MX_SHADOW_BUILDKIT_KEEP_STORAGE:-8GB}"
  [ "$cleanup" = "0" ] && return 0
  if command -v docker >/dev/null 2>&1; then
    say "cleanup dangling MX Launcher shadow images"
    docker image prune -f \
      --filter "label=dev.qpjoy.mx-launcher.project=mx-launcher" \
      --filter "label=dev.qpjoy.mx-launcher.image=shadow" >/dev/null \
      || say "image cleanup skipped"
    if [ "$prune_cache" != "0" ]; then
      say "cleanup old BuildKit cache (until=$cache_until, keep=$keep_storage)"
      docker builder prune -f \
        --filter "until=$cache_until" \
        --keep-storage "$keep_storage" >/dev/null \
        || say "BuildKit cache cleanup skipped"
    fi
  fi
}

wait_http_ready() {
  local url="$1"
  local attempts="${2:-60}"
  local i
  for i in $(seq 1 "$attempts"); do
    if node -e "fetch(process.argv[1]).then((r)=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))" "$url"; then
      return 0
    fi
    sleep 1
  done
  die "HTTP endpoint did not become ready: $url"
}

port_available() {
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));
  ' "$1"
}

k8s_smoke_port() {
  local requested="$1"
  local candidate
  if port_available "$requested"; then
    echo "$requested"
    return
  fi
  say "local port $requested is busy; trying fallback smoke ports" >&2
  for candidate in 18190 18191 18192 18193; do
    if port_available "$candidate"; then
      echo "$candidate"
      return
    fi
  done
  die "No local port is available for k8s smoke"
}

k8s_plan() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  cat <<EOF
MX Launcher K8s deployment plan: $target

Namespace: $ns

Order:
  1. Apply namespace.
  2. Apply Internal API ServiceAccount.
  3. Apply non-secret config ConfigMap.
  4. Apply DNS control target namespace and baseline CoreDNS ConfigMap.
  5. Create or update DB Secret from local env:
     PG_USER, PG_PASSWORD, PG_DB, DATABASE_URL.
  6. Apply PostgreSQL Service + StatefulSet.
  7. Apply CoreDNS ConfigMap writer RBAC.
  8. Wait for PostgreSQL rollout.
  9. Delete any previous migration Job, apply a fresh TypeORM migration Job,
     and wait for completion.
  10. Apply Internal API Deployment + Service.
  11. Wait for Internal API rollout.
  12. Apply Internal Gateway DaemonSet.
  13. Run HTTP smoke through a temporary kubectl port-forward or the gateway.

Data policy:
  k8s down keeps the PostgreSQL PVC by default. Delete PVCs only with a
  deliberate future purge action.
  k8s reset-data truncates mx_platform_records only. It keeps schema
  migrations, the database, and the PVC, then restarts Internal API so
  built-in App Center/DNS records are seeded again.
EOF
}

k8s_explain() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  cat <<EOF
K8s concepts for $target, mapped from Docker Compose:

Compose service -> K8s Deployment or StatefulSet
  - The Compose "internal" service becomes a Deployment because it is a
    stateless HTTP API. K8s can roll it out, restart it, and scale replicas.
  - The Compose "postgres" service becomes a StatefulSet because it owns stable
    storage and identity. Its data lives in a PersistentVolumeClaim.

Compose ports -> K8s Service
  - Compose maps 18090 to your host.
  - K8s creates a ClusterIP Service named mx-launcher-internal. For local smoke,
    manage.sh uses kubectl port-forward to temporarily expose it.

Compose environment -> ConfigMap + Secret
  - Non-secret values such as MX_ENVIRONMENT and MX_SITE_ROLE live in ConfigMap.
  - DATABASE_URL and PG_PASSWORD live in Secret. The script creates the Secret
    from your shell env so credentials do not live in git.

Docker healthcheck -> K8s probes
  - livenessProbe calls /healthz: is the process alive.
  - readinessProbe calls /readyz: is the API ready to receive traffic.

Deployment order
  - K8s can reconcile resources continuously, but dependencies still matter.
    We explicitly wait for PostgreSQL before running the migration Job, and wait
    for migration completion before rolling the API.

Current namespace: $ns
EOF
}

k8s_render() {
  local target="$1"
  local dir
  dir="$(k8s_manifest_dir "$target")"
  [ -d "$dir" ] || die "missing k8s manifest directory: $dir"
  cat "$dir"/00-namespace.yaml
  printf '\n---\n'
  cat "$dir"/05-serviceaccount.yaml
  printf '\n---\n'
  cat "$dir"/10-configmap.yaml
  printf '\n---\n'
  cat "$dir"/15-dns-control-target.yaml
  printf '\n---\n'
  cat "$dir"/18-local-pv.yaml
  printf '\n---\n'
  cat "$dir"/20-postgres.yaml
  printf '\n---\n'
  cat "$dir"/25-coredns-rbac.yaml
  printf '\n---\n'
  cat "$dir"/27-host-runner-rbac.yaml
  printf '\n---\n'
  cat "$dir"/30-migration-job.yaml
  printf '\n---\n'
  cat "$dir"/40-internal-api.yaml
  printf '\n---\n'
  cat "$dir"/45-internal-gateway.yaml
}

k8s_apply_db_secret() {
  local ns="$1"
  local pg_user="${PG_USER:-mx_internal}"
  local pg_password="${PG_PASSWORD:-mx_internal}"
  local pg_db="${PG_DB:-mx_internal_shadow}"
  local database_host="${DATABASE_HOST:-mx-internal-postgres.${ns}.svc.cluster.local}"
  local database_url="${DATABASE_URL:-postgres://${pg_user}:${pg_password}@${database_host}:5432/${pg_db}}"
  kubectl -n "$ns" create secret generic mx-launcher-db \
    --from-literal=PG_USER="$pg_user" \
    --from-literal=PG_PASSWORD="$pg_password" \
    --from-literal=PG_DB="$pg_db" \
    --from-literal=DATABASE_HOST="$database_host" \
    --from-literal=DATABASE_URL="$database_url" \
    --dry-run=client -o yaml | kubectl apply --validate=false -f -
}

k8s_secret_dry_run() {
  local ns="$1"
  local pg_user="${PG_USER:-mx_internal}"
  local pg_password="${PG_PASSWORD:-mx_internal}"
  local pg_db="${PG_DB:-mx_internal_shadow}"
  local database_host="${DATABASE_HOST:-mx-internal-postgres.${ns}.svc.cluster.local}"
  local database_url="${DATABASE_URL:-postgres://${pg_user}:${pg_password}@${database_host}:5432/${pg_db}}"
  kubectl -n "$ns" create secret generic mx-launcher-db \
    --from-literal=PG_USER="$pg_user" \
    --from-literal=PG_PASSWORD="$pg_password" \
    --from-literal=PG_DB="$pg_db" \
    --from-literal=DATABASE_HOST="$database_host" \
    --from-literal=DATABASE_URL="$database_url" \
    --dry-run=client -o yaml >/dev/null
}

k8s_postgres_diagnostics() {
  local ns="$1"
  say "postgres diagnostics: pods and PVCs"
  kubectl -n "$ns" get pods,pvc -o wide || true
  say "postgres diagnostics: PVs"
  kubectl get pv || true
  say "postgres diagnostics: node conditions and taints"
  kubectl get nodes -o wide || true
  kubectl describe nodes | sed -n '/^Name:/,/^Non-terminated Pods:/p' || true
  say "postgres diagnostics: PVC detail"
  kubectl -n "$ns" describe pvc postgres-data-mx-internal-postgres-0 || true
  say "postgres diagnostics: Pod detail"
  kubectl -n "$ns" describe pod mx-internal-postgres-0 || true
  say "postgres diagnostics: recent namespace events"
  kubectl -n "$ns" get events --sort-by=.lastTimestamp || true
  say "postgres diagnostics: logs"
  kubectl -n "$ns" logs pod/mx-internal-postgres-0 -c postgres --tail=120 || true
}

k8s_node_disk_pressure_report() {
  local ns="$1"
  local nodes
  nodes="$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.conditions[?(@.type=="DiskPressure")]}{.status}{end}{"\n"}{end}' 2>/dev/null | awk '$2 == "True" {print $1}' || true)"
  [ -n "$nodes" ] || return 1
  say "node DiskPressure detected before migration: $nodes"
  kubectl get nodes -o wide || true
  kubectl describe nodes $nodes | sed -n '/^Name:/,/^Non-terminated Pods:/p' || true
  say "recent namespace events"
  kubectl -n "$ns" get events --sort-by=.lastTimestamp | tail -n 80 || true
  return 0
}

k8s_postgres_service_ready() {
  local ns="$1"
  local attempts="${2:-60}"
  local endpoints slices i
  say "wait postgres service DNS target"
  for i in $(seq 1 "$attempts"); do
    if ! kubectl -n "$ns" get service mx-internal-postgres >/dev/null 2>&1; then
      sleep 2
      continue
    fi
    endpoints="$(kubectl -n "$ns" get endpoints mx-internal-postgres -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null || true)"
    slices="$(kubectl -n "$ns" get endpointslices -l kubernetes.io/service-name=mx-internal-postgres -o jsonpath='{range .items[*].endpoints[*]}{.addresses[*]}{" "}{end}' 2>/dev/null || true)"
    if [ -n "$endpoints$slices" ]; then
      say "postgres service has endpoint: ${endpoints:-$slices}"
      return 0
    fi
    sleep 2
  done
  return 1
}

k8s_postgres_endpoint_ip() {
  local ns="$1"
  local endpoints slices
  endpoints="$(kubectl -n "$ns" get endpoints mx-internal-postgres -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)"
  if [ -n "$endpoints" ]; then
    printf '%s\n' "$endpoints"
    return 0
  fi
  slices="$(kubectl -n "$ns" get endpointslices -l kubernetes.io/service-name=mx-internal-postgres -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{"\n"}{end}' 2>/dev/null | head -n 1 || true)"
  [ -n "$slices" ] && printf '%s\n' "$slices"
}

k8s_probe_postgres_host() {
  local ns="$1"
  local host="$2"
  local pod phase i
  pod="mx-postgres-probe-$(date +%s)-$$"
  say "probe postgres from cluster: $host"
  kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if ! kubectl -n "$ns" run "$pod" \
    --image=postgres:16-alpine \
    --image-pull-policy=IfNotPresent \
    --restart=Never \
    --labels=app.kubernetes.io/name=mx-postgres-probe \
    --env="PGHOST=$host" \
    --overrides='{"spec":{"tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"},{"key":"node-role.kubernetes.io/master","operator":"Exists","effect":"NoSchedule"}]}}' \
    --command -- sh -ec 'for i in 1 2 3; do pg_isready -h "$PGHOST" -p 5432 -t 2 && exit 0; sleep 1; done; exit 1' >/dev/null; then
    kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    return 1
  fi
  for i in $(seq 1 "${MX_K8S_POSTGRES_PROBE_WAIT_ATTEMPTS:-30}"); do
    phase="$(kubectl -n "$ns" get pod "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    case "$phase" in
      Succeeded)
        kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
        return 0
        ;;
      Failed)
        kubectl -n "$ns" logs "$pod" --tail=60 || true
        kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
        return 1
        ;;
    esac
    sleep 1
  done
  kubectl -n "$ns" logs "$pod" --tail=60 || true
  kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  return 1
}

K8S_SELECTED_POSTGRES_HOST=""
k8s_select_postgres_database_host() {
  local ns="$1"
  local mode service_host endpoint_host dns_host
  mode="${MX_K8S_POSTGRES_HOST_MODE:-auto}"
  dns_host="mx-internal-postgres.${ns}.svc.cluster.local"
  service_host="$(kubectl -n "$ns" get service mx-internal-postgres -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
  endpoint_host="$(k8s_postgres_endpoint_ip "$ns")"
  case "$mode" in
    dns)
      K8S_SELECTED_POSTGRES_HOST="$dns_host"
      say "use postgres DNS host by MX_K8S_POSTGRES_HOST_MODE=dns: $K8S_SELECTED_POSTGRES_HOST"
      return 0
      ;;
    service|clusterip)
      [ -n "$service_host" ] && [ "$service_host" != "None" ] || return 1
      K8S_SELECTED_POSTGRES_HOST="$service_host"
      say "use postgres ClusterIP by MX_K8S_POSTGRES_HOST_MODE=$mode: $K8S_SELECTED_POSTGRES_HOST"
      return 0
      ;;
    endpoint|pod)
      [ -n "$endpoint_host" ] || return 1
      K8S_SELECTED_POSTGRES_HOST="$endpoint_host"
      say "use postgres endpoint by MX_K8S_POSTGRES_HOST_MODE=$mode: $K8S_SELECTED_POSTGRES_HOST"
      return 0
      ;;
    auto)
      ;;
    *)
      die "unknown MX_K8S_POSTGRES_HOST_MODE=$mode; use auto|dns|service|endpoint"
      ;;
  esac
  if [ -n "$service_host" ] && [ "$service_host" != "None" ] && k8s_probe_postgres_host "$ns" "$service_host"; then
    K8S_SELECTED_POSTGRES_HOST="$service_host"
    say "postgres ClusterIP is reachable: $K8S_SELECTED_POSTGRES_HOST"
    return 0
  fi
  if [ -n "$endpoint_host" ] && k8s_probe_postgres_host "$ns" "$endpoint_host"; then
    K8S_SELECTED_POSTGRES_HOST="$endpoint_host"
    say "postgres ClusterIP is unreachable; fallback to endpoint: $K8S_SELECTED_POSTGRES_HOST"
    return 0
  fi
  say "postgres host selection failed: service=${service_host:-none}, endpoint=${endpoint_host:-none}"
  return 1
}

k8s_service_endpoint_ip() {
  local ns="$1"
  local service="$2"
  local endpoints slices
  endpoints="$(kubectl -n "$ns" get endpoints "$service" -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)"
  if [ -n "$endpoints" ]; then
    printf '%s\n' "$endpoints"
    return 0
  fi
  slices="$(kubectl -n "$ns" get endpointslices -l "kubernetes.io/service-name=$service" -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{"\n"}{end}' 2>/dev/null | head -n 1 || true)"
  [ -n "$slices" ] && printf '%s\n' "$slices"
}

k8s_probe_http_host() {
  local ns="$1"
  local host="$2"
  local path="${3:-/healthz}"
  local pod phase i
  pod="mx-http-probe-$(date +%s)-$$"
  say "probe HTTP from cluster: http://$host$path"
  kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if ! kubectl -n "$ns" run "$pod" \
    --image=qpjoy/mx-launcher-server:shadow \
    --image-pull-policy=IfNotPresent \
    --restart=Never \
    --labels=app.kubernetes.io/name=mx-http-probe \
    --env="HTTP_TARGET=http://$host$path" \
    --overrides='{"spec":{"tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"},{"key":"node-role.kubernetes.io/master","operator":"Exists","effect":"NoSchedule"}]}}' \
    --command -- node -e 'fetch(process.env.HTTP_TARGET).then(async (res) => { const text = await res.text(); if (!res.ok) { console.error(`${res.status} ${text}`); process.exit(1); } process.exit(0); }).catch((error) => { console.error(error.message || error); process.exit(1); });' >/dev/null; then
    kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    return 1
  fi
  for i in $(seq 1 "${MX_K8S_HTTP_PROBE_WAIT_ATTEMPTS:-30}"); do
    phase="$(kubectl -n "$ns" get pod "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    case "$phase" in
      Succeeded)
        kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
        return 0
        ;;
      Failed)
        kubectl -n "$ns" logs "$pod" --tail=60 || true
        kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
        return 1
        ;;
    esac
    sleep 1
  done
  kubectl -n "$ns" logs "$pod" --tail=60 || true
  kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  return 1
}

K8S_SELECTED_INTERNAL_API_UPSTREAM=""
k8s_select_internal_api_gateway_upstream() {
  local ns="$1"
  local mode service_host endpoint_host dns_upstream
  mode="${MX_K8S_GATEWAY_UPSTREAM_MODE:-auto}"
  dns_upstream="mx-launcher-internal.${ns}.svc.cluster.local:18090"
  service_host="$(kubectl -n "$ns" get service mx-launcher-internal -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
  endpoint_host="$(k8s_service_endpoint_ip "$ns" mx-launcher-internal)"
  case "$mode" in
    dns)
      K8S_SELECTED_INTERNAL_API_UPSTREAM="$dns_upstream"
      say "use gateway DNS upstream by MX_K8S_GATEWAY_UPSTREAM_MODE=dns: $K8S_SELECTED_INTERNAL_API_UPSTREAM"
      return 0
      ;;
    service|clusterip)
      [ -n "$service_host" ] && [ "$service_host" != "None" ] || return 1
      K8S_SELECTED_INTERNAL_API_UPSTREAM="$service_host:18090"
      say "use gateway ClusterIP upstream by MX_K8S_GATEWAY_UPSTREAM_MODE=$mode: $K8S_SELECTED_INTERNAL_API_UPSTREAM"
      return 0
      ;;
    endpoint|pod)
      [ -n "$endpoint_host" ] || return 1
      K8S_SELECTED_INTERNAL_API_UPSTREAM="$endpoint_host:18090"
      say "use gateway endpoint upstream by MX_K8S_GATEWAY_UPSTREAM_MODE=$mode: $K8S_SELECTED_INTERNAL_API_UPSTREAM"
      return 0
      ;;
    auto)
      ;;
    *)
      die "unknown MX_K8S_GATEWAY_UPSTREAM_MODE=$mode; use auto|dns|service|endpoint"
      ;;
  esac
  if [ -n "$service_host" ] && [ "$service_host" != "None" ] && k8s_probe_http_host "$ns" "$service_host:18090" /healthz; then
    K8S_SELECTED_INTERNAL_API_UPSTREAM="$service_host:18090"
    say "gateway ClusterIP upstream is reachable: $K8S_SELECTED_INTERNAL_API_UPSTREAM"
    return 0
  fi
  if [ -n "$endpoint_host" ] && k8s_probe_http_host "$ns" "$endpoint_host:18090" /healthz; then
    K8S_SELECTED_INTERNAL_API_UPSTREAM="$endpoint_host:18090"
    say "gateway ClusterIP upstream is unreachable; fallback to endpoint: $K8S_SELECTED_INTERNAL_API_UPSTREAM"
    return 0
  fi
  say "gateway upstream selection failed: service=${service_host:-none}, endpoint=${endpoint_host:-none}"
  return 1
}

k8s_repair_released_local_pv() {
  local pv="$1"
  local phase
  phase="$(kubectl get pv "$pv" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "$phase" in
    Released|Failed)
      say "repair released local PV $pv ($phase); hostPath data is retained"
      kubectl delete pv "$pv" --ignore-not-found
      ;;
  esac
}

k8s_repair_internal_local_pvs() {
  k8s_repair_released_local_pv mx-internal-postgres-local-pv
  k8s_repair_released_local_pv mx-launcher-internal-ssh-local-pv
  k8s_repair_released_local_pv mx-launcher-release-artifacts-local-pv
  k8s_repair_released_local_pv mx-launcher-site-slots-local-pv
}

k8s_job_diagnostics() {
  local ns="$1"
  local job="$2"
  local selector pod_selector pods pod uid
  say "$job diagnostics: job"
  kubectl -n "$ns" get job "$job" -o wide || true
  kubectl -n "$ns" describe job "$job" || true
  uid="$(kubectl -n "$ns" get job "$job" -o go-template='{{ index .spec.selector.matchLabels "batch.kubernetes.io/controller-uid" }}' 2>/dev/null || true)"
  if [ -n "$uid" ]; then
    pod_selector="batch.kubernetes.io/controller-uid=$uid"
  else
    pod_selector="job-name=$job"
  fi
  say "$job diagnostics: pods"
  kubectl -n "$ns" get pods -l "$pod_selector" -o wide || true
  pods="$(kubectl -n "$ns" get pods -l "$pod_selector" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  for pod in $pods; do
    say "$job diagnostics: pod detail $pod"
    kubectl -n "$ns" describe pod "$pod" || true
    say "$job diagnostics: logs $pod"
    kubectl -n "$ns" logs "$pod" --all-containers --tail=200 || true
    say "$job diagnostics: previous logs $pod"
    kubectl -n "$ns" logs "$pod" --all-containers --previous --tail=200 || true
  done
  selector="$(kubectl -n "$ns" get job "$job" -o jsonpath='{.spec.selector.matchLabels}' 2>/dev/null || true)"
  [ -n "$pod_selector" ] && say "$job diagnostics: pod selector $pod_selector"
  [ -n "$selector" ] && say "$job diagnostics: selector $selector"
  say "$job diagnostics: postgres service and endpoints"
  kubectl -n "$ns" get service,endpoints,endpointslices -l app.kubernetes.io/name=mx-internal-postgres -o wide || true
  kubectl -n "$ns" get service mx-internal-postgres -o wide || true
  kubectl -n "$ns" get endpoints mx-internal-postgres -o wide || true
  kubectl -n kube-system get service kube-dns -o wide || true
  kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide || true
  say "$job diagnostics: recent namespace events"
  kubectl -n "$ns" get events --sort-by=.lastTimestamp || true
}

k8s_wait_job_complete() {
  local ns="$1"
  local job="$2"
  local attempts="${3:-90}"
  local conditions i
  for i in $(seq 1 "$attempts"); do
    conditions="$(kubectl -n "$ns" get job "$job" -o jsonpath='{range .status.conditions[*]}{.type}{"="}{.status}{"\n"}{end}' 2>/dev/null || true)"
    if printf '%s\n' "$conditions" | grep -Fxq 'Complete=True'; then
      return 0
    fi
    if printf '%s\n' "$conditions" | grep -Fxq 'Failed=True'; then
      return 1
    fi
    sleep 2
  done
  return 1
}

k8s_workload_diagnostics() {
  local ns="$1"
  local kind="$2"
  local name="$3"
  local selector pods pod
  say "$kind/$name diagnostics: workload"
  kubectl -n "$ns" get "$kind/$name" -o wide || true
  kubectl -n "$ns" describe "$kind/$name" || true
  selector="$(kubectl -n "$ns" get "$kind/$name" -o jsonpath='{range $k,$v := .spec.selector.matchLabels}{$k}{"="}{$v}{","}{end}' 2>/dev/null | sed 's/,$//' || true)"
  if [ -n "$selector" ]; then
    say "$kind/$name diagnostics: pods"
    kubectl -n "$ns" get pods -l "$selector" -o wide || true
    pods="$(kubectl -n "$ns" get pods -l "$selector" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
    for pod in $pods; do
      say "$kind/$name diagnostics: pod $pod"
      kubectl -n "$ns" describe pod "$pod" || true
      say "$kind/$name diagnostics: logs $pod"
      kubectl -n "$ns" logs "$pod" --all-containers --tail=200 || true
    done
  fi
  say "$kind/$name diagnostics: recent namespace events"
  kubectl -n "$ns" get events --sort-by=.lastTimestamp || true
}

k8s_control_plane_component_pods() {
  local component="$1"
  local pods
  pods="$(kubectl -n kube-system get pods -l "component=$component" -o name 2>/dev/null || true)"
  if [ -z "$pods" ]; then
    pods="$(kubectl -n kube-system get pods -o name 2>/dev/null | grep "/$component-" || true)"
  fi
  printf '%s\n' "$pods"
}

k8s_control_plane_diagnostics() {
  local component pods pod
  say "control-plane diagnostics: nodes"
  kubectl get nodes -o wide || true
  say "control-plane diagnostics: kube-system pods"
  kubectl -n kube-system get pods -o wide || true
  for component in kube-apiserver kube-controller-manager kube-scheduler etcd; do
    pods="$(k8s_control_plane_component_pods "$component")"
    [ -n "$pods" ] || continue
    for pod in $pods; do
      say "control-plane diagnostics: describe $pod"
      kubectl -n kube-system describe "$pod" || true
      say "control-plane diagnostics: logs $pod"
      kubectl -n kube-system logs "$pod" --all-containers --tail=120 || true
    done
  done
}

k8s_workload_generation_stale() {
  local ns="$1"
  local kind="$2"
  local name="$3"
  local generation observed
  generation="$(kubectl -n "$ns" get "$kind/$name" -o jsonpath='{.metadata.generation}' 2>/dev/null || true)"
  observed="$(kubectl -n "$ns" get "$kind/$name" -o jsonpath='{.status.observedGeneration}' 2>/dev/null || true)"
  [ -n "$generation" ] && [ "$generation" != "$observed" ]
}

k8s_recover_stale_workload_controller() {
  local ns="$1"
  local kind="$2"
  local name="$3"
  local generation observed
  generation="$(kubectl -n "$ns" get "$kind/$name" -o jsonpath='{.metadata.generation}' 2>/dev/null || true)"
  observed="$(kubectl -n "$ns" get "$kind/$name" -o jsonpath='{.status.observedGeneration}' 2>/dev/null || true)"
  say "$kind/$name update not observed by controller-manager yet: generation=${generation:-?}, observed=${observed:-none}"
  k8s_control_plane_diagnostics
  if [ "${K8S_STATIC_CONTROLLER_RESTART_ATTEMPTED:-0}" = "1" ]; then
    return 0
  fi
  K8S_STATIC_CONTROLLER_RESTART_ATTEMPTED=1
  k8s_restart_static_pod_containers kube-controller-manager kube-scheduler || return 0
  k8s_wait_control_plane_observers || say "control-plane observers did not report Running after restart"
}

k8s_rollout_status() {
  local ns="$1"
  local kind="$2"
  local name="$3"
  local timeout="${4:-180s}"
  if k8s_workload_generation_stale "$ns" "$kind" "$name"; then
    k8s_recover_stale_workload_controller "$ns" "$kind" "$name"
  fi
  if kubectl -n "$ns" rollout status "$kind/$name" --timeout="$timeout"; then
    return 0
  fi
  if k8s_workload_generation_stale "$ns" "$kind" "$name"; then
    k8s_recover_stale_workload_controller "$ns" "$kind" "$name"
    kubectl -n "$ns" rollout status "$kind/$name" --timeout="$timeout"
    return
  fi
  return 1
}

k8s_cleanup_retired_internal_dns_edge() {
  local pods pod timeout
  timeout="${MX_K8S_RETIRED_DNS_EDGE_DELETE_TIMEOUT:-60s}"
  say "remove retired internal dns edge"
  kubectl -n mx-dns delete daemonset mx-internal-dns-edge --ignore-not-found --wait=false
  kubectl -n mx-dns delete configmap mx-internal-dns-edge --ignore-not-found
  pods="$(kubectl -n mx-dns get pods -o name 2>/dev/null | awk '/mx-internal-dns-edge/ {print}' || true)"
  [ -n "$pods" ] || return 0
  say "wait retired internal dns edge pods to exit"
  if kubectl -n mx-dns wait --for=delete $pods --timeout="$timeout"; then
    return 0
  fi
  say "force delete retired internal dns edge pods after $timeout"
  for pod in $pods; do
    kubectl -n mx-dns delete "$pod" --grace-period=0 --force --ignore-not-found || true
  done
}

k8s_restart_internal_coredns_if_unavailable() {
  [ "${MX_K8S_RESTART_INTERNAL_COREDNS_IF_UNAVAILABLE:-1}" = "1" ] || return 0
  local desired available
  desired="$(kubectl -n mx-dns get deployment mx-internal-coredns -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  available="$(kubectl -n mx-dns get deployment mx-internal-coredns -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)"
  desired="${desired:-1}"
  available="${available:-0}"
  if [ "$available" = "$desired" ]; then
    return 0
  fi
  say "restart internal coredns after Flannel recovery: available=$available desired=$desired"
  kubectl -n mx-dns rollout restart deployment/mx-internal-coredns
}

k8s_dry_run() {
  local target="$1"
  local ns dir
  ns="$(k8s_namespace "$target")"
  dir="$(k8s_manifest_dir "$target")"
  need_kubectl
  [ -d "$dir" ] || die "missing k8s manifest directory: $dir"
  say "dry-run namespace"
  kubectl apply --dry-run=client --validate=false -f "$dir/00-namespace.yaml"
  say "dry-run serviceaccount"
  kubectl apply --dry-run=client --validate=false -f "$dir/05-serviceaccount.yaml"
  say "dry-run configmap"
  kubectl apply --dry-run=client --validate=false -f "$dir/10-configmap.yaml"
  say "dry-run dns control target"
  kubectl apply --dry-run=client --validate=false -f "$dir/15-dns-control-target.yaml"
  say "dry-run local persistent volumes"
  kubectl apply --dry-run=client --validate=false -f "$dir/18-local-pv.yaml"
  say "dry-run generated db secret"
  k8s_secret_dry_run "$ns"
  say "dry-run postgres service/statefulset"
  kubectl apply --dry-run=client --validate=false -f "$dir/20-postgres.yaml"
  say "dry-run coredns writer rbac"
  kubectl apply --dry-run=client --validate=false -f "$dir/25-coredns-rbac.yaml"
  say "dry-run host runner rbac"
  kubectl apply --dry-run=client --validate=false -f "$dir/27-host-runner-rbac.yaml"
  say "dry-run migration job"
  kubectl apply --dry-run=client --validate=false -f "$dir/30-migration-job.yaml"
  say "dry-run internal api service/deployment"
  kubectl apply --dry-run=client --validate=false -f "$dir/40-internal-api.yaml"
  say "dry-run internal gateway"
  kubectl apply --dry-run=client --validate=false -f "$dir/45-internal-gateway.yaml"
  say "k8s dry-run OK"
}

k8s_apply() {
  local target="$1"
  local ns dir
  ns="$(k8s_namespace "$target")"
  dir="$(k8s_manifest_dir "$target")"
  need_kubectl
  [ -d "$dir" ] || die "missing k8s manifest directory: $dir"
  k8s_repair_kubeadm_endpoint
  k8s_repair_flannel_cni
  k8s_recover_cluster_dns

  say "apply namespace"
  kubectl apply --validate=false -f "$dir/00-namespace.yaml"
  say "apply serviceaccount"
  kubectl apply --validate=false -f "$dir/05-serviceaccount.yaml"
  say "apply configmap"
  kubectl apply --validate=false -f "$dir/10-configmap.yaml"
  say "apply dns control target"
  kubectl apply --validate=false -f "$dir/15-dns-control-target.yaml"
  k8s_cleanup_retired_internal_dns_edge
  k8s_restart_internal_coredns_if_unavailable
  say "wait internal coredns rollout"
  if ! k8s_rollout_status mx-dns deployment mx-internal-coredns 180s; then
    k8s_workload_diagnostics mx-dns deployment mx-internal-coredns
    die "internal coredns rollout failed"
  fi
  say "apply local persistent volumes"
  k8s_repair_internal_local_pvs
  kubectl apply --validate=false -f "$dir/18-local-pv.yaml"
  say "create/update db secret from local env"
  k8s_apply_db_secret "$ns"
  say "apply postgres service/statefulset"
  kubectl apply --validate=false -f "$dir/20-postgres.yaml"
  say "apply coredns writer rbac"
  kubectl apply --validate=false -f "$dir/25-coredns-rbac.yaml"
  say "apply host runner rbac"
  kubectl apply --validate=false -f "$dir/27-host-runner-rbac.yaml"
  say "wait postgres rollout"
  if ! k8s_rollout_status "$ns" statefulset mx-internal-postgres 180s; then
    k8s_postgres_diagnostics "$ns"
    die "postgres rollout failed"
  fi
  if ! k8s_postgres_service_ready "$ns" "${MX_K8S_POSTGRES_SERVICE_WAIT_ATTEMPTS:-60}"; then
    k8s_postgres_diagnostics "$ns"
    die "postgres service endpoints not ready"
  fi
  if ! k8s_select_postgres_database_host "$ns"; then
    k8s_postgres_diagnostics "$ns"
    die "postgres is not reachable from a cluster probe pod"
  fi
  say "update db secret with postgres host: $K8S_SELECTED_POSTGRES_HOST"
  DATABASE_HOST="$K8S_SELECTED_POSTGRES_HOST" k8s_apply_db_secret "$ns"

  say "check node disk pressure before migration"
  if [ "${MX_K8S_IGNORE_DISK_PRESSURE:-0}" = "1" ]; then
    say "skip node DiskPressure guard because MX_K8S_IGNORE_DISK_PRESSURE=1"
  elif k8s_node_disk_pressure_report "$ns"; then
    die "node DiskPressure detected before migration; free node/container-runtime disk and rerun deploy"
  fi

  say "run migration job"
  kubectl -n "$ns" delete job mx-launcher-migrate --ignore-not-found
  kubectl apply --validate=false -f "$dir/30-migration-job.yaml"
  if ! k8s_wait_job_complete "$ns" mx-launcher-migrate "${MX_K8S_MIGRATION_WAIT_ATTEMPTS:-90}"; then
    k8s_job_diagnostics "$ns" mx-launcher-migrate
    die "migration job failed"
  fi

  say "apply internal api"
  kubectl apply --validate=false -f "$dir/40-internal-api.yaml"
  say "wait internal api rollout"
  if ! k8s_rollout_status "$ns" deployment mx-launcher-internal 180s; then
    k8s_workload_diagnostics "$ns" deployment mx-launcher-internal
    die "internal api rollout failed"
  fi
  say "apply internal gateway"
  k8s_apply_internal_gateway "$target"
  say "wait internal gateway rollout"
  if ! k8s_rollout_status "$ns" daemonset mx-internal-gateway 180s; then
    k8s_workload_diagnostics "$ns" daemonset mx-internal-gateway
    die "internal gateway rollout failed"
  fi
  say "k8s apply OK"
}

k8s_status() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  kubectl -n "$ns" get pods,svc,deploy,statefulset,daemonset,job,pvc
  kubectl -n mx-dns get pods,svc,deploy,daemonset,configmap
}

k8s_logs() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  kubectl -n "$ns" logs deploy/mx-launcher-internal --tail=120
}

k8s_remote_runner() {
  local target="$1"
  local state="$2"
  local ns value
  ns="$(k8s_namespace "$target")"
  case "$state" in
    enable|enabled|on|1)
      value="1"
      ;;
    disable|disabled|off|0)
      value="0"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-local remote-runner enable|disable"
      ;;
  esac
  need_kubectl
  say "set remote runner gates=$value on Internal API deployment"
  kubectl -n "$ns" set env deployment/mx-launcher-internal \
    "SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED=$value" \
    "SITE_SLOT_WORKER_REMOTE_SSH=$value" \
    "SITE_SLOT_CONFIRM_REMOTE_EXECUTION=$value"
  k8s_rollout_status "$ns" deployment mx-launcher-internal 180s
}

k8s_ssh_bootstrap() {
  local target="$1"
  local state="$2"
  local ns value
  ns="$(k8s_namespace "$target")"
  case "$state" in
    enable|enabled|on|1)
      value="1"
      ;;
    disable|disabled|off|0)
      value="0"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-local ssh-bootstrap enable|disable"
      ;;
  esac
  need_kubectl
  say "set SITE_SLOT_SSH_PASSWORD_BOOTSTRAP_ENABLED=$value on Internal API deployment"
  kubectl -n "$ns" set env deployment/mx-launcher-internal "SITE_SLOT_SSH_PASSWORD_BOOTSTRAP_ENABLED=$value"
  k8s_rollout_status "$ns" deployment mx-launcher-internal 180s
}

k8s_readonly_probe() {
  local target="$1"
  local state="$2"
  local ns value
  ns="$(k8s_namespace "$target")"
  case "$state" in
    enable|enabled|on|1)
      value="1"
      ;;
    disable|disabled|off|0)
      value="0"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-local readonly-probe enable|disable"
      ;;
  esac
  need_kubectl
  say "set SITE_SLOT_SSH_READONLY_PROBE_EXECUTE=$value on Internal API deployment"
  kubectl -n "$ns" set env deployment/mx-launcher-internal "SITE_SLOT_SSH_READONLY_PROBE_EXECUTE=$value"
  k8s_rollout_status "$ns" deployment mx-launcher-internal 180s
}

k8s_db_summary() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  say "schema migrations"
  kubectl -n "$ns" exec statefulset/mx-internal-postgres -- \
    psql -U "${PG_USER:-mx_internal}" -d "${PG_DB:-mx_internal_shadow}" \
    -c "select count(*) as migration_rows from mx_schema_migrations;"
  say "platform records by kind"
  kubectl -n "$ns" exec statefulset/mx-internal-postgres -- \
    psql -U "${PG_USER:-mx_internal}" -d "${PG_DB:-mx_internal_shadow}" \
    -c "select kind, environment, count(*) from mx_platform_records group by kind, environment order by kind, environment;"
}

k8s_reset_data() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  if [ "${MX_K8S_SHADOW_CONFIRM_RESET:-}" != "1" ]; then
    die "Refusing to reset shadow data. Re-run with MX_K8S_SHADOW_CONFIRM_RESET=1 to truncate mx_platform_records."
  fi
  need_kubectl
  say "before reset"
  k8s_db_summary "$target"
  say "truncate mx_platform_records in namespace $ns"
  kubectl -n "$ns" exec statefulset/mx-internal-postgres -- \
    psql -v ON_ERROR_STOP=1 -U "${PG_USER:-mx_internal}" -d "${PG_DB:-mx_internal_shadow}" \
    -c "truncate table mx_platform_records;"
  say "restart Internal API so built-in records are seeded again"
  k8s_restart_internal_api "$target"
  say "after reset"
  k8s_db_summary "$target"
}

k8s_cleanup_smoke_fixtures() {
  local target="$1"
  local mode="${2:-plan}"
  local ns record_env legacy select_sql delete_sql
  ns="$(k8s_namespace "$target")"
  record_env="${MX_K8S_RECORD_ENVIRONMENT:-shadow}"
  legacy="${MX_K8S_CLEANUP_LEGACY_OVERSEA_MAIN_SMOKE:-0}"
  need_kubectl
  select_sql="$(cat <<'SQL'
WITH candidates AS (
  SELECT kind, id, environment, site_id, data
  FROM mx_platform_records
  WHERE environment = :'record_env'
    AND (
      site_id IN ('oversea-smoke', 'oversea-bootstrap-smoke', 'domestic-smoke')
      OR (kind = 'site-slot-ssh-profile' AND id LIKE 'sshprof_http_smoke%')
      OR (
        kind IN (
          'site-slot-plan',
          'site-slot-execution',
          'site-slot-runner-session',
          'site-slot-worker-job',
          'site-slot-worker-report',
          'site-slot-rollback-execution',
          'site-slot-rollback-report'
        )
        AND data::text LIKE '%http-smoke%'
      )
      OR (
        kind IN ('release-management-plan', 'test-run', 'test-gate-verdict', 'config-policy-snapshot', 'log-entry')
        AND data::text LIKE '%http-smoke%'
      )
      OR (
        :'legacy' = '1'
        AND (
          (site_id = 'oversea-main' AND data::text LIKE '%sshprof_http_smoke_oversea%')
          OR (
            kind IN ('launcher-network-mihomo-site', 'site-slot-access-account')
            AND site_id = 'oversea-main'
            AND ((data->>'createdBy') LIKE 'http-smoke%' OR (data->>'updatedBy') LIKE 'http-smoke%')
          )
        )
      )
    )
)
SELECT kind, id, COALESCE(site_id, '-') AS site_id, COALESCE(data->>'createdBy', '-') AS created_by, COALESCE(data->>'updatedBy', '-') AS updated_by
FROM candidates
ORDER BY kind, site_id, id;
SQL
)"
  delete_sql="$(cat <<'SQL'
WITH candidates AS (
  SELECT kind, id, environment, site_id, data
  FROM mx_platform_records
  WHERE environment = :'record_env'
    AND (
      site_id IN ('oversea-smoke', 'oversea-bootstrap-smoke', 'domestic-smoke')
      OR (kind = 'site-slot-ssh-profile' AND id LIKE 'sshprof_http_smoke%')
      OR (
        kind IN (
          'site-slot-plan',
          'site-slot-execution',
          'site-slot-runner-session',
          'site-slot-worker-job',
          'site-slot-worker-report',
          'site-slot-rollback-execution',
          'site-slot-rollback-report'
        )
        AND data::text LIKE '%http-smoke%'
      )
      OR (
        kind IN ('release-management-plan', 'test-run', 'test-gate-verdict', 'config-policy-snapshot', 'log-entry')
        AND data::text LIKE '%http-smoke%'
      )
      OR (
        :'legacy' = '1'
        AND (
          (site_id = 'oversea-main' AND data::text LIKE '%sshprof_http_smoke_oversea%')
          OR (
            kind IN ('launcher-network-mihomo-site', 'site-slot-access-account')
            AND site_id = 'oversea-main'
            AND ((data->>'createdBy') LIKE 'http-smoke%' OR (data->>'updatedBy') LIKE 'http-smoke%')
          )
        )
      )
    )
)
DELETE FROM mx_platform_records r
USING candidates c
WHERE r.kind = c.kind
  AND r.id = c.id
  AND r.environment = c.environment
RETURNING r.kind, r.id, COALESCE(r.site_id, '-') AS site_id;
SQL
)"
  say "smoke fixture cleanup candidates (env=$record_env, legacy-oversea-main=$legacy)"
  printf '%s\n' "$select_sql" | kubectl -n "$ns" exec -i statefulset/mx-internal-postgres -- \
    psql -v ON_ERROR_STOP=1 -v record_env="$record_env" -v legacy="$legacy" \
      -U "${PG_USER:-mx_internal}" -d "${PG_DB:-mx_internal_shadow}"
  case "$mode" in
    --apply|apply)
      say "delete smoke fixture records"
      printf '%s\n' "$delete_sql" | kubectl -n "$ns" exec -i statefulset/mx-internal-postgres -- \
        psql -v ON_ERROR_STOP=1 -v record_env="$record_env" -v legacy="$legacy" \
          -U "${PG_USER:-mx_internal}" -d "${PG_DB:-mx_internal_shadow}"
      ;;
    plan|dry-run|'')
      say "dry-run only. Re-run with --apply to delete listed smoke fixtures."
      ;;
    *)
      die "Usage: bash scripts/manage.sh k8s cleanup-smoke-fixtures internal-shadow [--apply]"
      ;;
  esac
}

k8s_smoke() {
  local target="$1"
  local requested_port="${2:-18090}"
  local port
  local ns pf_pid
  ns="$(k8s_namespace "$target")"
  port="$(k8s_smoke_port "$requested_port")"
  need_kubectl
  say "port-forward mx-launcher-internal on 127.0.0.1:${port}"
  kubectl -n "$ns" port-forward svc/mx-launcher-internal "$port:18090" >/tmp/mx-launcher-k8s-port-forward.log 2>&1 &
  pf_pid="$!"
  sleep 2
  if ! (cd server && MX_SMOKE_EXPECT_K8S_APPLY=1 pnpm run smoke:http -- "http://127.0.0.1:${port}"); then
    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
    die "k8s smoke failed; see /tmp/mx-launcher-k8s-port-forward.log"
  fi
  kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true
}

k8s_gateway_smoke() {
  local target="$1"
  local gateway_url="${2:-${MX_INTERNAL_GATEWAY_URL:-http://127.0.0.1:18090}}"
  need_kubectl
  say "gateway rollout status"
  k8s_rollout_status "$(k8s_namespace "$target")" daemonset mx-internal-gateway 180s
  say "read-only gateway health check: $gateway_url"
  node -e '
    const base = process.argv[1].replace(/\/+$/, "");
    async function check(path) {
      const response = await fetch(`${base}${path}`);
      const text = await response.text();
      if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status} ${text}`);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`${path} returned non-JSON response: ${text}`);
      }
      if (body?.ok !== true) throw new Error(`${path} returned unexpected payload: ${text}`);
      console.log(`OK ${path}`);
    }
    check("/healthz").then(() => check("/readyz")).catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
  ' "$gateway_url"
}

k8s_port_forward() {
  local target="$1"
  local local_port="${2:-18090}"
  local bind_address="${3:-${MX_K8S_PORT_FORWARD_ADDRESS:-127.0.0.1}}"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  say "keep Internal API exposed on http://${bind_address}:${local_port}"
  say "target namespace: $ns"
  if [ "$bind_address" != "127.0.0.1" ] && [ "$bind_address" != "localhost" ]; then
    say "dev-only LAN exposure; keep this behind a trusted network/firewall"
  fi
  say "press Ctrl+C in this terminal when you are done"
  kubectl -n "$ns" port-forward --address "$bind_address" svc/mx-launcher-internal "${local_port}:18090"
}

k8s_internal_shadow_gate() {
  local target="$1"
  local requested_port="${2:-18090}"
  local ns port pf_pid gate_dir status_file db_file
  ns="$(k8s_namespace "$target")"
  port="$(k8s_smoke_port "$requested_port")"
  gate_dir="$ROOT/server/artifacts/internal-shadow-gates/$(date -u +%Y%m%dT%H%M%SZ)"
  status_file="$gate_dir/k8s-status.txt"
  db_file="$gate_dir/db-summary.txt"
  need_kubectl
  mkdir -p "$gate_dir"
  say "capture k8s rollout snapshot"
  kubectl -n "$ns" get deploy,statefulset,pod,svc,job,pvc -o wide >"$status_file"
  say "capture db summary"
  k8s_db_summary "$target" >"$db_file"
  say "port-forward mx-launcher-internal on 127.0.0.1:${port}"
  kubectl -n "$ns" port-forward svc/mx-launcher-internal "$port:18090" >/tmp/mx-launcher-k8s-port-forward.log 2>&1 &
  pf_pid="$!"
  sleep 2
  if ! (
    cd server
    MX_INTERNAL_SHADOW_GATE_OUTPUT_DIR="$gate_dir" \
      MX_INTERNAL_SHADOW_GATE_K8S_STATUS_FILE="$status_file" \
      MX_INTERNAL_SHADOW_GATE_DB_SUMMARY_FILE="$db_file" \
      MX_INTERNAL_SHADOW_GATE_REQUIRE_K8S_FILES=1 \
      MX_INTERNAL_SHADOW_GATE_EXPECT_K8S_APPLY=1 \
      node scripts/internal-shadow-gate.mjs "http://127.0.0.1:${port}"
  ); then
    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
    die "internal shadow gate failed; see $gate_dir and /tmp/mx-launcher-k8s-port-forward.log"
  fi
  kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true
  say "internal shadow gate OK; evidence: $gate_dir"
}

k8s_internal_shadow_gate_manual() {
  local target="$1"
  local evidence_path="$2"
  local port="${3:-18090}"
  [ -n "$evidence_path" ] || die "Usage: bash scripts/manage.sh k8s gate-manual internal-shadow <evidence-json> [local-port]"
  case "$evidence_path" in
    /*)
      ;;
    *)
      evidence_path="$ROOT/$evidence_path"
      ;;
  esac
  MX_INTERNAL_SHADOW_MANUAL_EVIDENCE_PATH="$evidence_path" \
    MX_INTERNAL_SHADOW_REQUIRE_MANUAL_EVIDENCE=1 \
    k8s_internal_shadow_gate "$target" "$port"
}

internal_shadow_manual_evidence() {
  local status="${1:-passed}"
  shift || true
  (cd server && node scripts/internal-shadow-manual-evidence.mjs "$status" "$@")
}

k8s_down() {
  local target="$1"
  local ns dir
  ns="$(k8s_namespace "$target")"
  dir="$(k8s_manifest_dir "$target")"
  need_kubectl
  [ -d "$dir" ] || die "missing k8s manifest directory: $dir"
  k8s_cleanup_retired_internal_dns_edge
  say "delete internal gateway"
  kubectl delete -f "$dir/45-internal-gateway.yaml" --ignore-not-found
  say "delete internal api"
  kubectl delete -f "$dir/40-internal-api.yaml" --ignore-not-found
  say "delete migration job"
  kubectl -n "$ns" delete job mx-launcher-migrate --ignore-not-found
  say "delete coredns writer rbac"
  kubectl delete -f "$dir/25-coredns-rbac.yaml" --ignore-not-found
  say "delete host runner rbac"
  kubectl delete -f "$dir/27-host-runner-rbac.yaml" --ignore-not-found
  say "delete postgres workload and service; PVC is kept"
  kubectl delete -f "$dir/20-postgres.yaml" --ignore-not-found
  say "delete dns control target"
  kubectl delete -f "$dir/15-dns-control-target.yaml" --ignore-not-found
  say "delete configmap and generated secret"
  kubectl delete -f "$dir/10-configmap.yaml" --ignore-not-found
  kubectl delete -f "$dir/05-serviceaccount.yaml" --ignore-not-found
  kubectl -n "$ns" delete secret mx-launcher-db --ignore-not-found
  say "namespace and PVC are kept for safe restart"
}

awx_shadow_namespace() {
  echo "mx-awx"
}

awx_shadow_name() {
  echo "mx-awx"
}

awx_shadow_manifest_dir() {
  echo "$ROOT/deploy/k8s/awx-shadow"
}

awx_shadow_operator_ref() {
  echo "${MX_AWX_OPERATOR_REF:-2.19.1}"
}

awx_shadow_kustomize_dir() {
  local dir ref safe_ref tmp
  dir="$(awx_shadow_manifest_dir)"
  ref="$(awx_shadow_operator_ref)"
  [ -d "$dir" ] || die "missing AWX shadow manifest directory: $dir"
  if [ "$ref" = "2.19.1" ]; then
    echo "$dir"
    return
  fi
  safe_ref="${ref//[^A-Za-z0-9._-]/_}"
  tmp="${TMPDIR:-/tmp}/mx-awx-shadow-kustomize-$safe_ref"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  sed "s|ref=2.19.1|ref=$ref|g; s|newTag: 2.19.1|newTag: $ref|g" "$dir/kustomization.yaml" >"$tmp/kustomization.yaml"
  echo "$tmp"
}

awx_shadow_plan() {
  local ns name ref
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  ref="$(awx_shadow_operator_ref)"
  cat <<EOF
MX Launcher AWX shadow plan

Namespace: $ns
AWX name:  $name
Operator:  ansible/awx-operator $ref

Order:
  1. Apply namespace.
  2. Apply pinned AWX Operator manifests through Kustomize.
  3. Wait for AWX CRD to become Established.
  4. Create AWX custom resource $name.
  5. Wait for awx-operator-controller-manager rollout.
  6. Watch AWX web/task/postgres pods until the instance is ready.
  7. Read admin password from secret ${name}-admin-password.
  8. Port-forward service ${name}-service when local browser/API access is needed.
  9. Upsert an Internal awx-provider that points to:
     http://${name}-service.${ns}.svc.cluster.local

Boundary:
  AWX is an execution provider. Internal remains the source of truth for
  plans, worker jobs, evidence, audit, RBAC, rollback, and release gates.

Resource note:
  Docker Desktop Kubernetes should usually have about 6-8GB RAM, 4 CPUs,
  and 20-40GB free disk for comfortable local AWX testing.
EOF
}

awx_shadow_dry_run() {
  local dir kdir
  dir="$(awx_shadow_manifest_dir)"
  kdir="$(awx_shadow_kustomize_dir)"
  need_kubectl
  say "dry-run AWX Operator manifests"
  kubectl apply --dry-run=client --validate=false -k "$kdir"
  if kubectl get crd awxs.awx.ansible.com >/dev/null 2>&1; then
    say "dry-run mx-awx AWX custom resource"
    kubectl apply --dry-run=client --validate=false -f "$dir/10-awx.yaml"
  else
    say "skip mx-awx AWX custom resource dry-run because awxs.awx.ansible.com CRD is not installed yet"
  fi
}

awx_shadow_install() {
  local ns name dir kdir operator_timeout awx_timeout i
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  dir="$(awx_shadow_manifest_dir)"
  kdir="$(awx_shadow_kustomize_dir)"
  operator_timeout="${MX_AWX_OPERATOR_TIMEOUT:-180s}"
  awx_timeout="${MX_AWX_READY_TIMEOUT_SECONDS:-900}"
  need_kubectl
  say "apply AWX Operator manifests"
  kubectl apply -k "$kdir"
  say "wait AWX CRD"
  kubectl wait --for=condition=Established crd/awxs.awx.ansible.com --timeout="$operator_timeout"
  say "apply mx-awx AWX custom resource"
  kubectl apply -f "$dir/10-awx.yaml"
  say "wait AWX Operator rollout"
  kubectl -n "$ns" rollout status deployment/awx-operator-controller-manager --timeout="$operator_timeout"
  say "wait for AWX workloads to appear"
  for i in $(seq 1 "$awx_timeout"); do
    if kubectl -n "$ns" get deployment "$name-web" >/dev/null 2>&1 \
      && kubectl -n "$ns" get deployment "$name-task" >/dev/null 2>&1 \
      && kubectl -n "$ns" get statefulset "$name-postgres-15" >/dev/null 2>&1; then
      say "wait AWX web rollout"
      kubectl -n "$ns" rollout status deployment/"$name-web" --timeout=900s
      say "wait AWX task rollout"
      kubectl -n "$ns" rollout status deployment/"$name-task" --timeout=900s
      say "wait AWX postgres rollout"
      kubectl -n "$ns" rollout status statefulset/"$name-postgres-15" --timeout=900s
      awx_shadow_status
      say "AWX shadow install OK"
      return
    fi
    sleep 1
  done
  awx_shadow_status
  die "AWX web/task/postgres workloads did not appear before timeout; inspect operator logs with ops awx-shadow logs"
}

awx_shadow_status() {
  local ns
  ns="$(awx_shadow_namespace)"
  need_kubectl
  kubectl -n "$ns" get awx,deploy,statefulset,pod,svc,pvc 2>/dev/null || kubectl -n "$ns" get all
}

awx_shadow_logs() {
  local ns
  ns="$(awx_shadow_namespace)"
  need_kubectl
  kubectl -n "$ns" logs deployment/awx-operator-controller-manager -c awx-manager --tail=200
}

awx_shadow_port_forward() {
  local ns name local_port
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  local_port="${1:-18080}"
  need_kubectl
  say "keep AWX exposed on http://127.0.0.1:${local_port}"
  say "target service: ${name}-service.${ns}.svc.cluster.local:80"
  say "press Ctrl+C in this terminal when you are done"
  kubectl -n "$ns" port-forward svc/"$name-service" "${local_port}:80"
}

awx_shadow_password() {
  local ns name encoded
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  need_kubectl
  encoded="$(kubectl -n "$ns" get secret "$name-admin-password" -o jsonpath='{.data.password}')"
  [ -n "$encoded" ] || die "AWX admin password secret is empty or not ready: $name-admin-password"
  node -e 'console.log(Buffer.from(process.argv[1], "base64").toString("utf8"))' "$encoded"
}

awx_shadow_down() {
  local ns name
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  need_kubectl
  say "scale AWX workloads to zero; namespace, CR, Secret, and PVC are kept"
  kubectl -n "$ns" scale deployment/"$name" --replicas=0 2>/dev/null || true
  kubectl -n "$ns" scale statefulset/"$name-postgres" --replicas=0 2>/dev/null || true
  kubectl -n "$ns" scale deployment/awx-operator-controller-manager --replicas=0 2>/dev/null || true
  say "AWX shadow stopped. Re-run 'bash scripts/manage.sh ops awx-shadow install' to reconcile it again."
}

ops_awx_shadow() {
  local action="$1"
  shift || true
  case "$action" in
    plan)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow plan"
      awx_shadow_plan
      ;;
    dry-run)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow dry-run"
      awx_shadow_dry_run
      ;;
    install|apply|up)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow install"
      awx_shadow_install
      ;;
    status)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow status"
      awx_shadow_status
      ;;
    port-forward|forward)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops awx-shadow port-forward [local-port]"
      awx_shadow_port_forward "${1:-18080}"
      ;;
    logs)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow logs"
      awx_shadow_logs
      ;;
    password)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow password"
      awx_shadow_password
      ;;
    down)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow down"
      awx_shadow_down
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops awx-shadow plan|dry-run|install|status|port-forward [local-port]|logs|password|down"
      ;;
  esac
}

ops_awx_provider() {
  local action="$1"
  shift || true
  local base="${MX_INTERNAL_BASE_URL:-http://127.0.0.1:18090}"
  case "$action" in
    list)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-provider list"
      node -e '
        const [base] = process.argv.slice(1);
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/awx-providers`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            providers: payload.providers.map((provider) => ({
              providerId: provider.providerId,
              name: provider.name,
              baseUrl: provider.baseUrl,
              organization: provider.organization,
              project: provider.project,
              defaultKind: provider.defaultKind,
              status: provider.status,
              inventoryPrefix: provider.inventoryPrefix,
              credentialPrefix: provider.credentialPrefix,
              jobTemplatePrefix: provider.jobTemplatePrefix,
              updatedAt: provider.updatedAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base"
      ;;
    upsert)
      [ "$#" -le 2 ] || die "Usage: bash scripts/manage.sh ops awx-provider upsert [provider-id] [base-url]"
      node -e '
        const [base, providerId = "", baseUrl = ""] = process.argv.slice(1);
        const body = {
          providerId: providerId || process.env.SITE_SLOT_AWX_PROVIDER_ID || "awxprov_oversea",
          name: process.env.SITE_SLOT_AWX_PROVIDER_NAME || "MX AWX Oversea",
          baseUrl: baseUrl || process.env.AWX_BASE_URL || "http://mx-awx-service.mx-awx.svc.cluster.local",
          organization: process.env.AWX_ORGANIZATION || "MX Internal",
          project: process.env.AWX_PROJECT || "mx-launcher-site-slots",
          inventoryPrefix: process.env.AWX_INVENTORY_PREFIX || "mx",
          credentialPrefix: process.env.AWX_CREDENTIAL_PREFIX || "mx",
          jobTemplatePrefix: process.env.AWX_JOB_TEMPLATE_PREFIX || "mx-site-slot",
          defaultKind: process.env.AWX_DEFAULT_KIND || "oversea",
          status: process.env.AWX_PROVIDER_STATUS || "active",
          verifyTls: process.env.AWX_VERIFY_TLS === "0" ? false : true,
          requestTimeoutSeconds: Number(process.env.AWX_REQUEST_TIMEOUT_SECONDS || "30"),
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-awx-provider-upsert"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/awx-providers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({ provider: payload.provider }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}" "${2:-}"
      ;;
    check)
      [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh ops awx-provider check <provider-id>"
      node -e '
        const [base, providerId] = process.argv.slice(1);
        const body = {
          token: process.env.SITE_SLOT_AWX_TOKEN || process.env.AWX_TOKEN || "",
          kind: process.env.AWX_CHECK_KIND || "oversea",
          requestTimeoutSeconds: Number(process.env.AWX_REQUEST_TIMEOUT_SECONDS || "30"),
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-awx-provider-check"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/awx-providers/${encodeURIComponent(providerId)}/check`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({ check: payload.check }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1"
      ;;
    mock-smoke)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-provider mock-smoke"
      MX_INTERNAL_BASE_URL="$base" node server/scripts/awx-api-mock-smoke.mjs
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops awx-provider list|upsert [provider-id] [base-url]|check <provider-id>|mock-smoke"
      ;;
  esac
}

ops_local_platform_plan() {
  cat <<'EOF'
MX Launcher local-platform plan

This is the explicit one-command path for a full local platform stack.
It keeps the default platform cycle independent from optional AWX tooling.

Order:
  1. Build and apply Internal K8s shadow in namespace mx-internal-shadow.
  2. Run Internal HTTP smoke and DB summary.
  3. Temporarily port-forward Internal API when needed.

Commands:
  bash scripts/manage.sh ops local-platform dry-run
  bash scripts/manage.sh ops local-platform cycle
  bash scripts/manage.sh ops local-platform status
  bash scripts/manage.sh ops local-platform down

Notes:
  - AWX remains available only as an explicit optional path:
    bash scripts/manage.sh ops awx-shadow install
EOF
}

ops_local_platform_cleanup_host_runner_fallback() {
  local namespace="${MX_INTERNAL_HOST_RUNNER_K8S_NAMESPACE:-mx-internal-shadow}"
  local name="${MX_INTERNAL_HOST_RUNNER_K8S_NAME:-mx-internal-host-runner}"
  say "remove stale k8s Internal host-runner fallback ($namespace/$name)"
  kubectl -n "$namespace" delete daemonset "$name" --ignore-not-found
  kubectl -n "$namespace" delete service "$name" --ignore-not-found
}

ops_local_platform_detect_host_runner_url() {
  if [ -n "${MX_INTERNAL_HOST_RUNNER_URL:-}" ]; then
    printf '%s\n' "${MX_INTERNAL_HOST_RUNNER_URL%/}"
    return 0
  fi
  if [ -n "${MX_INTERNAL_HOST_RUNNER_NATIVE_URL:-}" ]; then
    printf '%s\n' "${MX_INTERNAL_HOST_RUNNER_NATIVE_URL%/}"
    return 0
  fi

  local host_ip default_if
  if command -v ipconfig >/dev/null 2>&1; then
    default_if="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
    if [ -n "$default_if" ]; then
      host_ip="$(ipconfig getifaddr "$default_if" 2>/dev/null || true)"
    fi
  fi
  if [ -z "${host_ip:-}" ] && command -v ip >/dev/null 2>&1; then
    host_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')"
  fi
  if [ -z "${host_ip:-}" ] && command -v hostname >/dev/null 2>&1; then
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1; exit}')"
  fi
  if [ -n "${host_ip:-}" ]; then
    printf 'http://%s:%s\n' "$host_ip" "${MX_INTERNAL_HOST_RUNNER_PORT:-19190}"
    return 0
  fi
  printf 'http://host.docker.internal:%s\n' "${MX_INTERNAL_HOST_RUNNER_PORT:-19190}"
}

ops_local_platform_apply_native_host_runner_url() {
  local namespace url
  namespace="${MX_INTERNAL_HOST_RUNNER_K8S_NAMESPACE:-mx-internal-shadow}"
  url="$(ops_local_platform_detect_host_runner_url)"
  say "point Internal API at native host runner: $url"
  kubectl -n "$namespace" set env deployment/mx-launcher-internal \
    MX_INTERNAL_HOST_RUNNER_URL="$url" \
    MX_INTERNAL_HOST_RUNNER_NATIVE_URL="$url" >/dev/null
  k8s_rollout_status "$namespace" deployment mx-launcher-internal 180s
}

ops_local_platform() {
  local action="$1"
  shift || true
  case "$action" in
    plan)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops local-platform plan"
      ops_local_platform_plan
      ;;
    dry-run)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops local-platform dry-run"
      say "dry-run Internal K8s shadow"
      k8s_dry_run internal-shadow
      ;;
    cycle)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops local-platform cycle [local-port]"
      ops_local_platform_plan
      ops_local_platform_cleanup_host_runner_fallback
      say "cycle Internal K8s shadow"
      ops_k8s_shadow cycle "${1:-18090}"
      ops_local_platform_apply_native_host_runner_url
      ops_local_platform_cleanup_host_runner_fallback
      say "local-platform cycle OK. Use 'bash scripts/manage.sh ops local-platform status' to inspect it."
      ;;
    status)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops local-platform status"
      say "Internal K8s shadow status"
      k8s_status internal-shadow
      ;;
    down)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops local-platform down"
      say "stop Internal K8s shadow"
      k8s_down internal-shadow
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops local-platform plan|dry-run|cycle [local-port]|status|down"
      ;;
  esac
}

ops_guide() {
  cat <<'EOF'
MX Launcher local operator guide

Start here:
  cd electron-dock/mx-launcher
  bash scripts/manage.sh
  bash scripts/manage.sh ops doctor

Interactive local K8s/Internal test path:
  1. status            confirm node/pnpm/docker/kubectl and current namespace state
  3. k8s-plan          review the local Internal K8s rollout order
  4. k8s-dry-run       validate manifests and generated DB Secret
  7. k8s-cycle         build image, apply K8s, restart API, smoke, DB summary
  8. k8s-gate          run Internal Local Gate and record Test Center evidence
  9. k8s-smoke         rerun HTTP smoke through a temporary port-forward
  10. k8s-db           inspect seeded Internal state
  11. k8s-logs         inspect Internal API logs
  12. browser          print the persistent port-forward + browser manual test steps
  13. manual-evidence  write browser/Evidence Drawer evidence JSON after hand testing
  17. reset-data       clear local Internal business records for a fresh manual test
  18. remote-runner    temporarily enable/disable remote runner for true-host readonly tests
      readonly-probe   temporarily enable/disable real readonly SSH probe execution
      ssh-bootstrap    temporarily enable/disable one-time SSH password key bootstrap
  21. oversea-readonly run a true Oversea read-only SSH probe and record worker evidence
  22. oversea-remote   run a true Oversea gated pipeline or remote install
  23. down             stop workloads while keeping the PostgreSQL PVC

Path A: Docker Compose shadow, no K8s knowledge required.
  bash scripts/manage.sh ops local-shadow plan
  bash scripts/manage.sh ops local-shadow cycle

Path B: K8s learning path, safe dry-run first.
  bash scripts/manage.sh ops internal-local plan
  bash scripts/manage.sh ops internal-local dry-run

Path C: K8s deploy on Docker Desktop or a prepared Internal cluster.
  # Internal-only; does not install or restart AWX.
  bash scripts/manage.sh ops internal-local cycle
  bash scripts/manage.sh ops internal-local apply
  bash scripts/manage.sh ops internal-local status
  bash scripts/manage.sh ops internal-local port-forward
  bash scripts/manage.sh ops internal-local gate
  bash scripts/manage.sh ops internal-local manual-evidence passed "browser manual path passed"
  bash scripts/manage.sh ops internal-local gate-manual server/artifacts/internal-shadow-gates/manual/manual-browser-evidence-xxx.json
  bash scripts/manage.sh ops internal-local smoke
  bash scripts/manage.sh ops internal-local db-summary
  MX_K8S_SHADOW_CONFIRM_RESET=1 bash scripts/manage.sh ops internal-local reset-data
  bash scripts/manage.sh ops internal-local remote-runner enable
  bash scripts/manage.sh ops internal-local readonly-probe enable
  bash scripts/manage.sh ops internal-local ssh-bootstrap enable
  bash scripts/manage.sh ops internal-local logs
  bash scripts/manage.sh ops internal-local down

Path D: AWX shadow execution provider.
  bash scripts/manage.sh ops awx-shadow plan
  bash scripts/manage.sh ops awx-shadow dry-run
  bash scripts/manage.sh ops awx-shadow install
  bash scripts/manage.sh ops awx-shadow status
  bash scripts/manage.sh ops awx-shadow password
  bash scripts/manage.sh ops awx-shadow port-forward 18080
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops awx-provider upsert awxprov_oversea
  SITE_SLOT_AWX_TOKEN="$AWX_TOKEN" MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops awx-provider check awxprov_oversea
  bash scripts/manage.sh ops awx-shadow down

Path E: full local platform stack, explicit one-command path.
  bash scripts/manage.sh ops local-platform plan
  bash scripts/manage.sh ops local-platform cycle
  bash scripts/manage.sh ops local-platform status
  bash scripts/manage.sh ops local-platform down

Path F: Internal-owned site slot planning.
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot ssh-profile-upsert oversea-main oversea oversea.example.com
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops config feature-set site-slot.ssh-readonly-probe.execute true readonly-execute profile sshprof_oversea-main
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot ssh-profile-readiness sshprof_oversea-main plan-only
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519 \
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts \
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot oversea-readonly-test oversea-main oversea.example.com
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519 \
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts \
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot oversea-remote-test oversea-main oversea.example.com pipeline
  SITE_SLOT_CONFIRM_OVERSEA_EXECUTE=1 \
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519 \
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts \
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot oversea-remote-test oversea-main oversea.example.com execute
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot oversea-plan oversea.example.com
  bash scripts/manage.sh ops site-slot materialize oversea
  bash scripts/manage.sh ops site-slot refresh-tunnel-cli latest
  # Or after syncing a published npm tarball into Internal:
  bash scripts/manage.sh ops site-slot refresh-tunnel-cli --from-tarball /path/to/qpjoy-tunnel-cli.tgz
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot domestic-plan domestic.example.com oversea.example.com
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot preflight slotplan_xxx
  SITE_SLOT_CONFIRM_APPLY=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot apply slotplan_xxx
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot runner-start slotexec_xxx
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot worker-job slotrunner_xxx
  SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot worker-gate slotjob_xxx confirm
  SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 SITE_SLOT_CONFIRM_WORKER_HANDOFF=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot worker-handoff slotjob_xxx confirm

Path G: Admin management snapshots.
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops admin dashboard
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops admin actions
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops admin site-slot-pipelines slotplan_xxx

Mental model:
  Compose "service"      -> K8s Deployment/StatefulSet
  Compose "environment"  -> K8s ConfigMap/Secret
  Compose "volume"       -> K8s PersistentVolumeClaim
  Compose "healthcheck"  -> K8s liveness/readiness probes
  One-time migration     -> K8s Job

Safe cleanup:
  local-shadow down stops Compose containers and keeps the PG Docker volume.
  internal-local down removes workloads and keeps the K8s PVC.
  internal-local reset-data truncates mx_platform_records, keeps migrations/PVC,
  and restarts Internal API to re-seed built-in records.
EOF
}

ops_doctor() {
  say "MX Launcher root: $ROOT"
  command -v node >/dev/null 2>&1 && say "node: $(node --version)" || say "node: missing"
  command -v pnpm >/dev/null 2>&1 && say "pnpm: $(pnpm --version)" || say "pnpm: missing"
  command -v docker >/dev/null 2>&1 && say "docker: $(docker --version)" || say "docker: missing"
  command -v kubectl >/dev/null 2>&1 && say "kubectl: $(kubectl version --client 2>/dev/null | head -n 1)" || say "kubectl: missing"
  [ -f server/package.json ] && say "server package: OK" || say "server package: missing"
  [ -f server/docker-compose.shadow.yml ] && say "shadow compose: OK" || say "shadow compose: missing"
  [ -d deploy/k8s/internal-shadow ] && say "k8s internal-shadow manifests: OK" || say "k8s internal-shadow manifests: missing"
  [ -d deploy/k8s/awx-shadow ] && say "k8s awx-shadow manifests: OK" || say "k8s awx-shadow manifests: missing"
  say "doctor finished. If docker/kubectl checks are missing, start Docker Desktop and enable Kubernetes before K8s apply."
}

ops_config() {
  local action="$1"
  shift || true
  local base="${MX_INTERNAL_BASE_URL:-http://127.0.0.1:18090}"
  case "$action" in
    feature-list)
      node -e '
        const [base, featureKey = ""] = process.argv.slice(1);
        const query = featureKey ? `?featureKey=${encodeURIComponent(featureKey)}` : "";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/runtime-feature-policies${query}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            policies: payload.policies.map((policy) => ({
              policyId: policy.policyId,
              featureKey: policy.featureKey,
              scopeKind: policy.scopeKind,
              scopeId: policy.scopeId,
              enabled: policy.enabled,
              mode: policy.mode,
              expiresAt: policy.expiresAt,
              requiresApproval: policy.requiresApproval,
              updatedBy: policy.updatedBy,
              updatedAt: policy.updatedAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    feature-set)
      [ "$#" -ge 2 ] || die "Usage: bash scripts/manage.sh ops config feature-set <feature-key> <true|false> [plan-only|readonly-execute|remote-execute|disabled] [global|site|profile] [scope-id]"
      node -e '
        const [base, featureKey, enabledRaw, mode = "plan-only", scopeKind = "global", scopeId = ""] = process.argv.slice(1);
        const body = {
          featureKey,
          enabled: enabledRaw === "true" || enabledRaw === "1" || enabledRaw === "yes",
          mode,
          scopeKind,
          scopeId: scopeKind === "global" ? null : scopeId || null,
          requiresApproval: true,
          reason: process.env.MX_RUNTIME_FEATURE_REASON || "manage.sh feature-set",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-config-feature-set"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/runtime-feature-policies`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({ policy: payload.policy }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "$2" "${3:-plan-only}" "${4:-global}" "${5:-}"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops config feature-list [feature-key] | feature-set <feature-key> <true|false> [plan-only|readonly-execute|remote-execute|disabled] [global|site|profile] [scope-id]"
      ;;
  esac
}

ops_admin() {
  local action="$1"
  shift || true
  local base="${MX_INTERNAL_BASE_URL:-http://127.0.0.1:18090}"
  case "$action" in
    dashboard)
      node -e '
        const [base] = process.argv.slice(1);
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/admin/dashboard`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            generatedAt: payload.generatedAt,
            overview: {
              environment: payload.overview.environment,
              siteId: payload.overview.siteId,
              storeDriver: payload.overview.storeDriver,
              siteSlotPlans: payload.overview.siteSlotPlans,
              siteSlotRollbackExecutions: payload.overview.siteSlotRollbackExecutions,
              releaseManagementPlans: payload.overview.releaseManagementPlans,
              testRuns: payload.overview.testRuns
            },
            actionPolicy: {
              principal: payload.actionPolicy.principal,
              warnings: payload.actionPolicy.warnings,
              allowedActions: payload.actionPolicy.actions
                .filter((action) => action.allowed)
                .map((action) => action.actionId)
            },
            latestReleasePlans: payload.latestReleasePlans.map((plan) => ({
              planId: plan.planId,
              releaseId: plan.releaseId,
              readyToPromote: plan.decisions.readyToPromote,
              gate: plan.test.gate.verdict,
              createdAt: plan.createdAt
            })),
            siteSlotPipelines: payload.siteSlotPipelines.map((pipeline) => ({
              planId: pipeline.planId,
              siteId: pipeline.siteId,
              kind: pipeline.kind,
              health: pipeline.health,
              currentStage: pipeline.currentStage,
              latestStatus: pipeline.latestStatus,
              counts: pipeline.counts,
              latestUpdatedAt: pipeline.latestUpdatedAt
            })),
            nextActions: payload.nextActions
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base"
      ;;
    actions)
      node -e '
        const [base, token = ""] = process.argv.slice(1);
        const query = token ? `?token=${encodeURIComponent(token)}` : "";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/admin/actions${query}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            principal: payload.actionPolicy.principal,
            warnings: payload.actionPolicy.warnings,
            actions: payload.actionPolicy.actions.map((action) => ({
              actionId: action.actionId,
              label: action.label,
              category: action.category,
              gate: action.gate,
              risk: action.risk,
              allowed: action.allowed,
              reason: action.reason,
              requiredScopes: action.requiredScopes
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    site-slot-pipelines)
      node -e '
        const [base, planId = ""] = process.argv.slice(1);
        const path = planId
          ? `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(planId)}`
          : "/internal/v1/admin/site-slots/pipelines";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}${path}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          if (payload.pipeline) {
            const pipeline = payload.pipeline;
            console.log(JSON.stringify({
              summary: pipeline.summary,
              executions: pipeline.executions.map((execution) => ({
                runId: execution.runId,
                action: execution.action,
                mode: execution.mode,
                status: execution.status,
                createdAt: execution.createdAt
              })),
              runnerSessions: pipeline.runnerSessions.map((session) => ({
                sessionId: session.sessionId,
                runId: session.runId,
                mode: session.mode,
                status: session.status,
                startedAt: session.startedAt,
                finishedAt: session.finishedAt
              })),
              workerJobs: pipeline.workerJobs.map((job) => ({
                jobId: job.jobId,
                sessionId: job.sessionId,
                worker: job.worker,
                status: job.status,
                currentReportId: job.currentReportId
              })),
              workerReports: pipeline.workerReports.map((report) => ({
                reportId: report.reportId,
                jobId: report.jobId,
                status: report.status,
                rollbackPlanId: report.rollbackPlan?.rollbackPlanId || null
              })),
              rollbackExecutions: pipeline.rollbackExecutions.map((execution) => ({
                rollbackExecutionId: execution.rollbackExecutionId,
                sourceReportId: execution.sourceReportId,
                status: execution.status,
                currentRollbackReportId: execution.currentRollbackReportId
              })),
              rollbackReports: pipeline.rollbackReports.map((report) => ({
                rollbackReportId: report.rollbackReportId,
                rollbackExecutionId: report.rollbackExecutionId,
                status: report.status
              })),
              timeline: pipeline.timeline
            }, null, 2));
            return;
          }
          console.log(JSON.stringify({
            pipelines: payload.pipelines.map((pipeline) => ({
              summary: pipeline.summary,
              lastTimelineEntry: pipeline.timeline[pipeline.timeline.length - 1] || null
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops admin dashboard | actions [token] | site-slot-pipelines [plan-id]"
      ;;
  esac
}

cleanup_v1_wireguard() {
  local mode="dry-run"
  if [ "${1:-}" = "--apply" ] || [ "${1:-}" = "apply" ]; then
    mode="apply"
    shift || true
  fi

  local interfaces=("$@")
  if [ "${#interfaces[@]}" -eq 0 ]; then
    # V1 defaults: old HDO home endpoint and old Internal direct-listener peer.
    # Override with MX_LEGACY_WG_INTERFACES="hdo-home hdo-internal custom-iface".
    # shellcheck disable=SC2206
    interfaces=(${MX_LEGACY_WG_INTERFACES:-hdo-home hdo-internal})
  fi

  if [ "$mode" = "apply" ] && [ "$(id -u)" -ne 0 ]; then
    say "Re-running with sudo to clean V1 WireGuard services: ${interfaces[*]}"
    exec sudo -E bash "$0" ops site-slot cleanup-v1-wireguard --apply "${interfaces[@]}"
  fi

  say "V1 WireGuard cleanup mode: $mode"
  say "interfaces: ${interfaces[*]}"
  if [ "$mode" != "apply" ]; then
    say "dry-run only. Add --apply to stop wg-quick@<iface>, bring the iface down, and move /etc/wireguard/<iface>.conf to /opt/mx/legacy-wireguard/."
  fi

  local iface service config backup_dir backup_path timestamp
  timestamp="$(date +%Y%m%d%H%M%S)"
  backup_dir="/opt/mx/legacy-wireguard"
  for iface in "${interfaces[@]}"; do
    [ -n "$iface" ] || continue
    service="wg-quick@$iface"
    config="/etc/wireguard/$iface.conf"
    backup_path="$backup_dir/$iface.conf.$timestamp"
    say "checking $iface"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl is-active --quiet "$service" 2>/dev/null && say "$service active" || true
      systemctl is-enabled --quiet "$service" 2>/dev/null && say "$service enabled" || true
    fi
    ip link show "$iface" >/dev/null 2>&1 && say "interface $iface exists" || true
    [ -f "$config" ] && say "config exists: $config" || true

    if [ "$mode" = "apply" ]; then
      if command -v systemctl >/dev/null 2>&1; then
        systemctl disable --now "$service" >/dev/null 2>&1 || true
      fi
      if command -v wg-quick >/dev/null 2>&1; then
        wg-quick down "$iface" >/dev/null 2>&1 || true
      fi
      ip link delete "$iface" >/dev/null 2>&1 || true
      if [ -f "$config" ]; then
        install -d -m 0755 "$backup_dir"
        mv -f "$config" "$backup_path"
        say "moved $config -> $backup_path"
      fi
    fi
  done

  if command -v wg >/dev/null 2>&1 && wg show 2>/dev/null | grep -q '100\.'; then
    say "legacy 100.* WireGuard peers are still present:"
    wg show 2>/dev/null || true
  fi
}

internal_service_peer_handoff() {
  local mode="${1:-status}"
  if [ "$#" -gt 0 ]; then shift || true; fi

  local artifact_root="${MX_INTERNAL_SERVICE_ARTIFACT_DIR:-$ROOT/artifacts/site-slots/domestic}"
  if [ ! -f "$artifact_root/mx-internal-service-peer.conf" ] && [ -f "$ROOT/server/artifacts/site-slots/domestic/mx-internal-service-peer.conf" ]; then
    artifact_root="$ROOT/server/artifacts/site-slots/domestic"
  fi
  local apply_script="${MX_INTERNAL_SERVICE_APPLY_SCRIPT:-$artifact_root/mx-internal-service-peer-apply.sh}"
  local config_path="${1:-${MX_INTERNAL_SERVICE_CONFIG:-$artifact_root/mx-internal-service-peer.conf}}"
  local iface="${MX_INTERNAL_SERVICE_WG_INTERFACE:-mx-internal-svc}"
  local command_text="sudo env MX_INTERNAL_SERVICE_WG_INTERFACE=$iface bash '$apply_script' '$config_path'"

  case "$mode" in
    status|command|apply) ;;
    *)
      die "Usage: bash scripts/manage.sh ops site-slot internal-service-peer-handoff [status|command|apply] [config-path]"
      ;;
  esac

  say "Internal service peer handoff mode: $mode"
  say "interface: $iface"
  say "config: $config_path"
  say "apply script: $apply_script"

  [ -f "$config_path" ] && say "config exists" || say "config missing"
  [ -f "$apply_script" ] && say "apply script exists" || say "apply script missing"
  command -v wg >/dev/null 2>&1 && say "wg: $(command -v wg)" || say "wg: missing on this host"
  command -v wg-quick >/dev/null 2>&1 && say "wg-quick: $(command -v wg-quick)" || say "wg-quick: missing on this host"
  if command -v qp-tunnel-cli >/dev/null 2>&1; then
    say "qp-tunnel-cli: $(command -v qp-tunnel-cli)"
    say "note: V2 Internal WG runtime resolves wg/wireguard-go through qp-tunnel-cli's @qpjoy/electron-core-wireguard package."
  fi

  if [ "$mode" = "command" ]; then
    printf '%s\n' "$command_text"
    return
  fi

  if [ "$mode" != "apply" ]; then
    say "dry-run only. Run 'bash scripts/manage.sh ops site-slot internal-service-peer-handoff command' to print the apply command."
    say "run apply only on the Internal runtime host that should own 10.88.88.88."
    return
  fi

  [ -f "$config_path" ] || die "Internal service peer config not found: $config_path"
  [ -f "$apply_script" ] || die "Internal service peer apply script not found: $apply_script"
  command -v wg-quick >/dev/null 2>&1 || die "wg-quick is required to apply V2 Internal service peer config on this host"
  local private_key
  private_key="$(awk '/^[[:space:]]*PrivateKey[[:space:]]*=/{sub(/^[^=]*=/, ""); print; exit}' "$config_path" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if printf "%s" "$private_key" | grep -q '[<>]'; then
    die "Internal service peer config still contains placeholder key: $config_path. Run 'bash scripts/manage.sh ops site-slot materialize-domestic-ready <site-id>' or Generate Handoff from Internal first."
  fi
  if ! printf "%s" "$private_key" | grep -Eq '^[A-Za-z0-9+/]{43}=$'; then
    die "Internal service peer private key is missing or invalid: $config_path. Run 'bash scripts/manage.sh ops site-slot materialize-domestic-ready <site-id>' or Generate Handoff from Internal first."
  fi

  if [ "$(id -u)" -ne 0 ]; then
    say "Re-running with sudo to apply $iface on this Internal runtime host"
    exec sudo -E env MX_INTERNAL_SERVICE_WG_INTERFACE="$iface" bash "$apply_script" "$config_path"
  fi

  env MX_INTERNAL_SERVICE_WG_INTERFACE="$iface" bash "$apply_script" "$config_path"
}

native_host_runner_label() {
  echo "com.qpjoy.mx-launcher.internal-host-runner"
}

native_host_runner_service_name() {
  echo "mx-internal-host-runner"
}

native_host_runner_node_bin() {
  command -v node || die "node is required for the Internal native host runner"
}

native_host_runner_state_dir() {
  echo "${MX_NATIVE_HOST_RUNNER_STATE_DIR:-$HOME/.qpjoy/mx-launcher/internal-host-runner}"
}

native_host_runner_artifact_dir() {
  echo "${MX_INTERNAL_SERVICE_ARTIFACT_DIR:-$(native_host_runner_state_dir)/artifacts/site-slots/domestic}"
}

native_host_runner_bundle_dir() {
  echo "${MX_QP_TUNNEL_CLI_BUNDLE_DIR:-$(native_host_runner_state_dir)/qp-tunnel-cli-runtime}"
}

native_host_runner_prepare_runtime() {
  local artifact_dir bundle_dir archive_name source_archive target_archive archive_bytes marker_path
  artifact_dir="$(native_host_runner_artifact_dir)"
  bundle_dir="$(native_host_runner_bundle_dir)"
  archive_name="mx-domestic-qp-tunnel-cli-fallback.tar.gz"
  mkdir -p "$artifact_dir" "$bundle_dir"
  target_archive="$artifact_dir/$archive_name"
  for source_archive in \
    "$ROOT/artifacts/site-slots/domestic/$archive_name" \
    "$ROOT/server/artifacts/site-slots/domestic/$archive_name"; do
    if [ -f "$source_archive" ]; then
      if [ ! -f "$target_archive" ] || ! cmp -s "$source_archive" "$target_archive"; then
        rm -rf "$bundle_dir"
        mkdir -p "$bundle_dir"
      fi
      cp "$source_archive" "$target_archive"
      chmod 600 "$target_archive" >/dev/null 2>&1 || true
      marker_path="$bundle_dir/.fallback-archive"
      if [ -f "$marker_path" ]; then
        archive_bytes="$(wc -c < "$target_archive" | tr -d ' ')"
        if ! grep -Fx "$archive_bytes" "$marker_path" >/dev/null 2>&1; then
          rm -rf "$bundle_dir"
          mkdir -p "$bundle_dir"
        fi
      fi
      break
    fi
  done
}

native_host_runner_health() {
  local port="${1:-19190}"
  local url="http://127.0.0.1:$port/healthz"
  if command -v curl >/dev/null 2>&1 && curl -fsS "$url" >/dev/null 2>&1; then
    say "health: reachable at $url"
    return 0
  fi
  say "health: not reachable at $url"
  return 1
}

native_host_runner_start_foreground() {
  local port="${1:-19190}"
  local artifact_dir bundle_dir
  native_host_runner_prepare_runtime
  artifact_dir="$(native_host_runner_artifact_dir)"
  bundle_dir="$(native_host_runner_bundle_dir)"
  say "Starting native Internal host runner in the foreground on 0.0.0.0:$port"
  say "This process must run on the real Internal host, not inside the k8s pod or Docker Desktop VM."
  MX_INTERNAL_HOST_RUNNER_HOST="${MX_INTERNAL_HOST_RUNNER_HOST:-0.0.0.0}" \
    MX_INTERNAL_HOST_RUNNER_PORT="$port" \
    MX_INTERNAL_SERVICE_ARTIFACT_DIR="$artifact_dir" \
    MX_QP_TUNNEL_CLI_BUNDLE_DIR="$bundle_dir" \
    "$(native_host_runner_node_bin)" server/scripts/internal-service-peer-host-runner.mjs "$port"
}

native_host_runner_status() {
  local port="${1:-19190}"
  local os_name
  os_name="$(uname -s)"
  say "Native Internal host runner status"
  say "project: $ROOT"
  say "port: $port"
  native_host_runner_health "$port" || true

  case "$os_name" in
    Darwin)
      local label
      label="$(native_host_runner_label)"
      if command -v launchctl >/dev/null 2>&1; then
        launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 \
          && say "launchd: $label loaded" \
          || say "launchd: $label not loaded"
      fi
      ;;
    Linux)
      local service
      service="$(native_host_runner_service_name).service"
      if command -v systemctl >/dev/null 2>&1; then
        systemctl is-active --quiet "$service" 2>/dev/null \
          && say "systemd: $service active" \
          || say "systemd: $service not active"
        systemctl is-enabled --quiet "$service" 2>/dev/null \
          && say "systemd: $service enabled" \
          || true
      fi
      ;;
    *)
      say "service manager: unsupported OS $os_name; use start for foreground mode"
      ;;
  esac
}

native_host_runner_install_macos() {
  local port="${1:-19190}"
  local label plist log_dir node_bin node_dir artifact_dir bundle_dir
  label="$(native_host_runner_label)"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  log_dir="$HOME/Library/Logs/mx-launcher"
  node_bin="$(native_host_runner_node_bin)"
  node_dir="$(dirname "$node_bin")"
  native_host_runner_prepare_runtime
  artifact_dir="$(native_host_runner_artifact_dir)"
  bundle_dir="$(native_host_runner_bundle_dir)"
  mkdir -p "$(dirname "$plist")" "$log_dir"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>server/scripts/internal-service-peer-host-runner.mjs</string>
    <string>$port</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MX_INTERNAL_HOST_RUNNER_HOST</key>
    <string>0.0.0.0</string>
    <key>MX_INTERNAL_HOST_RUNNER_PORT</key>
    <string>$port</string>
    <key>MX_INTERNAL_SERVICE_ARTIFACT_DIR</key>
    <string>$artifact_dir</string>
    <key>MX_QP_TUNNEL_CLI_BUNDLE_DIR</key>
    <string>$bundle_dir</string>
    <key>PATH</key>
    <string>$node_dir:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_dir/internal-host-runner.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/internal-host-runner.err.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl kickstart -k "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  say "installed launchd agent: $plist"
  native_host_runner_status "$port"
}

native_host_runner_install_linux() {
  local port="${1:-19190}"
  local service node_bin node_dir temp artifact_dir bundle_dir root_cmd
  service="$(native_host_runner_service_name).service"
  node_bin="$(native_host_runner_node_bin)"
  node_dir="$(dirname "$node_bin")"
  root_cmd="sudo"
  if [ "$(id -u)" = "0" ]; then
    root_cmd=""
  else
    command -v sudo >/dev/null 2>&1 || die "sudo is required to install the native host runner when not running as root"
  fi
  native_host_runner_prepare_runtime
  artifact_dir="$(native_host_runner_artifact_dir)"
  bundle_dir="$(native_host_runner_bundle_dir)"
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required to install the native host runner on Linux"
  temp="$(mktemp)"
  cat >"$temp" <<EOF
[Unit]
Description=MX Internal native host runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=MX_INTERNAL_HOST_RUNNER_HOST=0.0.0.0
Environment=MX_INTERNAL_HOST_RUNNER_PORT=$port
Environment=MX_INTERNAL_SERVICE_ARTIFACT_DIR=$artifact_dir
Environment=MX_QP_TUNNEL_CLI_BUNDLE_DIR=$bundle_dir
Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
ExecStart=$node_bin server/scripts/internal-service-peer-host-runner.mjs $port
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  $root_cmd install -m 0644 "$temp" "/etc/systemd/system/$service"
  rm -f "$temp"
  $root_cmd systemctl daemon-reload
  $root_cmd systemctl enable "$service"
  $root_cmd systemctl restart "$service"
  say "installed systemd service: /etc/systemd/system/$service"
  native_host_runner_status "$port"
}

native_host_runner_install() {
  local port="${1:-19190}"
  case "$(uname -s)" in
    Darwin)
      native_host_runner_install_macos "$port"
      ;;
    Linux)
      native_host_runner_install_linux "$port"
      ;;
    *)
      die "Unsupported OS for native host runner install. Use start for foreground mode."
      ;;
  esac
}

native_host_runner_uninstall() {
  local port="${1:-19190}"
  case "$(uname -s)" in
    Darwin)
      local label plist
      label="$(native_host_runner_label)"
      plist="$HOME/Library/LaunchAgents/$label.plist"
      launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
      rm -f "$plist"
      say "removed launchd agent: $plist"
      ;;
    Linux)
      local service
      service="$(native_host_runner_service_name).service"
      sudo systemctl disable --now "$service" >/dev/null 2>&1 || true
      sudo rm -f "/etc/systemd/system/$service"
      sudo systemctl daemon-reload
      say "removed systemd service: /etc/systemd/system/$service"
      ;;
    *)
      die "Unsupported OS for native host runner uninstall"
      ;;
  esac
  native_host_runner_status "$port"
}

native_host_runner() {
  local action="${1:-status}"
  if [ "$#" -gt 0 ]; then shift || true; fi
  local port="${1:-19190}"
  case "$action" in
    status)
      native_host_runner_status "$port"
      ;;
    start|run)
      native_host_runner_start_foreground "$port"
      ;;
    install)
      native_host_runner_install "$port"
      ;;
    uninstall|remove)
      native_host_runner_uninstall "$port"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops site-slot native-host-runner status|start|install|uninstall [port]"
      ;;
  esac
}

ops_site_slot() {
  local action="$1"
  shift || true
  local base="${MX_INTERNAL_BASE_URL:-http://127.0.0.1:18090}"
  case "$action" in
    materialize)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops site-slot materialize [oversea|domestic|all]"
      node server/scripts/site-slot-artifact-materializer.mjs "${1:-all}"
      ;;
    domestic-wg-secret-upsert)
      [ "$#" -ge 2 ] || die "Usage: MX_DOMESTIC_RELAY_PRIVATE_KEY=... MX_DOMESTIC_RELAY_PUBLIC_KEY=... MX_INTERNAL_SERVICE_PRIVATE_KEY=... MX_INTERNAL_SERVICE_PUBLIC_KEY=... bash scripts/manage.sh ops site-slot domestic-wg-secret-upsert <site-id> <endpoint>"
      node -e '
        const [base, siteId, endpoint] = process.argv.slice(1);
        const body = {
          siteId,
          publicEndpoint: endpoint,
          listenPort: Number(process.env.MX_WG_LISTEN_PORT || "51280"),
          domesticGatewayIp: process.env.MX_DOMESTIC_GATEWAY_IP || "10.88.0.1",
          domesticGatewayCidr: process.env.MX_DOMESTIC_GATEWAY_CIDR || "10.88.0.0/16",
          productRelayCidrs: (process.env.MX_PRODUCT_RELAY_CIDRS || "10.89.0.0/16,10.90.0.0/16").split(",").map((item) => item.trim()).filter(Boolean),
          userRelayCidr: process.env.MX_USER_RELAY_CIDR || "10.89.0.0/16",
          internalServiceIp: process.env.MX_INTERNAL_SERVICE_IP || "10.88.88.88",
          internalServiceCidr: process.env.MX_INTERNAL_SERVICE_CIDR || "10.90.0.0/16",
          guestRelayCidr: process.env.MX_GUEST_RELAY_CIDR || "10.90.0.0/16",
          domesticRelayPrivateKey: process.env.MX_DOMESTIC_RELAY_PRIVATE_KEY || null,
          domesticRelayPublicKey: process.env.MX_DOMESTIC_RELAY_PUBLIC_KEY || null,
          internalServicePrivateKey: process.env.MX_INTERNAL_SERVICE_PRIVATE_KEY || null,
          internalServicePublicKey: process.env.MX_INTERNAL_SERVICE_PUBLIC_KEY || null,
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-domestic-wg-secret-upsert"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/domestic-wg-secrets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify(payload, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "$2"
      ;;
    domestic-wg-materialize)
      [ "$#" -ge 2 ] || die "Usage: bash scripts/manage.sh ops site-slot domestic-wg-materialize <site-id> <endpoint> [rotate]"
      node -e '
        const [base, siteId, endpoint, rotateFlag = ""] = process.argv.slice(1);
        const rotate = rotateFlag === "rotate" || rotateFlag === "true" || rotateFlag === "1";
        const body = {
          siteId,
          planId: process.env.SITE_SLOT_PLAN_ID || null,
          publicEndpoint: endpoint,
          listenPort: Number(process.env.MX_WG_LISTEN_PORT || "51280"),
          domesticGatewayIp: process.env.MX_DOMESTIC_GATEWAY_IP || "10.88.0.1",
          domesticGatewayCidr: process.env.MX_DOMESTIC_GATEWAY_CIDR || "10.88.0.0/16",
          productRelayCidrs: (process.env.MX_PRODUCT_RELAY_CIDRS || "10.89.0.0/16,10.90.0.0/16").split(",").map((item) => item.trim()).filter(Boolean),
          userRelayCidr: process.env.MX_USER_RELAY_CIDR || "10.89.0.0/16",
          internalServiceIp: process.env.MX_INTERNAL_SERVICE_IP || "10.88.88.88",
          internalServiceCidr: process.env.MX_INTERNAL_SERVICE_CIDR || "10.90.0.0/16",
          guestRelayCidr: process.env.MX_GUEST_RELAY_CIDR || "10.90.0.0/16",
          rotateRelayKey: rotate,
          rotateInternalServiceKey: rotate,
          confirmRotate: rotate,
          requestedBy: process.env.USER || "manage.sh",
          requestId: rotate ? "manage-domestic-wg-materialize-rotate" : "manage-domestic-wg-materialize"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/admin/actions/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              actionId: "site-slot.domestic-wg.materialize",
              path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(siteId)}/materialize-ready`,
              body
            })
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify(payload, null, 2));
          if (payload.domesticWgMaterialize?.status === "blocked") process.exit(2);
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "$2" "${3:-}"
      ;;
    materialize-domestic-ready)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot materialize-domestic-ready <site-id>"
      node -e '
        const { spawnSync } = require("node:child_process");
        const [base, siteId] = process.argv.slice(1);
        (async () => {
          const generateRes = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(siteId)}/generate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              requestedBy: process.env.USER || "manage.sh",
              requestId: "manage-materialize-domestic-ready-repair"
            })
          });
          const generatePayload = await generateRes.json();
          if (!generateRes.ok) throw new Error(JSON.stringify(generatePayload));
          if (generatePayload.generation?.status !== "ready") throw new Error(JSON.stringify(generatePayload, null, 2));
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(siteId)}/materializer-env`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              confirmSecretExport: true,
              requestedBy: process.env.USER || "manage.sh",
              requestId: "manage-materialize-domestic-ready"
            })
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          if (payload.export?.status !== "ready") throw new Error(JSON.stringify(payload, null, 2));
          const child = spawnSync(process.execPath, ["server/scripts/site-slot-artifact-materializer.mjs", "domestic"], {
            stdio: "inherit",
            env: { ...process.env, ...payload.export.env }
          });
          process.exit(child.status ?? 1);
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1"
      ;;
    internal-service-peer-handoff)
      internal_service_peer_handoff "$@"
      ;;
    internal-service-peer-host-runner|internal-host-runner)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops site-slot internal-service-peer-host-runner [port]"
      MX_INTERNAL_HOST_RUNNER_HOST="${MX_INTERNAL_HOST_RUNNER_HOST:-0.0.0.0}" node server/scripts/internal-service-peer-host-runner.mjs "${1:-19190}"
      ;;
    native-host-runner|internal-native-host-runner)
      native_host_runner "$@"
      ;;
    cleanup-v1-wireguard)
      cleanup_v1_wireguard "$@"
      ;;
    refresh-tunnel-cli)
      node server/scripts/site-slot-refresh-tunnel-cli.mjs "$@"
      ;;
    ssh-profiles)
      node -e '
        const [base] = process.argv.slice(1);
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/site-slot-ssh-profiles`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            profiles: payload.profiles.map((profile) => ({
              profileId: profile.profileId,
              siteId: profile.siteId,
              kind: profile.kind,
              host: profile.host,
              sshUser: profile.sshUser,
              sshPort: profile.sshPort,
              identityFile: profile.identityFile,
              knownHostsFile: profile.knownHostsFile,
              hostKeyAlias: profile.hostKeyAlias,
              strictHostKeyChecking: profile.strictHostKeyChecking,
              connectTimeoutSeconds: profile.connectTimeoutSeconds,
              batchMode: profile.batchMode,
              status: profile.status,
              warnings: profile.warnings,
              updatedAt: profile.updatedAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base"
      ;;
    ssh-profile-upsert)
      [ "$#" -ge 2 ] || die "Usage: bash scripts/manage.sh ops site-slot ssh-profile-upsert <site-id> <domestic|oversea> [host]"
      node -e '
        const [base, siteId, kind, host = ""] = process.argv.slice(1);
        const body = {
          profileId: process.env.SITE_SLOT_SSH_PROFILE_ID || `sshprof_${siteId.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
          siteId,
          kind,
          host: host || process.env.SITE_SLOT_HOST || null,
          sshUser: process.env.SLOT_SSH_USER || "root",
          sshPort: Number(process.env.SLOT_SSH_PORT || "22"),
          identityFile: process.env.SITE_SLOT_SSH_IDENTITY_FILE || null,
          knownHostsFile: process.env.SITE_SLOT_SSH_KNOWN_HOSTS_FILE || null,
          hostKeyAlias: process.env.SITE_SLOT_SSH_HOST_KEY_ALIAS || siteId,
          strictHostKeyChecking: process.env.SITE_SLOT_SSH_STRICT_HOST_KEY_CHECKING || "yes",
          connectTimeoutSeconds: Number(process.env.SITE_SLOT_SSH_CONNECT_TIMEOUT_SECONDS || "10"),
          batchMode: process.env.SITE_SLOT_SSH_BATCH_MODE || "yes",
          status: process.env.SITE_SLOT_SSH_PROFILE_STATUS || "active",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-ssh-profile-upsert"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/site-slot-ssh-profiles`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const profile = payload.profile;
          console.log(JSON.stringify({
            profileId: profile.profileId,
            siteId: profile.siteId,
            kind: profile.kind,
            host: profile.host,
            sshUser: profile.sshUser,
            sshPort: profile.sshPort,
            identityFile: profile.identityFile,
            knownHostsFile: profile.knownHostsFile,
            hostKeyAlias: profile.hostKeyAlias,
            strictHostKeyChecking: profile.strictHostKeyChecking,
            connectTimeoutSeconds: profile.connectTimeoutSeconds,
            batchMode: profile.batchMode,
            status: profile.status,
            warnings: profile.warnings,
            updatedAt: profile.updatedAt
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "$2" "${3:-}"
      ;;
    ssh-profile-readiness)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot ssh-profile-readiness <profile-id> [plan-only|execute]"
      node -e '
        const [base, profileId, mode = "plan-only"] = process.argv.slice(1);
        const body = {
          confirmReadOnlyProbe: true,
          executeReadOnlyProbe: mode === "execute",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-ssh-profile-readiness"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(profileId)}/readiness-probe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const readiness = payload.readiness;
          console.log(JSON.stringify({
            probeId: readiness.probeId,
            profileId: readiness.profileId,
            siteId: readiness.siteId,
            kind: readiness.kind,
            status: readiness.status,
            verdict: readiness.verdict,
            mode: readiness.mode,
            execution: readiness.execution,
            boundary: readiness.boundary,
            sshProfile: readiness.sshProfile,
            command: readiness.command,
            env: readiness.env,
            gates: readiness.gates,
            gateFailures: readiness.gateFailures,
            executionFailures: readiness.executionFailures,
            executionResult: readiness.executionResult,
            nextActions: readiness.nextActions
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-plan-only}"
      ;;
    oversea-readonly-test)
      [ "$#" -ge 2 ] || die "Usage: SITE_SLOT_SSH_IDENTITY_FILE=/path/key SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/known_hosts bash scripts/manage.sh ops site-slot oversea-readonly-test <site-id> <host>"
      node server/scripts/site-slot-oversea-readonly-test.mjs "$base" "$1" "$2"
      ;;
    oversea-remote-test)
      [ "$#" -ge 2 ] || die "Usage: SITE_SLOT_SSH_IDENTITY_FILE=/path/key SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/known_hosts bash scripts/manage.sh ops site-slot oversea-remote-test <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute]"
      node server/scripts/site-slot-oversea-remote-test.mjs "$base" "$1" "$2" "${3:-pipeline}"
      ;;
    domestic-plan)
      [ "$#" -ge 1 ] || [ -n "${SITE_SLOT_SSH_PROFILE_ID:-}" ] || die "Usage: bash scripts/manage.sh ops site-slot domestic-plan <domestic-host|-> [oversea-host]"
      local domestic_host="${1:-}"
      local oversea_host="${2:-}"
      [ "$domestic_host" = "-" ] && domestic_host=""
      node -e '
        const [base, host = "", overseaHost = ""] = process.argv.slice(1);
        const body = {
          kind: "domestic",
          siteId: process.env.SLOT_SITE_ID || "domestic-main",
          sshProfileId: process.env.SITE_SLOT_SSH_PROFILE_ID || null,
          host: host || null,
          sshUser: process.env.SLOT_SSH_USER || "root",
          sshPort: Number(process.env.SLOT_SSH_PORT || "22"),
          rootAccess: process.env.SLOT_ROOT_ACCESS !== "0",
          hasDocker: process.env.SLOT_HAS_DOCKER !== "0",
          hasOutboundInternet: process.env.DOMESTIC_HAS_OUTBOUND === "1",
          overseaSiteId: process.env.OVERSEA_SITE_ID || (overseaHost ? "oversea-main" : null),
          overseaHost: overseaHost || null,
          internalBaseUrl: base.replace(/\/+$/, ""),
          createdBy: process.env.USER || "manage.sh",
          requestId: "manage-domestic-slot-plan"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/plans`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const plan = payload.plan;
          console.log(JSON.stringify({
            planId: plan.planId,
            siteId: plan.siteId,
            kind: plan.kind,
            status: plan.status,
            ssh: plan.ssh,
            networkMode: plan.network.mode,
            qpTunnelCliMode: plan.network.qpTunnelCliMode,
            hostServices: plan.services.hostServices,
            dockerStacks: plan.services.dockerStacks,
            warnings: plan.warnings,
            nextActions: plan.nextActions,
            preflightChecks: plan.preflightChecks.map((row) => ({ checkId: row.checkId, severity: row.severity, command: row.command })),
            deploymentPhases: plan.deploymentPhases.map((row) => ({ phaseId: row.phaseId, mode: row.mode, target: row.target }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$domestic_host" "$oversea_host"
      ;;
    oversea-plan)
      [ "$#" -ge 1 ] || [ -n "${SITE_SLOT_SSH_PROFILE_ID:-}" ] || die "Usage: bash scripts/manage.sh ops site-slot oversea-plan <oversea-host|->"
      local oversea_host="${1:-}"
      [ "$oversea_host" = "-" ] && oversea_host=""
      node -e '
        const [base, host = ""] = process.argv.slice(1);
        const body = {
          kind: "oversea",
          siteId: process.env.SLOT_SITE_ID || process.env.OVERSEA_SITE_ID || "oversea-main",
          sshProfileId: process.env.SITE_SLOT_SSH_PROFILE_ID || null,
          host: host || null,
          sshUser: process.env.SLOT_SSH_USER || "root",
          sshPort: Number(process.env.SLOT_SSH_PORT || "22"),
          rootAccess: process.env.SLOT_ROOT_ACCESS !== "0",
          hasDocker: process.env.SLOT_HAS_DOCKER !== "0",
          hasOutboundInternet: true,
          internalBaseUrl: base.replace(/\/+$/, ""),
          createdBy: process.env.USER || "manage.sh",
          requestId: "manage-oversea-slot-plan"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/plans`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const plan = payload.plan;
          console.log(JSON.stringify({
            planId: plan.planId,
            siteId: plan.siteId,
            kind: plan.kind,
            status: plan.status,
            ssh: plan.ssh,
            qpTunnelCliMode: plan.network.qpTunnelCliMode,
            dockerStacks: plan.services.dockerStacks,
            warnings: plan.warnings,
            nextActions: plan.nextActions,
            preflightChecks: plan.preflightChecks.map((row) => ({ checkId: row.checkId, severity: row.severity, command: row.command })),
            deploymentPhases: plan.deploymentPhases.map((row) => ({ phaseId: row.phaseId, mode: row.mode, target: row.target }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$oversea_host"
      ;;
    preflight)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot preflight <plan-id> [dry-run|manual|ssh]"
      node -e '
        const [base, planId, mode = "dry-run"] = process.argv.slice(1);
        const body = {
          mode,
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-preflight"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/plans/${encodeURIComponent(planId)}/preflight`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const run = payload.execution;
          console.log(JSON.stringify({
            runId: run.runId,
            planId: run.planId,
            siteId: run.siteId,
            kind: run.kind,
            action: run.action,
            mode: run.mode,
            status: run.status,
            dryRun: run.dryRun,
            remoteExecution: run.remoteExecution,
            warnings: run.warnings,
            nextActions: run.nextActions,
            steps: run.steps.map((step) => ({
              order: step.order,
              sourceId: step.sourceId,
              target: step.target,
              requiresRoot: step.requiresRoot,
              command: step.command,
              expected: step.expected
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-dry-run}"
      ;;
    apply)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot apply <plan-id> [manual|dry-run|ssh]"
      node -e '
        const [base, planId, mode = "manual"] = process.argv.slice(1);
        const body = {
          mode,
          confirmApply: process.env.SITE_SLOT_CONFIRM_APPLY === "1",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-apply"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/plans/${encodeURIComponent(planId)}/apply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const run = payload.execution;
          console.log(JSON.stringify({
            runId: run.runId,
            planId: run.planId,
            siteId: run.siteId,
            kind: run.kind,
            action: run.action,
            mode: run.mode,
            status: run.status,
            dryRun: run.dryRun,
            confirmApply: run.confirmApply,
            remoteExecution: run.remoteExecution,
            gates: run.gates,
            warnings: run.warnings,
            nextActions: run.nextActions,
            steps: run.steps.map((step) => ({
              order: step.order,
              sourceId: step.sourceId,
              target: step.target,
              requiresRoot: step.requiresRoot,
              command: step.command,
              expected: step.expected
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-manual}"
      ;;
    executions)
      node -e '
        const [base, planId = ""] = process.argv.slice(1);
        const query = planId ? `?planId=${encodeURIComponent(planId)}` : "";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/executions${query}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            executions: payload.executions.map((run) => ({
              runId: run.runId,
              planId: run.planId,
              siteId: run.siteId,
              kind: run.kind,
              action: run.action,
              mode: run.mode,
              status: run.status,
              stepCount: run.steps.length,
              createdAt: run.createdAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    runner-start)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot runner-start <run-id> [simulate|remote-ssh|awx-shadow]"
      node -e '
        const [base, runId, mode = "simulate"] = process.argv.slice(1);
        const body = {
          mode,
          confirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === "1",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-runner-start"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/executions/${encodeURIComponent(runId)}/runner-sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const session = payload.session;
          console.log(JSON.stringify({
            sessionId: session.sessionId,
            runId: session.runId,
            planId: session.planId,
            siteId: session.siteId,
            kind: session.kind,
            mode: session.mode,
            status: session.status,
            dryRun: session.dryRun,
            confirmRemoteExecution: session.confirmRemoteExecution,
            gates: session.gates,
            warnings: session.warnings,
            nextActions: session.nextActions,
            stepResults: session.stepResults.map((step) => ({
              order: step.order,
              sourceId: step.sourceId,
              target: step.target,
              status: step.status,
              exitCode: step.exitCode,
              command: step.command,
              output: step.output,
              error: step.error
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-simulate}"
      ;;
    runner-sessions)
      node -e '
        const [base, runId = ""] = process.argv.slice(1);
        const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/runner-sessions${query}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            sessions: payload.sessions.map((session) => ({
              sessionId: session.sessionId,
              runId: session.runId,
              planId: session.planId,
              siteId: session.siteId,
              kind: session.kind,
              mode: session.mode,
              status: session.status,
              stepCount: session.stepResults.length,
              startedAt: session.startedAt,
              finishedAt: session.finishedAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    worker-job)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-job <session-id>"
      node -e '
        const [base, sessionId] = process.argv.slice(1);
        const body = {
          workerId: process.env.SITE_SLOT_WORKER_ID || "worker-manage-shadow",
          workerKind: process.env.SITE_SLOT_WORKER_KIND || "internal-runner",
          approvalId: process.env.SITE_SLOT_APPROVAL_ID || null,
          changeWindowStart: process.env.SITE_SLOT_CHANGE_WINDOW_START || null,
          changeWindowEnd: process.env.SITE_SLOT_CHANGE_WINDOW_END || null,
          retryLimit: Number(process.env.SITE_SLOT_RETRY_LIMIT || "1"),
          rollbackStrategy: process.env.SITE_SLOT_ROLLBACK_STRATEGY || "no-op-simulated-rollback",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-worker-job"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/runner-sessions/${encodeURIComponent(sessionId)}/worker-jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const job = payload.job;
          console.log(JSON.stringify({
            jobId: job.jobId,
            contractVersion: job.contractVersion,
            sessionId: job.sessionId,
            runId: job.runId,
            planId: job.planId,
            siteId: job.siteId,
            kind: job.kind,
            mode: job.mode,
            status: job.status,
            dryRun: job.dryRun,
            worker: job.worker,
            approval: job.approval,
            changeWindow: job.changeWindow,
            retryPolicy: job.retryPolicy,
            rollbackPolicy: job.rollbackPolicy,
            warnings: job.warnings,
            nextActions: job.nextActions,
            steps: job.steps.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              sourceId: step.sourceId,
              target: step.target,
              requiresRoot: step.requiresRoot,
              timeoutSeconds: step.timeoutSeconds,
              stopOnFailure: step.stopOnFailure,
              redactOutput: step.redactOutput,
              command: step.command
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1"
      ;;
    worker-gate)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-gate <job-id> [confirm]"
      node -e '
        const [base, jobId, confirm = ""] = process.argv.slice(1);
        const body = {
          confirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === "1" || confirm === "confirm" || confirm === "true",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-worker-gate"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}/remote-ssh-gate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const gate = payload.gate;
          console.log(JSON.stringify({
            gateId: gate.gateId,
            jobId: gate.jobId,
            planId: gate.planId,
            siteId: gate.siteId,
            kind: gate.kind,
            status: gate.status,
            verdict: gate.verdict,
            execution: gate.execution,
            boundary: gate.boundary,
            confirmRemoteExecution: gate.confirmRemoteExecution,
            environmentGates: gate.environmentGates,
            sshProfile: gate.sshProfile,
            summary: gate.summary,
            jobGateFailures: gate.jobGateFailures,
            gateFailures: gate.gateFailures,
            nextActions: gate.nextActions,
            stepGates: gate.stepGates.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              sourceId: step.sourceId,
              target: step.target,
              commandKind: step.commandKind,
              execution: step.execution,
              status: step.status,
              transport: step.transport,
              artifactReferences: step.artifactReferences,
              gateFailures: step.gateFailures
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-}"
      ;;
    worker-handoff)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-handoff <job-id> [confirm]"
      node -e '
        const [base, jobId, confirm = ""] = process.argv.slice(1);
        const confirmed = confirm === "confirm" || confirm === "true";
        const body = {
          confirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === "1" || confirmed,
          confirmWorkerHandoff: process.env.SITE_SLOT_CONFIRM_WORKER_HANDOFF === "1" || confirmed,
          internalBaseUrl: process.env.MX_INTERNAL_BASE_URL || base.replace(/\/+$/, ""),
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-worker-handoff"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}/run-artifact-push-remote-ssh`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const gate = payload.gate;
          const handoff = payload.workerHandoff;
          console.log(JSON.stringify({
            gate: {
              gateId: gate.gateId,
              status: gate.status,
              verdict: gate.verdict,
              gateFailures: gate.gateFailures,
              summary: gate.summary,
              sshProfile: gate.sshProfile
            },
            workerHandoff: handoff
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-}"
      ;;
    domestic-relay-append-ssh-prepare)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot domestic-relay-append-ssh-prepare <apply-run-id> [confirm]"
      node -e '
        const [base, runId, confirm = ""] = process.argv.slice(1);
        const confirmed = confirm === "confirm" || confirm === "true";
        const now = new Date();
        const body = {
          actionId: "site-slot.domestic-relay-peer-append-ssh.prepare",
          path: `/internal/v1/site-slots/executions/${encodeURIComponent(runId)}/prepare-domestic-relay-peer-append-ssh`,
          body: {
            confirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === "1" || confirmed,
            confirmRelayPeerAppendSshPrepare: process.env.SITE_SLOT_CONFIRM_RELAY_PEER_APPEND_SSH_PREPARE === "1" || confirmed,
            approvalId: process.env.SITE_SLOT_APPROVAL_ID || `approval-domestic-relay-peer-append-${runId}`,
            changeWindowStart: process.env.SITE_SLOT_CHANGE_WINDOW_START || now.toISOString(),
            changeWindowEnd: process.env.SITE_SLOT_CHANGE_WINDOW_END || new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
            workerId: process.env.SITE_SLOT_WORKER_ID || "worker-domestic-relay",
            workerKind: process.env.SITE_SLOT_WORKER_KIND || "domestic-runner",
            retryLimit: Number(process.env.SITE_SLOT_WORKER_RETRY_LIMIT || "1"),
            rollbackStrategy: process.env.SITE_SLOT_ROLLBACK_STRATEGY || "restore-domestic-wg-peer-before-append",
            requestedBy: process.env.USER || "manage.sh",
            requestId: "manage-domestic-relay-peer-append-ssh-prepare"
          }
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/admin/actions/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            prepare: payload.relayPeerAppendSshPrepare,
            session: payload.session ? {
              sessionId: payload.session.sessionId,
              runId: payload.session.runId,
              mode: payload.session.mode,
              status: payload.session.status,
              gates: payload.session.gates,
              warnings: payload.session.warnings
            } : null,
            job: payload.job ? {
              jobId: payload.job.jobId,
              sessionId: payload.job.sessionId,
              runId: payload.job.runId,
              mode: payload.job.mode,
              status: payload.job.status,
              worker: payload.job.worker,
              approval: payload.job.approval,
              changeWindow: payload.job.changeWindow,
              nextActions: payload.job.nextActions
            } : null
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-}"
      ;;
    worker-run)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-run <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec]"
      node server/scripts/site-slot-worker-run.mjs "$base" "$1" "${2:-simulate}"
      ;;
    worker-report)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-report <job-id> [running|passed|failed|blocked]"
      node -e '
        const [base, jobId, status = "passed"] = process.argv.slice(1);
        const body = {
          workerId: process.env.SITE_SLOT_WORKER_ID || "worker-manage-shadow",
          status,
          message: process.env.SITE_SLOT_WORKER_MESSAGE || `manage.sh worker report ${status}`,
          stepReports: process.env.SITE_SLOT_WORKER_STEP_ID ? [{
            stepId: process.env.SITE_SLOT_WORKER_STEP_ID,
            status,
            exitCode: status === "passed" ? 0 : null,
            stdout: process.env.SITE_SLOT_WORKER_STDOUT || null,
            stderr: process.env.SITE_SLOT_WORKER_STDERR || null,
            attempt: Number(process.env.SITE_SLOT_WORKER_ATTEMPT || "1")
          }] : [],
          requestId: "manage-site-slot-worker-report"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}/reports`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const report = payload.report;
          console.log(JSON.stringify({
            reportId: report.reportId,
            jobId: report.jobId,
            sessionId: report.sessionId,
            runId: report.runId,
            planId: report.planId,
            siteId: report.siteId,
            workerId: report.workerId,
            status: report.status,
            message: report.message,
            rollbackPlan: report.rollbackPlan,
            nextActions: report.nextActions,
            stepReports: report.stepReports.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              sourceId: step.sourceId,
              status: step.status,
              exitCode: step.exitCode,
              stdout: step.stdout,
              stderr: step.stderr,
              attempt: step.attempt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-passed}"
      ;;
    rollback-start)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot rollback-start <report-id> [simulate|manual]"
      node -e '
        const [base, reportId, mode = "simulate"] = process.argv.slice(1);
        const body = {
          mode,
          confirmRollback: process.env.SITE_SLOT_CONFIRM_ROLLBACK === "1",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-rollback-start"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/worker-reports/${encodeURIComponent(reportId)}/rollback-executions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const execution = payload.rollbackExecution;
          console.log(JSON.stringify({
            rollbackExecutionId: execution.rollbackExecutionId,
            contractVersion: execution.contractVersion,
            rollbackPlanId: execution.rollbackPlanId,
            sourceReportId: execution.sourceReportId,
            jobId: execution.jobId,
            sessionId: execution.sessionId,
            runId: execution.runId,
            planId: execution.planId,
            siteId: execution.siteId,
            mode: execution.mode,
            status: execution.status,
            dryRun: execution.dryRun,
            confirmRollback: execution.confirmRollback,
            gates: execution.gates,
            warnings: execution.warnings,
            rollbackPlan: execution.rollbackPlan,
            nextActions: execution.nextActions,
            stepResults: execution.stepResults.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              target: step.target,
              status: step.status,
              exitCode: step.exitCode,
              command: step.command,
              output: step.output,
              error: step.error
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-simulate}"
      ;;
    rollback-report)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot rollback-report <rollback-execution-id> [running|passed|failed|blocked]"
      node -e '
        const [base, rollbackExecutionId, status = "passed"] = process.argv.slice(1);
        const body = {
          workerId: process.env.SITE_SLOT_ROLLBACK_WORKER_ID || process.env.SITE_SLOT_WORKER_ID || "worker-manage-shadow",
          status,
          message: process.env.SITE_SLOT_ROLLBACK_MESSAGE || `manage.sh rollback report ${status}`,
          stepReports: process.env.SITE_SLOT_ROLLBACK_STEP_ID ? [{
            stepId: process.env.SITE_SLOT_ROLLBACK_STEP_ID,
            status,
            exitCode: status === "passed" ? 0 : null,
            stdout: process.env.SITE_SLOT_ROLLBACK_STDOUT || null,
            stderr: process.env.SITE_SLOT_ROLLBACK_STDERR || null,
            attempt: Number(process.env.SITE_SLOT_ROLLBACK_ATTEMPT || "1")
          }] : [],
          requestId: "manage-site-slot-rollback-report"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/rollback-executions/${encodeURIComponent(rollbackExecutionId)}/reports`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const report = payload.rollbackReport;
          console.log(JSON.stringify({
            rollbackReportId: report.rollbackReportId,
            rollbackExecutionId: report.rollbackExecutionId,
            rollbackPlanId: report.rollbackPlanId,
            sourceReportId: report.sourceReportId,
            jobId: report.jobId,
            sessionId: report.sessionId,
            runId: report.runId,
            planId: report.planId,
            siteId: report.siteId,
            workerId: report.workerId,
            status: report.status,
            message: report.message,
            nextActions: report.nextActions,
            stepReports: report.stepReports.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              target: step.target,
              status: step.status,
              exitCode: step.exitCode,
              stdout: step.stdout,
              stderr: step.stderr,
              attempt: step.attempt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-passed}"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops site-slot materialize [oversea|domestic|all] | domestic-wg-materialize <site-id> <endpoint> [rotate] | materialize-domestic-ready <site-id> | internal-service-peer-handoff [status|command|apply] [config-path] | internal-service-peer-host-runner [port] | native-host-runner status|start|install|uninstall [port] | cleanup-v1-wireguard [--apply] [iface...] | refresh-tunnel-cli [version|--from-local DIR|--from-tarball FILE] | ssh-profiles | ssh-profile-upsert <site-id> <domestic|oversea> [host] | ssh-profile-readiness <profile-id> [plan-only|execute] | oversea-readonly-test <site-id> <host> | oversea-remote-test <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute] | domestic-plan <domestic-host|-> [oversea-host] | oversea-plan <oversea-host|-> | preflight <plan-id> [dry-run|manual|ssh] | apply <plan-id> [manual|dry-run|ssh] | executions [plan-id] | runner-start <run-id> [simulate|remote-ssh|awx-shadow] | runner-sessions [run-id] | worker-job <session-id> | worker-gate <job-id> [confirm] | worker-handoff <job-id> [confirm] | domestic-relay-append-ssh-prepare <apply-run-id> [confirm] | worker-run <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec] | worker-report <job-id> [running|passed|failed|blocked] | rollback-start <report-id> [simulate|manual] | rollback-report <rollback-execution-id> [running|passed|failed|blocked]"
      ;;
  esac
}

ops_local_shadow_plan() {
  cat <<'EOF'
Docker Compose local-shadow order:
  1. Build the internal API image.
  2. Start postgres and internal API.
  3. Run HTTP smoke against http://127.0.0.1:18090.
  4. Inspect logs/status if smoke fails.
  5. Down stops containers but keeps the PostgreSQL Docker volume.

Commands:
  bash scripts/manage.sh ops local-shadow build
  bash scripts/manage.sh ops local-shadow up
  bash scripts/manage.sh ops local-shadow smoke
  bash scripts/manage.sh ops local-shadow logs
  bash scripts/manage.sh ops local-shadow down
EOF
}

ops_local_shadow() {
  local action="$1"
  case "$action" in
    plan)
      ops_local_shadow_plan
      ;;
    build)
      shadow_image_build
      ;;
    up)
      (cd server && docker compose -f docker-compose.shadow.yml up -d)
      wait_http_ready "http://127.0.0.1:18090/readyz" 60
      ;;
    status)
      docker ps --filter name=mx- --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
      ;;
    smoke)
      (cd server && pnpm run smoke:http -- "http://127.0.0.1:18090")
      ;;
    logs)
      (cd server && docker compose -f docker-compose.shadow.yml logs --tail=120)
      ;;
    down)
      (cd server && docker compose -f docker-compose.shadow.yml down)
      ;;
    cycle)
      ops_local_shadow_plan
      say "build"
      ops_local_shadow build
      say "up"
      ops_local_shadow up
      say "smoke"
      ops_local_shadow smoke
      say "status"
      ops_local_shadow status
      say "local-shadow cycle OK. Run 'bash scripts/manage.sh ops local-shadow down' when done."
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops local-shadow plan|cycle|build|up|status|smoke|logs|down"
      ;;
  esac
}

ops_k8s_shadow_plan() {
  local target="${1:-internal-shadow}"
  local ops_area="${2:-k8s-shadow}"
  k8s_plan "$target"
  printf '\n'
  k8s_explain "$target"
  cat <<EOF

Local Internal image flow
  - ops $ops_area cycle builds qpjoy/mx-launcher-server:shadow before apply.
  - On kubeadm/containerd hosts, use internal-production deploy so the image is
    imported into the containerd k8s.io namespace before Pods start.
  - The local image tag is reused, so cycle restarts the Internal API
    Deployment after apply. A new Pod then resolves the rebuilt local image.
EOF
}

k8s_restart_internal_api() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  kubectl -n "$ns" rollout restart deployment/mx-launcher-internal
  k8s_rollout_status "$ns" deployment mx-launcher-internal 180s
}

k8s_apply_internal_gateway() {
  local target="$1"
  local ns dir file upstream tmp
  ns="$(k8s_namespace "$target")"
  dir="$(k8s_manifest_dir "$target")"
  file="$dir/45-internal-gateway.yaml"
  if ! k8s_select_internal_api_gateway_upstream "$ns"; then
    k8s_workload_diagnostics "$ns" deployment mx-launcher-internal
    die "internal gateway upstream is not reachable from a cluster probe pod"
  fi
  if kubectl -n "$ns" get configmap mx-internal-gateway-caddy >/dev/null 2>&1; then
    say "preserve existing internal gateway routes and refresh upstream"
    awk 'BEGIN { skip=1 } /^---[[:space:]]*$/ { skip=0; print; next } !skip { print }' "$file" | kubectl apply --validate=false -f -
  else
    kubectl apply --validate=false -f "$file"
  fi
  upstream="$K8S_SELECTED_INTERNAL_API_UPSTREAM"
  tmp="$(mktemp -d)"
  kubectl -n "$ns" get configmap mx-internal-gateway-caddy -o go-template='{{ index .data "Caddyfile" }}' >"$tmp/Caddyfile"
  kubectl -n "$ns" get configmap mx-internal-gateway-caddy -o go-template='{{ index .data "mx-gateway-routes.json" }}' >"$tmp/mx-gateway-routes.json"
  awk -v upstream="$upstream" '
    BEGIN { replaced = 0 }
    !replaced && /^[[:space:]]*reverse_proxy[[:space:]].*:18090[[:space:]]*$/ {
      indent = $0
      sub(/reverse_proxy.*/, "", indent)
      print indent "reverse_proxy " upstream
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) {
        exit 2
      }
    }
  ' "$tmp/Caddyfile" >"$tmp/Caddyfile.next" || {
    rm -rf "$tmp"
    die "failed to patch internal gateway Caddyfile upstream"
  }
  say "set internal gateway upstream: $upstream"
  kubectl -n "$ns" create configmap mx-internal-gateway-caddy \
    --from-file=Caddyfile="$tmp/Caddyfile.next" \
    --from-file=mx-gateway-routes.json="$tmp/mx-gateway-routes.json" \
    --dry-run=client -o yaml | kubectl apply --validate=false -f -
  kubectl -n "$ns" label configmap mx-internal-gateway-caddy \
    app.kubernetes.io/name=mx-internal-gateway \
    app.kubernetes.io/part-of=mx-3ks \
    mx.qpjoy.com/component=internal-gateway \
    --overwrite >/dev/null
  kubectl -n "$ns" rollout restart daemonset/mx-internal-gateway >/dev/null 2>&1 || true
  rm -rf "$tmp"
}

ops_k8s_shadow() {
  local action="$1"
  local target="${OPS_K8S_TARGET:-internal-shadow}"
  local ops_area="${OPS_K8S_AREA:-k8s-shadow}"
  case "$action" in
    plan)
      ops_k8s_shadow_plan "$target" "$ops_area"
      ;;
    dry-run)
      k8s_dry_run "$target"
      ;;
    build)
      shadow_image_build
      ;;
    cycle)
      ops_k8s_shadow_plan "$target" "$ops_area"
      say "build image"
      shadow_image_build
      say "apply"
      k8s_apply "$target"
      say "restart internal api for rebuilt local image"
      k8s_restart_internal_api "$target"
      say "refresh internal gateway upstream"
      k8s_apply_internal_gateway "$target"
      k8s_rollout_status "$(k8s_namespace "$target")" daemonset mx-internal-gateway 180s
      say "status"
      k8s_status "$target"
      say "smoke"
      k8s_smoke "$target" "${2:-18090}"
      say "db summary"
      k8s_db_summary "$target"
      say "$ops_area cycle OK. Run 'bash scripts/manage.sh ops $ops_area down' when done."
      ;;
    apply)
      k8s_apply "$target"
      ;;
    status)
      k8s_status "$target"
      ;;
    port-forward|forward)
      k8s_port_forward "$target" "${2:-18090}" "${3:-}"
      ;;
    smoke)
      k8s_smoke "$target" "${2:-18090}"
      ;;
    gateway-smoke)
      k8s_gateway_smoke "$target" "${2:-}"
      ;;
    gate)
      k8s_internal_shadow_gate "$target" "${2:-18090}"
      ;;
    gate-manual)
      [ "$#" -ge 2 ] && [ "$#" -le 3 ] || die "Usage: bash scripts/manage.sh ops $ops_area gate-manual <evidence-json> [local-port]"
      k8s_internal_shadow_gate_manual "$target" "$2" "${3:-18090}"
      ;;
    manual-evidence)
      shift || true
      internal_shadow_manual_evidence "$@"
      ;;
    logs)
      k8s_logs "$target"
      ;;
    db-summary)
      k8s_db_summary "$target"
      ;;
    reset-data)
      k8s_reset_data "$target"
      ;;
    cleanup-smoke-fixtures)
      k8s_cleanup_smoke_fixtures "$target" "${2:-plan}"
      ;;
    remote-runner)
      shift || true
      [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh ops $ops_area remote-runner enable|disable"
      k8s_remote_runner "$target" "$1"
      ;;
    readonly-probe)
      shift || true
      [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh ops $ops_area readonly-probe enable|disable"
      k8s_readonly_probe "$target" "$1"
      ;;
    ssh-bootstrap)
      shift || true
      [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh ops $ops_area ssh-bootstrap enable|disable"
      k8s_ssh_bootstrap "$target" "$1"
      ;;
    down)
      k8s_down "$target"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-local plan|dry-run|cycle|build|apply|status|port-forward [local-port] [bind-address]|gate|gate-manual|manual-evidence|smoke|gateway-smoke [gateway-url]|logs|db-summary|reset-data|cleanup-smoke-fixtures [--apply]|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down"
      ;;
  esac
}

ops_internal_production_plan() {
  cat <<'EOF'
MX Launcher Internal production deployment

This path deploys the Internal K8s control plane plus a long-running host
gateway. It is intended for the Internal CentOS/Ubuntu runtime host, not for
short-lived desktop port-forward testing.

Gateway:
  - DaemonSet: mx-internal-gateway
  - Host bind: 0.0.0.0:18090
  - App bind:   0.0.0.0:80 when free, fallback 0.0.0.0:8008 when host 80 is occupied
  - Upstream:  mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090
  - Smoke URL: http://127.0.0.1:18090 by default

Commands:
  bash scripts/manage.sh ops internal-production deploy
  bash scripts/manage.sh ops internal-production status
  bash scripts/manage.sh ops internal-production gateway-smoke
  bash scripts/manage.sh ops internal-production cleanup-smoke-fixtures
  bash scripts/manage.sh ops internal-production down

Notes:
  - qpjoy/mx-launcher-server:shadow is local-only. Deploy does not push it to
    Docker Hub; it imports and verifies the image in containerd k8s.io after
    Docker build.
  - It also preloads postgres/coredns/caddy runtime images through Docker and
    imports them into containerd so Docker proxy/TUN egress can be reused.
  - On kubeadm Internal hosts, deploy auto-repairs stale LAN IPs in
    /etc/kubernetes and kubeconfig before the first kubectl apply. Override the
    detected IP with MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.x.x, or disable
    this guard with MX_K8S_AUTO_REPAIR_KUBEADM_ENDPOINT=0.
  - To change the Linux hostname safely, set MX_K8S_OS_HOSTNAME=mx-internal
    and leave MX_K8S_NODE_NAME empty. Deploy keeps the existing Kubernetes node
    identity pinned through kubelet --hostname-override, so a router/hostname
    change does not create a second Node. Only set MX_K8S_NODE_NAME for a
    planned Kubernetes node identity migration.
  - On kubeadm Internal hosts, deploy also repairs Flannel before Internal
    workloads start when /run/flannel/subnet.env is missing or the daemonset is
    not ready. Disable with MX_K8S_REPAIR_FLANNEL=0, override the manifest with
    MX_K8S_FLANNEL_URL=/path/to/kube-flannel.yml, or set
    MX_K8S_FLANNEL_IMAGE_REPOSITORY=docker.io/flannel when GHCR is blocked.
    When the Kubernetes service VIP is not reachable yet, deploy points Flannel
    directly at the repaired apiserver IP; disable this with
    MX_K8S_FLANNEL_DIRECT_APISERVER=0.
  - Deploy waits for kube-system CoreDNS after Flannel recovery so Pods can
    resolve services such as mx-internal-postgres before migrations start.
    Disable this guard with MX_K8S_RECOVER_CLUSTER_DNS=0.
  - Existing mx-internal-gateway-caddy data is preserved during deploy so
    generated gateway routes are not reset to the bootstrap Caddyfile.
  - gateway-smoke is read-only and checks /healthz plus /readyz. Full HTTP
    smoke is a development check because it writes smoke fixtures.
  - Keep TCP 18090 private to the Internal host, Internal WG service peer, or a
    trusted LAN. Do not expose PostgreSQL or Docker daemon.
  - Deploy does not sudo-install or restart mx-internal-svc. Site-slot artifacts
    are persisted by the mx-launcher-site-slots PV; only when WG keys/routes
    change should you materialize/apply the handoff explicitly:
    bash scripts/manage.sh ops site-slot materialize-domestic-ready domestic-main
    bash scripts/manage.sh ops site-slot internal-service-peer-handoff apply
  - HDO V1 uses 8080 and hdo-home/hdo-internal; this path does not stop them.
EOF
}

ops_internal_production_repair_kubeadm_endpoint_if_requested() {
  if [ -n "${MX_K8S_APISERVER_ADVERTISE_ADDRESS:-${K8S_APISERVER_ADVERTISE_ADDRESS:-}}" ]; then
    k8s_repair_kubeadm_endpoint
  fi
}

ops_internal_production() {
  local action="$1"
  shift || true
  case "$action" in
    plan)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops internal-production plan"
      ops_internal_production_plan
      ;;
    deploy|cycle)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops internal-production deploy [gateway-url]"
      ops_internal_production_plan
      k8s_repair_kubeadm_endpoint
      say "build Internal image"
      MX_SHADOW_REFRESH_QP_TUNNEL_CLI_STRICT="${MX_SHADOW_REFRESH_QP_TUNNEL_CLI_STRICT:-1}"
      shadow_image_build
      shadow_image_import_containerd
      say "preload K8s runtime images"
      k8s_preload_runtime_images
      say "apply Internal K8s production stack"
      k8s_apply internal-shadow
      say "restart Internal API for rebuilt image"
      k8s_restart_internal_api internal-shadow
      if [ "${MX_INTERNAL_PRODUCTION_NATIVE_HOST_RUNNER_INSTALL:-1}" = "1" ]; then
        say "install/restart native Internal host runner"
        native_host_runner_install "${MX_INTERNAL_HOST_RUNNER_PORT:-19190}"
      else
        say "skip native Internal host runner install because MX_INTERNAL_PRODUCTION_NATIVE_HOST_RUNNER_INSTALL=0"
      fi
      say "configure Internal API native host-runner URL"
      ops_local_platform_apply_native_host_runner_url
      say "refresh Internal gateway upstream"
      k8s_apply_internal_gateway internal-shadow
      k8s_rollout_status "$(k8s_namespace internal-shadow)" daemonset mx-internal-gateway 180s
      say "status"
      k8s_status internal-shadow
      say "gateway smoke"
      k8s_gateway_smoke internal-shadow "${1:-}"
      say "db summary"
      k8s_db_summary internal-shadow
      say "internal-production deploy OK"
      ;;
    apply)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops internal-production apply"
      ops_internal_production_repair_kubeadm_endpoint_if_requested
      k8s_apply internal-shadow
      ;;
    status)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops internal-production status"
      ops_internal_production_repair_kubeadm_endpoint_if_requested
      k8s_status internal-shadow
      ;;
    gateway-smoke|smoke)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops internal-production gateway-smoke [gateway-url]"
      ops_internal_production_repair_kubeadm_endpoint_if_requested
      k8s_gateway_smoke internal-shadow "${1:-}"
      ;;
    cleanup-smoke-fixtures)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops internal-production cleanup-smoke-fixtures [--apply]"
      ops_internal_production_repair_kubeadm_endpoint_if_requested
      k8s_cleanup_smoke_fixtures internal-shadow "${1:-plan}"
      ;;
    down)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops internal-production down"
      ops_internal_production_repair_kubeadm_endpoint_if_requested
      k8s_down internal-shadow
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-production plan|deploy [gateway-url]|apply|status|gateway-smoke [gateway-url]|cleanup-smoke-fixtures [--apply]|down"
      ;;
  esac
}

menu_status() {
  ops_doctor || true
  printf '\n'

  if command -v kubectl >/dev/null 2>&1; then
    local ns
    ns="$(k8s_namespace internal-local)"
    say "k8s namespace: $ns"
    kubectl -n "$ns" get deploy,statefulset,daemonset,pod,svc,job,pvc 2>/dev/null || say "local Internal K8s is not running yet"
  else
    say "kubectl is missing; start Docker Desktop Kubernetes or install kubectl before K8s tests"
  fi
}

menu_browser_plan() {
  cat <<'EOF'
Browser manual test path for local K8s Internal:

Terminal 1: keep the Internal API exposed while you test.
  cd electron-dock/mx-launcher
  bash scripts/manage.sh ops internal-local port-forward

Browser:
  http://127.0.0.1:18090/admin/

Manual checks:
  1. Server URL is http://127.0.0.1:18090.
  2. App Center loads HDI without console errors.
  3. Switch to Admin and click Refresh.
  4. Confirm dashboard metrics, topology, action list, and site-slot pipelines render.
  5. Create or reuse an SSH Profile, then create a plan from it.
  6. Run Preflight, Apply, Runner, Worker Job, and plan-only/dry-run worker actions.
  7. Open Evidence Drawer and verify execution, runner, worker job, and report details.

Record manual evidence after checks:
  bash scripts/manage.sh ops internal-local manual-evidence passed "browser manual path passed"

Run gate with manual evidence required:
  bash scripts/manage.sh ops internal-local gate-manual server/artifacts/internal-shadow-gates/manual/manual-browser-evidence-xxx.json

Non-interactive equivalents:
  bash scripts/manage.sh ops internal-local cycle
  bash scripts/manage.sh ops internal-local gate
  bash scripts/manage.sh ops internal-local manual-evidence passed "browser manual path passed"
  bash scripts/manage.sh ops internal-local smoke
  bash scripts/manage.sh ops internal-local db-summary
  MX_K8S_SHADOW_CONFIRM_RESET=1 bash scripts/manage.sh ops internal-local reset-data
  bash scripts/manage.sh ops internal-local logs
EOF
}

menu_reset_data() {
  cat <<'EOF'
This will clear local K8s shadow business records:
  table: mx_platform_records

It keeps:
  - mx_schema_migrations
  - the PostgreSQL database and PVC
  - K8s namespace/workloads

After truncating records, Internal API is restarted so built-in App Center/DNS
records are seeded again.
EOF
  printf '\nType reset to continue> '
  local confirm
  IFS= read -r confirm || return 0
  if [ "$confirm" != "reset" ]; then
    say "reset-data cancelled"
    return 0
  fi
  MX_K8S_SHADOW_CONFIRM_RESET=1 k8s_reset_data internal-shadow
}

menu_manual_evidence() {
  printf 'Manual evidence status [passed/failed/blocked] (default passed)> '
  local status
  IFS= read -r status || return 0
  status="${status:-passed}"
  case "$status" in
    passed|failed|blocked)
      ;;
    *)
      say "manual-evidence cancelled: invalid status $status"
      return 0
      ;;
  esac
  printf 'Notes (optional)> '
  local notes
  IFS= read -r notes || notes=""
  internal_shadow_manual_evidence "$status" "$notes"
}

menu_oversea_readonly_test() {
  cat <<'EOF'
Oversea readonly true-host test requires local SSH files:
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts

For K8s shadow, run option remote-runner enable before this test.
Run option readonly-probe enable before executing the true read-only SSH probe.
EOF
  printf 'Oversea site id (default oversea-main)> '
  local site_id
  IFS= read -r site_id || return 0
  site_id="${site_id:-oversea-main}"
  printf 'Oversea host/IP> '
  local host
  IFS= read -r host || return 0
  if [ -z "$host" ]; then
    say "oversea-readonly-test cancelled: host is required"
    return 0
  fi
  ops_site_slot oversea-readonly-test "$site_id" "$host"
}

menu_oversea_remote_test() {
  cat <<'EOF'
Oversea remote test uses the same gated worker path as Admin:
  pipeline  = materialize + artifact dry-run + remote command plan + readonly SSH probe
  execute   = real SSH/rsync/scp execution; requires SITE_SLOT_CONFIRM_OVERSEA_EXECUTE=1

Required local SSH files:
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts

For K8s shadow, run option remote-runner enable before this test.
Run option readonly-probe enable before executing the true read-only SSH probe.
EOF
  printf 'Oversea site id (default oversea-main)> '
  local site_id
  IFS= read -r site_id || return 0
  site_id="${site_id:-oversea-main}"
  printf 'Oversea host/IP> '
  local host
  IFS= read -r host || return 0
  if [ -z "$host" ]; then
    say "oversea-remote-test cancelled: host is required"
    return 0
  fi
  printf 'Mode [pipeline/dry-run/plan-only/readonly/execute] (default pipeline)> '
  local mode
  IFS= read -r mode || return 0
  mode="${mode:-pipeline}"
  ops_site_slot oversea-remote-test "$site_id" "$host" "$mode"
}

menu_remote_runner() {
  printf 'Remote runner [enable/disable] (default enable)> '
  local state
  IFS= read -r state || return 0
  state="${state:-enable}"
  ops_k8s_shadow remote-runner "$state"
}

menu_readonly_probe() {
  printf 'Readonly probe execution [enable/disable] (default enable)> '
  local state
  IFS= read -r state || return 0
  state="${state:-enable}"
  ops_k8s_shadow readonly-probe "$state"
}

menu_ssh_bootstrap() {
  printf 'SSH password bootstrap [enable/disable] (default enable)> '
  local state
  IFS= read -r state || return 0
  state="${state:-enable}"
  ops_k8s_shadow ssh-bootstrap "$state"
}

menu_show() {
  printf '\n'
  if [ -t 1 ]; then
    printf '\033[36mQPJoy MX Launcher Manager\033[0m\n'
  else
    printf 'QPJoy MX Launcher Manager\n'
  fi
  cat <<'EOF'

 1) status            本机 Internal/K8s 状态
 2) doctor            检查 Node / pnpm / Docker / kubectl
 3) k8s-plan          查看本机 Internal K8s 部署计划
 4) k8s-dry-run       K8s manifests + Secret dry-run
 5) k8s-build         构建本机 Internal API 镜像
 6) k8s-apply         启动/更新本机 K8s Internal
 7) k8s-cycle         build + apply + smoke + DB summary
 8) k8s-gate          Internal Local Gate + Test Center evidence
 9) k8s-smoke         port-forward 后跑 HTTP smoke
10) k8s-db            查看 K8s PostgreSQL 数据摘要
11) k8s-logs          查看 Internal API 日志
12) browser           浏览器手测步骤
13) manual-evidence   生成浏览器手测 evidence JSON
14) desktop-check     检查桌面 Admin/Evidence UI 脚本
15) server-typecheck  检查服务端 TypeScript
16) artifacts         生成 Domestic/Oversea slot artifacts
17) reset-data        清空本机 Internal 业务数据（保留 PVC/迁移记录）
18) remote-runner     为真机只读测试临时启/停 remote runner
19) readonly-probe    为真机只读 Probe 临时启/停执行闸门
20) ssh-bootstrap     为初次空 Ubuntu 临时启/停密码换 key
21) oversea-readonly  跑 Oversea 真机只读 Probe 并写 worker evidence
22) oversea-remote    跑 Oversea 真机 pipeline / gated 安装
23) down              停掉 K8s workloads（保留 PVC）
24) awx-plan          查看 AWX shadow 部署计划
25) awx-install       部署/恢复本机 K8s AWX shadow
26) awx-status        查看 AWX shadow 状态
27) awx-password      输出 AWX admin 密码
28) platform-cycle    一键 AWX + Internal + provider
29) guide             查看本机测试方案
30) ui-design         构建 Neon Void 样式组件库
31) help              查看 CLI 帮助
32) quit              退出
EOF
}

menu_pause() {
  printf '\n按 Enter 返回菜单...'
  IFS= read -r _ || true
}

menu_run() {
  local choice="$1"
  case "$choice" in
    1|status)
      menu_status
      ;;
    2|doctor)
      ops_doctor
      ;;
    3|k8s-plan|plan)
      ops_k8s_shadow plan
      ;;
    4|k8s-dry-run|dry-run)
      ops_k8s_shadow dry-run
      ;;
    5|k8s-build|build)
      ops_k8s_shadow build
      ;;
    6|k8s-apply|apply)
      ops_k8s_shadow apply
      ;;
    7|k8s-cycle|cycle)
      ops_k8s_shadow cycle
      ;;
    8|k8s-gate|gate)
      ops_k8s_shadow gate
      ;;
    9|k8s-smoke|smoke)
      ops_k8s_shadow smoke
      ;;
    10|k8s-db|db|db-summary)
      ops_k8s_shadow db-summary
      ;;
    11|k8s-logs|logs)
      ops_k8s_shadow logs
      ;;
    12|browser|manual)
      menu_browser_plan
      ;;
    13|manual-evidence)
      menu_manual_evidence
      ;;
    14|desktop-check)
      (cd desktop && pnpm run check)
      ;;
    15|server-typecheck)
      run_tsc -p server/tsconfig.json --noEmit
      ;;
    16|artifacts|materialize)
      ops_site_slot materialize all
      ;;
    17|reset-data|reset)
      menu_reset_data
      ;;
    18|remote-runner)
      menu_remote_runner
      ;;
    19|readonly-probe)
      menu_readonly_probe
      ;;
    20|ssh-bootstrap|bootstrap)
      menu_ssh_bootstrap
      ;;
    21|oversea-readonly|oversea-readonly-test)
      menu_oversea_readonly_test
      ;;
    22|oversea-remote|oversea-remote-test)
      menu_oversea_remote_test
      ;;
    23|down)
      ops_k8s_shadow down
      ;;
    24|awx-plan)
      ops_awx_shadow plan
      ;;
    25|awx-install)
      ops_awx_shadow install
      ;;
    26|awx-status)
      ops_awx_shadow status
      ;;
    27|awx-password)
      ops_awx_shadow password
      ;;
    28|platform-cycle|local-platform)
      ops_local_platform cycle
      ;;
    29|guide)
      ops_guide
      ;;
    30|ui-design)
      ui_design build
      ;;
    31|help)
      usage
      ;;
    32|quit|q|exit)
      MENU_QUIT=1
      return 0
      ;;
    *)
      say "Unknown option: $choice"
      ;;
  esac
}

menu() {
  while true; do
    menu_show
    printf '\n选择> '
    IFS= read -r choice || return 0
    MENU_QUIT=0
    menu_run "$choice"
    [ "${MENU_QUIT:-0}" -eq 1 ] && return 0
    menu_pause
  done
}

doctor() {
  local role="internal"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --role)
        role="${2:-}"
        shift 2
        ;;
      *)
        die "Unknown doctor option: $1"
        ;;
    esac
  done

  say "MX Launcher root: $ROOT"
  say "role: $role"
  say "modules: $(role_modules "$role")"

  command -v node >/dev/null 2>&1 || die "node is required"
  command -v pnpm >/dev/null 2>&1 || say "pnpm not found; package scripts will need pnpm"

  [ -f desktop/package.json ] || die "missing desktop/package.json"
  [ -f server/package.json ] || die "missing server/package.json"
  [ -f desktop/electron-builder.yml ] || die "missing desktop/electron-builder.yml"
  [ -d desktop/products/hdi ] || die "missing desktop/products/hdi/"

  say "doctor OK"
}

ui_design() {
  local action="${1:-build}"
  shift || true
  case "$action" in
    build|check)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ui-design build"
      (cd "$ROOT" && pnpm --filter @qpjoy/ui-design-neon-void build)
      ;;
    pack)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ui-design pack"
      local preview_dir="/tmp/qpjoy-publish-preview"
      rm -rf "$preview_dir"
      mkdir -p "$preview_dir"
      (cd "$ROOT" && pnpm --filter @qpjoy/ui-design-neon-void build)
      (cd "$ROOT/ui-design" && pnpm pack --pack-destination "$preview_dir")
      say "pack preview: $preview_dir"
      ;;
    demo)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ui-design demo [port]"
      local port="${1:-18130}"
      say "demo: http://127.0.0.1:$port/demos/ui-design-neon-void/"
      (cd "$ROOT" && PORT="$port" pnpm --filter @qpjoy/ui-design-neon-void-demo dev)
      ;;
    *)
      die "Usage: bash scripts/manage.sh ui-design build|pack|demo [port]"
      ;;
  esac
}

case "$cmd" in
  menu)
    [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh menu"
    menu
    ;;
  help|-h|--help)
    usage
    ;;
  doctor)
    doctor "$@"
    ;;
  check)
    (cd desktop && pnpm run check)
    run_tsc -p desktop/tsconfig.json --noEmit
    run_tsc -p server/tsconfig.json --noEmit
    ;;
  ui-design)
    ui_design "$@"
    ;;
  desktop-check)
    (cd desktop && pnpm run check)
    ;;
  desktop-typecheck|typecheck)
    run_tsc -p desktop/tsconfig.json --noEmit
    ;;
  server-typecheck)
    run_tsc -p server/tsconfig.json --noEmit
    ;;
  profile)
    [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh profile internal|domestic|oversea|h-endpoint-dev"
    role_modules "$1"
    ;;
  smoke)
    [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh smoke platform-kernel|server-http [base-url]"
    target="$1"
    shift || true
    case "$target" in
      platform-kernel)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh smoke platform-kernel"
        (cd server && pnpm run smoke:platform-kernel)
        ;;
      server-http)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh smoke server-http [base-url]"
        (cd server && pnpm run smoke:http -- "${1:-http://127.0.0.1:18090}")
        ;;
      *)
        die "Unknown smoke target: $target"
        ;;
    esac
    ;;
  shadow)
    [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh shadow admin-assets|build|up|smoke|logs|down"
    action="$1"
    shift || true
    case "$action" in
      admin-assets)
        shadow_image_admin_assets
        ;;
    build)
      shadow_image_build
      ;;
      up)
        (cd server && docker compose -f docker-compose.shadow.yml up -d)
        wait_http_ready "http://127.0.0.1:18090/readyz" 60
        ;;
      smoke)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh shadow smoke [base-url]"
        (cd server && pnpm run smoke:http -- "${1:-http://127.0.0.1:18090}")
        ;;
      logs)
        (cd server && docker compose -f docker-compose.shadow.yml logs --tail=120)
        ;;
      down)
        (cd server && docker compose -f docker-compose.shadow.yml down)
        ;;
      *)
        die "Unknown shadow action: $action"
        ;;
    esac
    ;;
  k8s)
    [ "$#" -ge 2 ] || die "Usage: bash scripts/manage.sh k8s plan|explain|render|dry-run|apply|status|port-forward|logs|db-summary|reset-data|cleanup-smoke-fixtures|remote-runner|readonly-probe|ssh-bootstrap|gate|gate-manual|smoke|gateway-smoke|down internal-local"
    action="$1"
    target="$2"
    shift 2 || true
    case "$action" in
      plan)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s plan internal-shadow"
        k8s_plan "$target"
        ;;
      explain)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s explain internal-shadow"
        k8s_explain "$target"
        ;;
      render)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s render internal-shadow"
        k8s_render "$target"
        ;;
      dry-run)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s dry-run internal-shadow"
        k8s_dry_run "$target"
        ;;
      apply)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s apply internal-shadow"
        k8s_apply "$target"
        ;;
      status)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s status internal-shadow"
        k8s_status "$target"
        ;;
      port-forward|forward)
        [ "$#" -le 2 ] || die "Usage: bash scripts/manage.sh k8s port-forward internal-local [local-port] [bind-address]"
        k8s_port_forward "$target" "${1:-18090}" "${2:-}"
        ;;
      logs)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s logs internal-shadow"
        k8s_logs "$target"
        ;;
      db-summary)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s db-summary internal-shadow"
        k8s_db_summary "$target"
        ;;
      reset-data)
        [ "$#" -eq 0 ] || die "Usage: MX_K8S_SHADOW_CONFIRM_RESET=1 bash scripts/manage.sh k8s reset-data internal-shadow"
        k8s_reset_data "$target"
        ;;
      cleanup-smoke-fixtures)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh k8s cleanup-smoke-fixtures internal-shadow [--apply]"
        k8s_cleanup_smoke_fixtures "$target" "${1:-plan}"
        ;;
      remote-runner)
        [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh k8s remote-runner internal-shadow enable|disable"
        k8s_remote_runner "$target" "$1"
        ;;
      readonly-probe)
        [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh k8s readonly-probe internal-shadow enable|disable"
        k8s_readonly_probe "$target" "$1"
        ;;
      ssh-bootstrap)
        [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh k8s ssh-bootstrap internal-shadow enable|disable"
        k8s_ssh_bootstrap "$target" "$1"
        ;;
      gate)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh k8s gate internal-shadow [local-port]"
        k8s_internal_shadow_gate "$target" "${1:-18090}"
        ;;
      gate-manual)
        [ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "Usage: bash scripts/manage.sh k8s gate-manual internal-shadow <evidence-json> [local-port]"
        k8s_internal_shadow_gate_manual "$target" "$1" "${2:-18090}"
        ;;
      smoke)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh k8s smoke internal-shadow [local-port]"
        k8s_smoke "$target" "${1:-18090}"
        ;;
      gateway-smoke)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh k8s gateway-smoke internal-shadow [gateway-url]"
        k8s_gateway_smoke "$target" "${1:-}"
        ;;
      down)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s down internal-shadow"
        k8s_down "$target"
        ;;
      *)
        die "Unknown k8s action: $action"
        ;;
    esac
    ;;
  ops)
    [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops guide|doctor|config|admin|site-slot|local-shadow|k8s-shadow|awx-shadow|awx-provider|local-platform|internal-production"
    area="$1"
    shift || true
    case "$area" in
      guide)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops guide"
        ops_guide
        ;;
      doctor)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops doctor"
        ops_doctor
        ;;
      config)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops config feature-list [feature-key] | feature-set <feature-key> <true|false> [plan-only|readonly-execute|remote-execute|disabled] [global|site|profile] [scope-id]"
        ops_config "$@"
        ;;
      admin)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops admin dashboard | actions [token] | site-slot-pipelines [plan-id]"
        ops_admin "$@"
        ;;
      site-slot)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot materialize [oversea|domestic|all] | domestic-wg-materialize <site-id> <endpoint> [rotate] | refresh-tunnel-cli [version|--from-local DIR|--from-tarball FILE] | ssh-profiles | ssh-profile-upsert <site-id> <domestic|oversea> [host] | ssh-profile-readiness <profile-id> [plan-only|execute] | oversea-readonly-test <site-id> <host> | oversea-remote-test <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute] | domestic-plan <domestic-host|-> [oversea-host] | oversea-plan <oversea-host|-> | preflight <plan-id> [dry-run|manual|ssh] | apply <plan-id> [manual|dry-run|ssh] | executions [plan-id] | runner-start <run-id> [simulate|remote-ssh|awx-shadow] | runner-sessions [run-id] | worker-job <session-id> | worker-gate <job-id> [confirm] | worker-handoff <job-id> [confirm] | domestic-relay-append-ssh-prepare <apply-run-id> [confirm] | worker-run <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec] | worker-report <job-id> [running|passed|failed|blocked] | rollback-start <report-id> [simulate|manual] | rollback-report <rollback-execution-id> [running|passed|failed|blocked]"
        ops_site_slot "$@"
        ;;
      local-shadow)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops local-shadow plan|cycle|build|up|status|smoke|logs|down"
        ops_local_shadow "$@"
        ;;
      internal-local)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops internal-local plan|dry-run|cycle|build|apply|status|port-forward [local-port] [bind-address]|gate|gate-manual|manual-evidence|smoke|logs|db-summary|reset-data|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down"
        OPS_K8S_TARGET=internal-local OPS_K8S_AREA=internal-local ops_k8s_shadow "$@"
        ;;
      k8s-shadow)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops k8s-shadow plan|dry-run|cycle|build|apply|status|gate|gate-manual|manual-evidence|smoke|gateway-smoke [gateway-url]|logs|db-summary|reset-data|cleanup-smoke-fixtures [--apply]|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down"
        ops_k8s_shadow "$@"
        ;;
      awx-shadow)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops awx-shadow plan|dry-run|install|status|port-forward [local-port]|logs|password|down"
        ops_awx_shadow "$@"
        ;;
      awx-provider)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops awx-provider list|upsert [provider-id] [base-url]|check <provider-id>"
        ops_awx_provider "$@"
        ;;
      local-platform)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops local-platform plan|dry-run|cycle [local-port]|status|down"
        ops_local_platform "$@"
        ;;
      internal-production)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops internal-production plan|deploy [gateway-url]|apply|status|gateway-smoke [gateway-url]|cleanup-smoke-fixtures [--apply]|down"
        ops_internal_production "$@"
        ;;
      *)
        die "Unknown ops area: $area"
        ;;
    esac
    ;;
  *)
    usage
    die "Unknown command: $cmd"
    ;;
esac
