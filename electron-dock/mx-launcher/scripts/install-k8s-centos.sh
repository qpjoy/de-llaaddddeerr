#!/usr/bin/env bash
# Bootstrap a single-node kubeadm cluster for the MX-H2I Internal host.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

K8S_VERSION="${K8S_VERSION:-v1.36}"
K8S_IMAGE_REPOSITORY="${K8S_IMAGE_REPOSITORY:-registry.k8s.io}"
K8S_PAUSE_VERSION="${K8S_PAUSE_VERSION:-3.10.2}"
POD_CIDR="${POD_CIDR:-192.168.224.0/20}"
SERVICE_CIDR="${SERVICE_CIDR:-192.168.240.0/20}"
CRI_SOCKET="${CRI_SOCKET:-unix:///run/containerd/containerd.sock}"
K8S_APISERVER_ADVERTISE_ADDRESS="${K8S_APISERVER_ADVERTISE_ADDRESS:-}"
K8S_FLANNEL_URL="${K8S_FLANNEL_URL:-https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml}"
K8S_FLANNEL_IMAGE_REPOSITORY="${K8S_FLANNEL_IMAGE_REPOSITORY:-}"
K8S_FLANNEL_VERSION="${K8S_FLANNEL_VERSION:-v0.28.5}"
K8S_FLANNEL_CNI_PLUGIN_VERSION="${K8S_FLANNEL_CNI_PLUGIN_VERSION:-v1.9.1-flannel1}"
K8S_GATEWAY_PORT="${K8S_GATEWAY_PORT:-18090}"
K8S_OPEN_FIREWALL="${K8S_OPEN_FIREWALL:-1}"
K8S_DISABLE_SWAP="${K8S_DISABLE_SWAP:-1}"
K8S_SET_SELINUX_PERMISSIVE="${K8S_SET_SELINUX_PERMISSIVE:-1}"
K8S_INSTALL_FLANNEL="${K8S_INSTALL_FLANNEL:-1}"
K8S_UNTAINT_CONTROL_PLANE="${K8S_UNTAINT_CONTROL_PLANE:-1}"
K8S_ALLOW_CGROUP_V1="${K8S_ALLOW_CGROUP_V1:-auto}"
K8S_CONFIGURE_KUBELET_EVICTION="${K8S_CONFIGURE_KUBELET_EVICTION:-1}"
K8S_KUBELET_EVICTION_MEMORY_AVAILABLE="${K8S_KUBELET_EVICTION_MEMORY_AVAILABLE:-100Mi}"
K8S_KUBELET_EVICTION_NODEFS_AVAILABLE="${K8S_KUBELET_EVICTION_NODEFS_AVAILABLE:-20Gi}"
K8S_KUBELET_EVICTION_IMAGEFS_AVAILABLE="${K8S_KUBELET_EVICTION_IMAGEFS_AVAILABLE:-20Gi}"
K8S_KUBELET_EVICTION_NODEFS_INODES_FREE="${K8S_KUBELET_EVICTION_NODEFS_INODES_FREE:-1%}"
K8S_KUBELET_EVICTION_IMAGEFS_INODES_FREE="${K8S_KUBELET_EVICTION_IMAGEFS_INODES_FREE:-1%}"
DEPLOY_MX="${DEPLOY_MX:-0}"
DRY_RUN=0
SKIP_INIT=0
MX_ROOT="$ROOT"

say() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install-k8s-centos.sh [options]

