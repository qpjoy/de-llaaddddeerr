#!/usr/bin/env bash
# Complete the confirmed data cutover by restoring only original authentication.
set -Eeuo pipefail
umask 077
[[ $(id -u) = 0 && $(uname -s) = Linux ]] || { echo '请在原 Linux 服务器以 root 执行。' >&2; exit 1; }
[[ $# = 1 ]] || { echo '用法：bash scripts/restore-confirmed-mx-auth.sh /data/mx-recovery/confirmed-cutover.XXXXXX/auth-inspect.XXXXXX' >&2; exit 1; }
for mx_cmd in node kubectl flock findmnt systemctl; do
  command -v "$mx_cmd" >/dev/null || { echo "缺少命令：$mx_cmd" >&2; exit 1; }
done
exec 9>/run/mx-launcher-deploy.lock
flock -n 9 || { echo '另一个 deploy/恢复正在运行。' >&2; exit 1; }
export KUBECONFIG=/etc/kubernetes/admin.conf
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
mx_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node "$mx_script_dir/restore-confirmed-mx-auth.mjs" "$1"
