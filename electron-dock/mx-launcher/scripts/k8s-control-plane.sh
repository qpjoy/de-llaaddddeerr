#!/usr/bin/env bash
# Sourceable read-only Kubernetes preflight shared by Launcher and Insight Hub.
# The caller supplies say/die; this file never changes context, traps or services.

k8s_control_plane_server() {
  local server
  command -v kubectl >/dev/null 2>&1 || { die "kubectl is required for Kubernetes preflight"; return 1; }
  server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')" \
    || { die "cannot read the current Kubernetes API endpoint from kubeconfig"; return 1; }
  case "$server" in
    http://*|https://*) ;;
    *) die "current kubeconfig has no supported HTTP(S) API endpoint"; return 1 ;;
  esac
  # Do not print credentials or query parameters from a malformed server URL.
  case "$server" in
    *'@'*|*'?'*|*'#'*|*[[:space:]]*)
      die "current kubeconfig API endpoint contains unsupported URL components"; return 1 ;;
  esac
  printf '%s\n' "$server"
}

k8s_control_plane_server_host() {
  local authority host
  authority="${1#*://}"
  authority="${authority%%/*}"
  case "$authority" in
    \[*\]*) host="${authority#\[}"; host="${host%%\]*}" ;;
    *) host="${authority%%:*}" ;;
  esac
  [ -n "$host" ] || { die "current kubeconfig API endpoint has no host"; return 1; }
  printf '%s\n' "$host"
}

k8s_append_no_proxy_entries() {
  local current="$1" entries="$2" result entry
  local parts=()
  result="$current"
  IFS=',' read -r -a parts <<<"$entries"
  for entry in "${parts[@]}"; do
    [ -n "$entry" ] || continue
    case ",$result," in
      *",$entry,"*) ;;
      *) result="${result:+$result,}$entry" ;;
    esac
  done
  printf '%s\n' "$result"
}

k8s_configure_proxy_bypass() {
  [ "${MX_K8S_CONFIGURE_NO_PROXY:-1}" = "1" ] || return 0
  local server host pod_cidr service_cidr entries
  server="${1:-}"
  [ -n "$server" ] || server="$(k8s_control_plane_server)" || return 1
  host="$(k8s_control_plane_server_host "$server")" || return 1
  pod_cidr="${MX_K8S_POD_CIDR:-${POD_CIDR:-${K8S_POD_CIDR:-}}}"
  service_cidr="${MX_K8S_SERVICE_CIDR:-${SERVICE_CIDR:-${K8S_SERVICE_CIDR:-}}}"
  entries="localhost,127.0.0.1,::1,$host,$pod_cidr,$service_cidr,192.168.0.0/16,.svc,.cluster.local,kubernetes.default.svc,kubernetes.default.svc.cluster.local"
  export NO_PROXY no_proxy
  NO_PROXY="$(k8s_append_no_proxy_entries "${NO_PROXY:-}" "$entries")"
  no_proxy="$(k8s_append_no_proxy_entries "${no_proxy:-}" "$entries")"
  say "NO_PROXY includes current kube-apiserver host $host and Kubernetes local ranges"
}

k8s_control_plane_failure_diagnostics() {
  say "Control-plane checks are read-only; no services, static Pods or application resources were changed."
  # These host observations are optional and bounded, including on a broken host.
  if command -v timeout >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      say "local containerd/kubelet service states (the selected cluster may be remote)"
      timeout 5s systemctl is-active containerd kubelet 2>&1 || true
    fi
    if command -v ss >/dev/null 2>&1; then
      say "local API/etcd listeners"
      timeout 5s ss -lnt 2>/dev/null | awk 'NR == 1 || /:(6443|2379|2380)[[:space:]]/' || true
    fi
  fi
  say "Connection refused means the TCP endpoint did not accept a connection; it does not establish a certificate or address problem."
  say "If /readyz reports unhealthy checks, inspect etcd/storage and kubelet/static-Pod logs on the control-plane host."
  say "Host diagnostics: journalctl -u kubelet -n 120 --no-pager; crictl --timeout 5s ps -a --name 'kube-apiserver|etcd'"
}

k8s_require_apiserver_ready() {
  local server attempts timeout i
  attempts="${MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS:-6}"
  timeout="${MX_K8S_APISERVER_PREFLIGHT_TIMEOUT:-5s}"
  case "$attempts" in
    ''|*[!0-9]*|0*) die "MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS must be a positive integer"; return 1 ;;
  esac
  # kubectl accepts 0 as an unlimited request timeout; reject it for this gate.
  if ! [[ "$timeout" =~ ^[1-9][0-9]*(ms|s|m)$ ]]; then
    die "MX_K8S_APISERVER_PREFLIGHT_TIMEOUT must be a positive duration such as 5s"; return 1
  fi
  server="$(k8s_control_plane_server)" || return 1
  k8s_configure_proxy_bypass "$server" || return 1
  say "preflight current kube-apiserver $server"
  for ((i = 1; i <= attempts; i++)); do
    if kubectl --request-timeout="$timeout" get --raw=/readyz >/dev/null 2>&1; then
      say "kube-apiserver preflight OK"
      return 0
    fi
    [ "$i" = "$attempts" ] || sleep 2
  done
  say "kube-apiserver readiness evidence for $server"
  kubectl --request-timeout="$timeout" get --raw='/readyz?verbose' || true
  k8s_control_plane_failure_diagnostics
  die "kube-apiserver $server is not ready; deployment stopped before further build/apply work"
  return 1
}