Options:
  --advertise-address IP   Internal CentOS LAN IP for kube-apiserver.
  --pod-cidr CIDR          Pod CIDR. Default: 192.168.224.0/20.
  --service-cidr CIDR      Service CIDR. Default: 192.168.240.0/20.
  --k8s-version VERSION    Kubernetes RPM minor repo. Default: v1.36.
  --image-repository REPO  Control-plane image registry. Default: registry.k8s.io.
  --flannel-image-repository REPO
                          Override Flannel images after manifest apply, e.g. docker.io/flannel.
  --skip-init              Install packages/config only; do not run kubeadm init.
  --skip-flannel           Do not install Flannel CNI.
  --skip-firewall          Do not modify firewalld.
  --skip-eviction-tuning   Do not tune kubelet DiskPressure hard eviction thresholds.
  --allow-cgroup-v1        Let kubeadm/kubelet run on cgroups v1 hosts.
  --no-cgroup-v1           Fail instead of applying cgroups v1 compatibility.
  --deploy-mx              After K8s is ready, run ops internal-production deploy.
  --mx-root DIR            mx-launcher root. Default: this script's parent dir.
  --dry-run                Print steps without changing the host.
  -h, --help               Show this help.

Environment:
  PG_PASSWORD=...          Required with --deploy-mx unless existing secret is enough.
  K8S_APISERVER_ADVERTISE_ADDRESS=IP
  K8S_VERSION=v1.36
  K8S_IMAGE_REPOSITORY=registry.aliyuncs.com/google_containers
  K8S_PAUSE_VERSION=3.10.2
  K8S_FLANNEL_IMAGE_REPOSITORY=docker.io/flannel
  K8S_FLANNEL_VERSION=v0.28.5
  K8S_FLANNEL_CNI_PLUGIN_VERSION=v1.9.1-flannel1
  POD_CIDR=192.168.224.0/20
  SERVICE_CIDR=192.168.240.0/20
  K8S_OPEN_FIREWALL=0
  K8S_DISABLE_SWAP=0
  K8S_SET_SELINUX_PERMISSIVE=0
  K8S_INSTALL_FLANNEL=0
  K8S_UNTAINT_CONTROL_PLANE=0
  K8S_ALLOW_CGROUP_V1=auto|1|0
  K8S_CONFIGURE_KUBELET_EVICTION=1
  K8S_KUBELET_EVICTION_MEMORY_AVAILABLE=100Mi
  K8S_KUBELET_EVICTION_NODEFS_AVAILABLE=20Gi
  K8S_KUBELET_EVICTION_IMAGEFS_AVAILABLE=20Gi
  K8S_KUBELET_EVICTION_NODEFS_INODES_FREE=1%
  K8S_KUBELET_EVICTION_IMAGEFS_INODES_FREE=1%
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --advertise-address)
      K8S_APISERVER_ADVERTISE_ADDRESS="${2:-}"
      shift 2
      ;;
    --pod-cidr)
      POD_CIDR="${2:-}"
      shift 2
      ;;
    --service-cidr)
      SERVICE_CIDR="${2:-}"
      shift 2
      ;;
    --k8s-version)
      K8S_VERSION="${2:-}"
      shift 2
      ;;
    --image-repository)
      K8S_IMAGE_REPOSITORY="${2:-}"
      shift 2
      ;;
    --flannel-image-repository)
      K8S_FLANNEL_IMAGE_REPOSITORY="${2:-}"
      shift 2
      ;;
    --skip-init)
      SKIP_INIT=1
      shift
      ;;
    --skip-flannel)
      K8S_INSTALL_FLANNEL=0
      shift
      ;;
    --skip-firewall)
      K8S_OPEN_FIREWALL=0
      shift
      ;;
    --skip-eviction-tuning)
      K8S_CONFIGURE_KUBELET_EVICTION=0
      shift
      ;;
    --allow-cgroup-v1)
      K8S_ALLOW_CGROUP_V1=1
      shift
      ;;
    --no-cgroup-v1)
      K8S_ALLOW_CGROUP_V1=0
      shift
      ;;
    --deploy-mx)
      DEPLOY_MX=1
      shift
      ;;
    --mx-root)
      MX_ROOT="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

run() {
  say "+ $*"
  [ "$DRY_RUN" = "1" ] || "$@"
}

run_allow_fail() {
  say "+ $*"
  [ "$DRY_RUN" = "1" ] && return 0
  "$@" || return 0
}

write_file() {
  local path="$1"
  if [ "$DRY_RUN" = "1" ]; then
    say "would write $path"
    cat >/dev/null
    return 0
  fi
  cat >"$path"
}

