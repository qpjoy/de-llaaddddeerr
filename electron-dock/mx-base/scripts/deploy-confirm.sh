#!/usr/bin/env bash
confirm_deploy() {
  # Explicit machine contract used only after the operations agent validates a plan.
  # This replaces the prompt, never the GPU/storage/ownership checks in the caller.
  local approved_app="${1%%（*}"
  if [ -n "${MX_BASE_DEPLOY_APPROVAL:-}" ]; then
    case "$approved_app" in mx-embedding|mx-ocr) ;; *) printf '该服务不支持计划授权部署。\n' >&2; return 1;; esac
    if [[ "$MX_BASE_DEPLOY_APPROVAL" =~ ^${approved_app}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]]; then
      printf '[mx-base] 使用已确认计划部署 %s；保留全部运行保护。\n' "$approved_app" >&2
      return 0
    fi
    printf '计划授权与当前应用不匹配。\n' >&2
    return 1
  fi
  local answer=''
  printf '\n[mx-base] 将部署 %s，并按当前配置更新本服务；可重复执行。\n' "$1" >&2
  printf 'Docker 部署没有滚动发布保障，替换期间会中断请求；OCR 内存任务可能丢失。\n模型缓存、持久数据和凭据保留；不会终止其他服务或归属不明的 GPU 进程。\n' >&2
  printf '输入 yes 继续，其他输入或 EOF 取消: ' >&2
  if ! IFS= read -r answer || [ "$answer" != yes ]; then
    printf '\n[mx-base] 已取消；没有执行部署。\n' >&2
    return 1
  fi
}
