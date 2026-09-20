#!/usr/bin/env bash
# Read original authentication material from a disposable, isolated etcd copy.
# No changes to Kubernetes, PostgreSQL, host services, mounts or checkpoints.
set -Eeuo pipefail
umask 077
[[ $(id -u) = 0 && $(uname -s) = Linux ]] || { echo '请在原 Linux 服务器以 root 执行。' >&2; exit 1; }
[[ $# = 1 ]] || { echo '用法：bash scripts/inspect-confirmed-mx-auth.sh /data/mx-recovery/confirmed-cutover.XXXXXX' >&2; exit 1; }
for mx_cmd in node docker kubectl flock cp sha256sum find sort xargs systemctl; do
  command -v "$mx_cmd" >/dev/null || { echo "缺少命令：$mx_cmd" >&2; exit 1; }
done
exec 9>/run/mx-launcher-deploy.lock
flock -n 9 || { echo '另一个 deploy/恢复正在运行。' >&2; exit 1; }
export KUBECONFIG=/etc/kubernetes/admin.conf
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy DOCKER_CONTEXT
export DOCKER_HOST=unix:///var/run/docker.sock
mx_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node "$mx_script_dir/inspect-confirmed-mx-auth.mjs" "$1"