backup_file() {
  local path="$1"
  local stamp
  [ -f "$path" ] || return 0
  stamp="$(date +%Y%m%d%H%M%S)"
  run cp -a "$path" "$path.mx-k8s.$stamp.bak"
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    [ "$DRY_RUN" = "1" ] && say "dry-run without root; real install must run as root" && return 0
    die "Run as root on the CentOS Internal host."
  fi
}

detect_rhel_family() {
  if [ ! -f /etc/os-release ]; then
    [ "$DRY_RUN" = "1" ] && say "dry-run: /etc/os-release not available; assuming RHEL-compatible host" && return 0
    die "Cannot find /etc/os-release"
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    centos:*|rhel:*|rocky:*|almalinux:*|ol:*|*:rhel*|*:fedora*)
      say "OS: ${PRETTY_NAME:-$ID}"
      ;;
    *)
      die "This installer targets CentOS/RHEL-compatible hosts. Found: ${PRETTY_NAME:-unknown}"
      ;;
  esac
}

package_manager() {
  if command -v dnf >/dev/null 2>&1; then
    echo dnf
    return
  fi
  if command -v yum >/dev/null 2>&1; then
    echo yum
    return
  fi
  [ "$DRY_RUN" = "1" ] && echo yum && return
  die "dnf or yum is required"
}

auto_advertise_ip() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')"
  [ -n "$ip" ] || die "Cannot auto-detect LAN IP. Re-run with --advertise-address <IP>."
  echo "$ip"
}

resolve_advertise_address() {
  if [ -z "$K8S_APISERVER_ADVERTISE_ADDRESS" ]; then
    K8S_APISERVER_ADVERTISE_ADDRESS="$(auto_advertise_ip)"
  fi
}

using_cgroup_v1() {
  [ "$DRY_RUN" = "1" ] && [ "$K8S_ALLOW_CGROUP_V1" = "1" ] && return 0
  [ -f /sys/fs/cgroup/cgroup.controllers ] && return 1
  [ -f /proc/filesystems ] || return 1
  grep -qw cgroup /proc/filesystems 2>/dev/null
}

k8s_minor_version() {
  printf '%s\n' "$K8S_VERSION" | sed -E 's/^v?1\.([0-9]+).*/\1/'
}

kubeadm_runtime_version() {
  if [ -n "${K8S_KUBERNETES_VERSION:-}" ]; then
    echo "$K8S_KUBERNETES_VERSION"
    return
  fi
  if [ "$DRY_RUN" != "1" ] && command -v kubeadm >/dev/null 2>&1; then
    kubeadm version -o short
    return
  fi
  echo stable-"${K8S_VERSION#v}"
}

needs_cgroup_v1_compat() {
  local minor
  using_cgroup_v1 || return 1
  [ "$K8S_ALLOW_CGROUP_V1" != "0" ] || die "cgroups v1 detected; migrate to cgroups v2 or re-run without --no-cgroup-v1."
  minor="$(k8s_minor_version)"
  [ -n "$minor" ] || return 1
  [ "$minor" -ge 35 ]
}

disable_swap() {
  [ "$K8S_DISABLE_SWAP" = "1" ] || return 0
  say "disable swap for kubelet"
  run swapoff -a
  if [ -f /etc/fstab ] && grep -Eq '^[^#].*[[:space:]]swap[[:space:]]' /etc/fstab; then
    backup_file /etc/fstab
    run sed -i '/^[^#].*[[:space:]]swap[[:space:]]/ s/^/#/' /etc/fstab
  fi
}

configure_kernel_networking() {
  say "configure kernel modules and sysctl"
  write_file /etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
EOF
  run modprobe overlay
  run modprobe br_netfilter
  write_file /etc/sysctl.d/99-kubernetes-cri.conf <<'EOF'
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward = 1
EOF
  run sysctl --system
}

