#!/usr/bin/env bash
# Sourced by manage.sh. Only deploy enables local production recovery.
k8s_production_recovery_state() {
  node "$SCRIPT_DIR/k8s-recovery-state.mjs" "$1" "$(k8s_namespace internal-shadow)" "$K8S_RECOVERY_NODE"
}

k8s_prepare_production_host() {
  [ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] \
    || die "production recovery requires root on the local Linux kubeadm host"
  [ -f /etc/kubernetes/manifests/kube-apiserver.yaml ] \
    || die "existing kubeadm control plane required; deploy will not initialize/reset a cluster"
  # A single host checkpoint / kubelet repair must not race another deploy.
  command -v flock >/dev/null 2>&1 || die "flock is required for serialized production recovery"
  exec 9>/run/mx-launcher-deploy.lock
  flock -n 9 || die "another Internal deploy is running on this host"
  # Use this host's admin configuration; never restore credentials into another context.
  export KUBECONFIG=/etc/kubernetes/admin.conf
  K8S_RECOVERY_NODE="$(k8s_detect_node_name)"
  [ -n "$K8S_RECOVERY_NODE" ] || die "cannot identify original Kubernetes node"
  k8s_production_recovery_state host
  local service
  for service in containerd kubelet docker; do
    if ! systemctl is-active --quiet "$service"; then
      say "start inactive host service: $service"
      timeout 60s systemctl start "$service" || die "cannot start $service; inspect systemctl status $service"
    fi
  done
  k8s_resolve_containerd_address
  K8S_PRODUCTION_RECOVERY=1
}

k8s_resolve_containerd_address() {
  local discovered requested
  discovered="$(node -e '
    const fs = require("fs");
    let endpoint = "";
    // kubeadm instance configuration describes the CRI endpoint for this node.
    for (const file of ["/var/lib/kubelet/config.yaml", "/var/lib/kubelet/instance-config.yaml"]) {
      if (!fs.existsSync(file)) continue;
      const match = fs.readFileSync(file, "utf8").match(/^\s*containerRuntimeEndpoint:\s*["\x27]?([^\s"\x27#]+)/m);
      if (match) endpoint = match[1];
    }
    // Running command-line flags take precedence over files.
    const { spawnSync } = require("child_process");
    const pid = spawnSync("pgrep", ["-xo", "kubelet"], { encoding: "utf8" }).stdout.trim();
    if (pid && fs.existsSync(`/proc/${pid}/cmdline`)) {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--container-runtime-endpoint=")) endpoint = args[i].split("=")[1];
        else if (args[i] === "--container-runtime-endpoint") endpoint = args[i + 1];
      }
    }
    if (!endpoint.startsWith("unix:///")) process.exit(1);
    process.stdout.write(endpoint.slice("unix://".length));
  ')" || die "cannot discover kubelet CRI endpoint; inspect kubelet configuration"
  requested="${MX_K8S_CONTAINERD_ADDRESS:-$discovered}"
  [ "$requested" = "$discovered" ] || die "MX_K8S_CONTAINERD_ADDRESS does not match kubelet CRI endpoint"
  [ -S "$requested" ] || die "kubelet runtime socket is unavailable: $requested"
  MX_K8S_CONTAINERD_ADDRESS="$requested"
  export MX_K8S_CONTAINERD_ADDRESS
  command -v crictl >/dev/null 2>&1 || die "crictl is required to verify kubelet runtime images"
  k8s_ctr version >/dev/null || die "kubelet runtime is not a reachable containerd service"
}

k8s_recover_production_node() {
  node "$SCRIPT_DIR/k8s-kubelet-auth-recovery.mjs" "$K8S_RECOVERY_NODE" "https://$(k8s_detect_lan_ip | head -n 1):6443"
}

k8s_require_production_node_ready() {
  kubectl --request-timeout=130s wait --for=condition=Ready "node/$K8S_RECOVERY_NODE" --timeout=120s \
    || die "node not Ready after network/auth recovery; inspect kubelet and CRI; no containerd restart or cluster reset was attempted"
}

k8s_ctr() {
  ctr --address "${MX_K8S_CONTAINERD_ADDRESS:-/run/containerd/containerd.sock}" -n k8s.io "$@"
}

k8s_verify_cri_image() {
  local image="$1" expected observed attempt
  [ "${K8S_PRODUCTION_RECOVERY:-0}" = 1 ] || return 0
  expected="$(docker image inspect "$image" --format '{{.Id}}')"
  for attempt in 1 2 3 4 5 6; do
    observed="$(k8s_crictl --timeout 10s inspecti "$image" 2>/dev/null | node -e '
      let raw=""; process.stdin.on("data", c=>raw+=c); process.stdin.on("end",()=>{
        try { process.stdout.write(JSON.parse(raw).status.id || ""); } catch { process.exitCode=1; }
      });
    ' || true)"
    if [ "$observed" = "$expected" ]; then
      say "kubelet CRI verified image: $image"
      return 0
    fi
    sleep 2
  done
  df -h "${TMPDIR:-/tmp}" /var/lib/containerd || true
  die "CRI cannot see the imported Docker image: $image; inspect image GC/disk pressure and runtime endpoint; no images or volumes were deleted"
}

k8s_apply_production_postgres() {
  # Render the repository manifest, then add a startup guard only for recovery.
  # The guard stays in the StatefulSet and also protects later reboot starts.
  node "$SCRIPT_DIR/k8s-postgres-recovery.mjs" "$1" "$K8S_RECOVERY_NODE"
}

k8s_production_disk_preflight() {
  local pressure used threshold
  pressure="$(kubectl --request-timeout=15s get node "$K8S_RECOVERY_NODE" -o jsonpath='{.status.conditions[?(@.type=="DiskPressure")].status}')"
  [ "$pressure" = False ] || die "node disk condition is $pressure; recover disk capacity before build (no automatic data cleanup)"
  used="$(df -P /var/lib/containerd | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
  threshold="$(sed -n 's/^[[:space:]]*imageGCHighThresholdPercent:[[:space:]]*\([0-9][0-9]*\).*/\1/p' /var/lib/kubelet/config.yaml | head -n 1)"
  threshold="${threshold:-85}"
  if [ "${used:-100}" -ge "$threshold" ]; then
    say "WARNING: image filesystem ${used}% >= image GC threshold ${threshold}%; imported images may be reclaimed; deploy will verify CRI and retry missing images once"
    df -h /var/lib/containerd "${TMPDIR:-/tmp}"
  fi
}

k8s_reimport_missing_workload_images() {
  [ "${K8S_PRODUCTION_RECOVERY:-0}" = 1 ] || return 1
  local ns="$1" kind="$2" name="$3" images image expected observed repaired=0
  images="$(kubectl --request-timeout=15s -n "$ns" get "$kind/$name" -o jsonpath='{.spec.template.spec.containers[*].image}')" || return 1
  for image in $images; do
    # Only deploy's explicitly managed, locally cached images are eligible.
    case "$image" in
      postgres:16-alpine|qpjoy/mx-launcher-server:shadow|caddy:2.8.4-alpine|coredns/coredns:1.11.3) ;;
      *) continue ;;
    esac
    expected="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" || continue
    observed="$(k8s_crictl --timeout 10s inspecti "$image" 2>/dev/null | node -e '
      let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>{
        try { process.stdout.write(JSON.parse(raw).status.id || ""); } catch { process.exitCode=1; }
      });
    ' || true)"
    [ "$observed" != "$expected" ] || continue
    say "reimport missing/stale CRI image once for $kind/$name: $image"
    # This function is called in a conditional, so failures must be explicit.
    containerd_import_docker_image "$image" || return 1
    repaired=1
  done
  [ "$repaired" = 1 ]
}

