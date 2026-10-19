#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "k8s" ]]; then
  shift
  case "${1:-}" in
    -h|--help)
      cat <<'HELP'
mx-move k8s — Internal Kubernetes 存储迁移（保留 Docker 数据与现有 etcd）
  inventory / plan [--measure]           只读盘点与容量草案
  runtime-check                         只读运行时检查
  prepare-runtime                       预备隔离配置和镜像归档
  install-runtime --prepared <目录>     安装候选运行时；不切换 kubelet/数据库
  cutover-check                         正式切换前只读核验；不停止业务
  prepare-check                         验证私有备份准备；不停止业务或切换服务
  migrate                               维护窗口：停写、冷复制、切换和验收
  status                                读取最近事务摘要
  resume                                提交前恢复原副本；提交后向前恢复
  resume --repair-rig-init              修复已确认的 Rig 初始化权限故障，再恢复原服务
  verify                                只读核验已提交的新副本

示例（mx-base 目录）：bash mx-move/scripts/manage.sh k8s cutover-check
每个子命令可加 --help。migrate/resume 会改变服务；verify 不代替用户登录/联网验收。
HELP
      exit 0
      ;;
    cutover-check|prepare-check|migrate|status|resume|verify)
      exec python3 -B "$SCRIPT_DIR/../k8s/cutover.py" "$@"
      ;;
  esac
  if [[ "${1:-}" == "runtime-check" ]]; then
    shift
    exec python3 -B "$SCRIPT_DIR/../k8s/runtime_check.py" "$@"
  fi
  if [[ "${1:-}" == "prepare-runtime" ]]; then
    shift
    exec python3 -B "$SCRIPT_DIR/../k8s/runtime_prepare.py" "$@"
  fi
  if [[ "${1:-}" == "install-runtime" ]]; then
    shift
    exec python3 -B "$SCRIPT_DIR/../k8s/runtime_install.py" "$@"
  fi
  exec python3 -B "$SCRIPT_DIR/../k8s/inventory.py" "$@"
fi
exec python3 "$SCRIPT_DIR/../etcd/move.py" "$@"