configure_containerd() {
  local pm
  pm="$(package_manager)"
  if ! command -v containerd >/dev/null 2>&1; then
    say "containerd is missing; install containerd.io from configured repositories"
    run "$pm" install -y containerd.io
  fi
  say "configure containerd for Kubernetes CRI"
  run mkdir -p /etc/containerd
  [ ! -f /etc/containerd/config.toml ] || backup_file /etc/containerd/config.toml
  if [ "$DRY_RUN" = "1" ]; then
    say "would generate /etc/containerd/config.toml"
  else
    containerd config default >/etc/containerd/config.toml
  fi
  run sed -i 's/SystemdCgroup = false/SystemdCgroup = true/g' /etc/containerd/config.toml
  run sed -i 's/disabled_plugins = \["cri"\]/disabled_plugins = []/g' /etc/containerd/config.toml
  run sed -i "s#sandbox_image = \".*\"#sandbox_image = \"${K8S_IMAGE_REPOSITORY}/pause:${K8S_PAUSE_VERSION}\"#g" /etc/containerd/config.toml
  run systemctl enable --now containerd
  run systemctl restart containerd
}

configure_hostname_resolution() {
  local node_name
  resolve_advertise_address
  node_name="$(hostname)"
  [ -n "$node_name" ] || return 0
  if command -v getent >/dev/null 2>&1 && getent hosts "$node_name" >/dev/null 2>&1; then
    return 0
  fi
  say "add hostname resolution for $node_name -> $K8S_APISERVER_ADVERTISE_ADDRESS"
  backup_file /etc/hosts
  if [ "$DRY_RUN" = "1" ]; then
    say "would append '$K8S_APISERVER_ADVERTISE_ADDRESS $node_name' to /etc/hosts"
  else
    printf '%s %s\n' "$K8S_APISERVER_ADVERTISE_ADDRESS" "$node_name" >>/etc/hosts
  fi
}

configure_selinux() {
  [ "$K8S_SET_SELINUX_PERMISSIVE" = "1" ] || return 0
  say "set SELinux to permissive for kubeadm"
  run_allow_fail setenforce 0
  if [ -f /etc/selinux/config ]; then
    backup_file /etc/selinux/config
    run sed -i 's/^SELINUX=enforcing$/SELINUX=permissive/' /etc/selinux/config
  fi
}

install_kubernetes_packages() {
  local pm
  pm="$(package_manager)"
  say "configure Kubernetes RPM repository $K8S_VERSION"
  write_file /etc/yum.repos.d/kubernetes.repo <<EOF
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/${K8S_VERSION}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/${K8S_VERSION}/rpm/repodata/repomd.xml.key
exclude=kubelet kubeadm kubectl cri-tools kubernetes-cni
EOF
  say "install kubelet kubeadm kubectl"
  if [ "$DRY_RUN" = "1" ]; then
    say "would install kubelet kubeadm kubectl"
  elif ! "$pm" install -y kubelet kubeadm kubectl --disableexcludes=kubernetes; then
    "$pm" install -y kubelet kubeadm kubectl --setopt=disable_excludes=kubernetes
  fi
  run systemctl enable kubelet
  run_allow_fail systemctl start kubelet
}

kubelet_eviction_hard_arg() {
  printf 'memory.available<%s,nodefs.available<%s,imagefs.available<%s,nodefs.inodesFree<%s,imagefs.inodesFree<%s' \
    "$K8S_KUBELET_EVICTION_MEMORY_AVAILABLE" \
    "$K8S_KUBELET_EVICTION_NODEFS_AVAILABLE" \
    "$K8S_KUBELET_EVICTION_IMAGEFS_AVAILABLE" \
    "$K8S_KUBELET_EVICTION_NODEFS_INODES_FREE" \
    "$K8S_KUBELET_EVICTION_IMAGEFS_INODES_FREE"
}

kubelet_eviction_yaml_block() {
  cat <<EOF
evictionHard:
  memory.available: "${K8S_KUBELET_EVICTION_MEMORY_AVAILABLE}"
  nodefs.available: "${K8S_KUBELET_EVICTION_NODEFS_AVAILABLE}"
  imagefs.available: "${K8S_KUBELET_EVICTION_IMAGEFS_AVAILABLE}"
  nodefs.inodesFree: "${K8S_KUBELET_EVICTION_NODEFS_INODES_FREE}"
  imagefs.inodesFree: "${K8S_KUBELET_EVICTION_IMAGEFS_INODES_FREE}"
EOF
}