k8s_production_auth_smoke() {
  # The Secret is passed through stdin, never argv or logs. Compare against a
  # protected read endpoint in the running Pod; no users or tokens are printed.
  node - "$SCRIPT_DIR" "$(k8s_namespace internal-shadow)" <<'NODE'
(async () => {
  const { pathToFileURL } = require('node:url');
  const { run } = await import(pathToFileURL(`${process.argv[2]}/k8s-recovery-state.mjs`));
  const ns = process.argv[3];
  const secret = JSON.parse(run('kubectl', ['--request-timeout=15s', '-n', ns, 'get', 'secret', 'mx-internal-ops', '-o', 'json']));
  const token = Buffer.from(secret.data.token, 'base64').toString('utf8');
  if (!token) throw new Error();
  run('kubectl', ['--request-timeout=20s', '-n', ns, 'exec', '-i', 'deployment/mx-launcher-internal', '--', 'node', '-e', `
    let token=''; process.stdin.on('data', c=>token+=c); process.stdin.on('end', async()=>{
      try {
        const result = await fetch('http://127.0.0.1:18090/internal/v1/user-center/roles', {
          headers: {'x-mx-ops-token':token}, signal:AbortSignal.timeout(10000)
        });
        await result.body?.cancel();
        if (result.status !== 200) process.exitCode=1;
      } catch { process.exitCode=1; }
    });
  `], token);
  console.log('current Ops Secret accepted by the running Internal API (read-only check)');
})().catch(() => { console.error('Ops authentication check failed; inspect Secret/Pod consistency; no token printed or rotated'); process.exitCode=1; });
NODE
}