systemd_environment_value() {
  printf '%s\n' "$1" | sed 's/%/%%/g'
}

configure_kubelet_config_eviction() {
  local config_path="/var/lib/kubelet/config.yaml"
  local tmp_path
  if [ ! -f "$config_path" ]; then
    say "kubelet config not found yet: $config_path; kubeadm init config will carry eviction thresholds"
    return 0
  fi
  say "write kubelet config evictionHard in $config_path"
  backup_file "$config_path"
  if [ "$DRY_RUN" = "1" ]; then
    kubelet_eviction_yaml_block >/dev/null
    say "would replace or append evictionHard in $config_path"
    return 0
  fi
  tmp_path="${config_path}.mx-eviction.$$"
  awk \
    -v memory="$K8S_KUBELET_EVICTION_MEMORY_AVAILABLE" \
    -v nodefs="$K8S_KUBELET_EVICTION_NODEFS_AVAILABLE" \
    -v imagefs="$K8S_KUBELET_EVICTION_IMAGEFS_AVAILABLE" \
    -v nodefs_inodes="$K8S_KUBELET_EVICTION_NODEFS_INODES_FREE" \
    -v imagefs_inodes="$K8S_KUBELET_EVICTION_IMAGEFS_INODES_FREE" '
      function block() {
        print "evictionHard:"
        print "  memory.available: \"" memory "\""
        print "  nodefs.available: \"" nodefs "\""
        print "  imagefs.available: \"" imagefs "\""
        print "  nodefs.inodesFree: \"" nodefs_inodes "\""
        print "  imagefs.inodesFree: \"" imagefs_inodes "\""
      }
      /^evictionHard:[[:space:]]*$/ {
        block()
        replaced = 1
        skipping = 1
        next
      }
      skipping {
        if ($0 ~ /^[^[:space:]#]/ || $0 ~ /^---[[:space:]]*$/) {
          skipping = 0
        } else {
          next
        }
      }
      { print }
      END {
        if (!replaced) {
          block()
        }
      }
    ' "$config_path" >"$tmp_path"
  mv "$tmp_path" "$config_path"
}

configure_kubelet_eviction() {
  [ "$K8S_CONFIGURE_KUBELET_EVICTION" = "1" ] || return 0
  local eviction_hard systemd_eviction_hard
  eviction_hard="$(kubelet_eviction_hard_arg)"
  systemd_eviction_hard="$(systemd_environment_value "$eviction_hard")"
  say "configure kubelet hard eviction thresholds: $eviction_hard"
  run mkdir -p /etc/systemd/system/kubelet.service.d
  write_file /etc/systemd/system/kubelet.service.d/20-mx-eviction.conf <<EOF
[Service]
Environment="KUBELET_EXTRA_ARGS=--eviction-hard=${systemd_eviction_hard}"
EOF
  configure_kubelet_config_eviction
  run systemctl daemon-reload
  run_allow_fail systemctl restart kubelet
}

configure_kubectl() {
  [ -f /etc/kubernetes/admin.conf ] || return 0
  say "configure root kubectl"
  run mkdir -p "$HOME/.kube"
  if [ "$DRY_RUN" = "1" ]; then
    say "would copy /etc/kubernetes/admin.conf to $HOME/.kube/config"
  else
    cp -f /etc/kubernetes/admin.conf "$HOME/.kube/config"
  fi
  run chown "$(id -u):$(id -g)" "$HOME/.kube/config"
}

kubeadm_init_config() {
  local path="$1"
  local include_cgroup_v1="$2"
  write_file "$path" <<EOF
apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: ${K8S_APISERVER_ADVERTISE_ADDRESS}
nodeRegistration:
  criSocket: ${CRI_SOCKET}
---
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
imageRepository: ${K8S_IMAGE_REPOSITORY}
kubernetesVersion: $(kubeadm_runtime_version)
networking:
  podSubnet: ${POD_CIDR}
  serviceSubnet: ${SERVICE_CIDR}
EOF
  if [ "$include_cgroup_v1" = "1" ] || [ "$K8S_CONFIGURE_KUBELET_EVICTION" = "1" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      say "would append kubelet configuration to $path"
      return 0
    fi
    cat >"$path.kubelet" <<'EOF'
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
EOF
    if [ "$include_cgroup_v1" = "1" ]; then
      cat >>"$path.kubelet" <<'EOF'
cgroupDriver: systemd
failCgroupV1: false
EOF
    fi
    if [ "$K8S_CONFIGURE_KUBELET_EVICTION" = "1" ]; then
      kubelet_eviction_yaml_block >>"$path.kubelet"
    fi
    cat "$path.kubelet" >>"$path"
    rm -f "$path.kubelet"
  fi
}

prepull_kubeadm_images() {
  [ "$SKIP_INIT" = "0" ] || return 0
  [ ! -f /etc/kubernetes/admin.conf ] || return 0
  say "pre-pull Kubernetes control-plane images from $K8S_IMAGE_REPOSITORY"
  run kubeadm config images pull \
    --kubernetes-version "$(kubeadm_runtime_version)" \
    --image-repository "$K8S_IMAGE_REPOSITORY" \
    --cri-socket "$CRI_SOCKET"
}

init_cluster() {
  [ "$SKIP_INIT" = "0" ] || return 0
  if [ -f /etc/kubernetes/admin.conf ]; then
    say "existing kubeadm cluster detected; skip kubeadm init"
    configure_kubectl
    return 0
  fi
  resolve_advertise_address
  say "initialize single-node Kubernetes cluster at $K8S_APISERVER_ADVERTISE_ADDRESS"
  if needs_cgroup_v1_compat; then
    local kubeadm_config="/tmp/mx-kubeadm-init.yaml"
    say "cgroups v1 detected; enabling kubelet failCgroupV1=false compatibility"
    kubeadm_init_config "$kubeadm_config" 1
    run kubeadm init --config "$kubeadm_config" --ignore-preflight-errors=SystemVerification
  elif [ "$K8S_CONFIGURE_KUBELET_EVICTION" = "1" ]; then
    local kubeadm_config="/tmp/mx-kubeadm-init.yaml"
    say "initialize with kubelet eviction thresholds"
    kubeadm_init_config "$kubeadm_config" 0
    run kubeadm init --config "$kubeadm_config"
  else
    run kubeadm init \
      --apiserver-advertise-address="$K8S_APISERVER_ADVERTISE_ADDRESS" \
      --pod-network-cidr="$POD_CIDR" \
      --service-cidr="$SERVICE_CIDR" \
      --cri-socket="$CRI_SOCKET" \
      --image-repository="$K8S_IMAGE_REPOSITORY" \
      --kubernetes-version="$(kubeadm_runtime_version)"
  fi
  configure_kubectl
}

install_flannel() {
  [ "$K8S_INSTALL_FLANNEL" = "1" ] || return 0
  [ "$SKIP_INIT" = "0" ] || return 0
  say "install Flannel CNI"
  run kubectl apply -f "$K8S_FLANNEL_URL"
  configure_flannel_pod_cidr
  if [ -n "$K8S_FLANNEL_IMAGE_REPOSITORY" ]; then
    say "override Flannel images with $K8S_FLANNEL_IMAGE_REPOSITORY"
    run kubectl -n kube-flannel set image daemonset/kube-flannel-ds \
      "install-cni-plugin=${K8S_FLANNEL_IMAGE_REPOSITORY}/flannel-cni-plugin:${K8S_FLANNEL_CNI_PLUGIN_VERSION}" \
      "install-cni=${K8S_FLANNEL_IMAGE_REPOSITORY}/flannel:${K8S_FLANNEL_VERSION}" \
      "kube-flannel=${K8S_FLANNEL_IMAGE_REPOSITORY}/flannel:${K8S_FLANNEL_VERSION}"
  fi
}

configure_flannel_pod_cidr() {
  [ "$K8S_INSTALL_FLANNEL" = "1" ] || return 0
  [ "$SKIP_INIT" = "0" ] || return 0
  local net_conf escaped
  net_conf="{\"Network\":\"${POD_CIDR}\",\"Backend\":{\"Type\":\"vxlan\"}}"
  escaped="$(printf '%s' "$net_conf" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  say "configure Flannel pod CIDR: $POD_CIDR"
  run kubectl -n kube-flannel patch configmap kube-flannel-cfg \
    --type merge \
    -p "{\"data\":{\"net-conf.json\":\"$escaped\"}}"
}

untaint_control_plane() {
  [ "$K8S_UNTAINT_CONTROL_PLANE" = "1" ] || return 0
  [ "$SKIP_INIT" = "0" ] || return 0
  say "allow workloads on single control-plane node"
  run_allow_fail kubectl taint nodes --all node-role.kubernetes.io/control-plane-
}

configure_firewall() {
  [ "$K8S_OPEN_FIREWALL" = "1" ] || return 0
  command -v firewall-cmd >/dev/null 2>&1 || return 0
  if [ "$DRY_RUN" != "1" ] && ! firewall-cmd --state >/dev/null 2>&1; then
    say "firewalld is not running; skip firewall rules"
    return 0
  fi
  say "open firewall ports for Internal gateway and Kubernetes admin"
  run firewall-cmd --permanent --add-port="${K8S_GATEWAY_PORT}/tcp"
  run firewall-cmd --permanent --add-port=6443/tcp
  run firewall-cmd --permanent --add-port=10250/tcp
  run firewall-cmd --permanent --add-port=8472/udp
  run firewall-cmd --permanent --add-masquerade
  run firewall-cmd --reload
}

wait_for_cluster() {
  [ "$SKIP_INIT" = "0" ] || return 0
  say "wait for Flannel rollout"
  run_allow_fail kubectl -n kube-flannel rollout status daemonset/kube-flannel-ds --timeout=300s
  say "wait for node readiness"
  run_allow_fail kubectl wait --for=condition=Ready node --all --timeout=300s
  run kubectl get nodes -o wide
  run kubectl -n kube-system get pods -o wide
}

deploy_mx() {
  [ "$DEPLOY_MX" = "1" ] || return 0
  [ -d "$MX_ROOT" ] || die "mx-launcher root not found: $MX_ROOT"
  [ -f "$MX_ROOT/scripts/manage.sh" ] || die "manage.sh not found under $MX_ROOT"
  [ -n "${PG_PASSWORD:-}" ] || die "PG_PASSWORD is required when using --deploy-mx"
  say "deploy MX-H2I Internal production stack"
  if command -v corepack >/dev/null 2>&1; then
    run corepack enable
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would run pnpm install and ops internal-production deploy in $MX_ROOT"
  else
    command -v pnpm >/dev/null 2>&1 || die "pnpm is required for --deploy-mx"
    (cd "$MX_ROOT" && pnpm install)
    (cd "$MX_ROOT" && bash scripts/manage.sh ops internal-production deploy)
  fi
}

main() {
  require_root
  detect_rhel_family
  say "Kubernetes repo version: $K8S_VERSION"
  say "Kubernetes image repository: $K8S_IMAGE_REPOSITORY"
  say "Pod CIDR: $POD_CIDR"
  say "Service CIDR: $SERVICE_CIDR"
  resolve_advertise_address
  disable_swap
  configure_kernel_networking
  configure_containerd
  configure_hostname_resolution
  configure_selinux
  install_kubernetes_packages
  configure_kubelet_eviction
  configure_firewall
  prepull_kubeadm_images
  init_cluster
  install_flannel
  untaint_control_plane
  wait_for_cluster
  deploy_mx
  say "K8s bootstrap complete"
}

main "$@"
