#!/usr/bin/env bash
confirm_deploy() {
  local answer=''
  printf '\n[mx-base] 将部署 %s，并按当前配置更新本服务；可重复执行。\n' "$1" >&2
  printf 'Docker 部署没有滚动发布保障，替换期间会中断请求；OCR 内存任务可能丢失。\n模型缓存、持久数据和凭据保留；不会终止其他服务或归属不明的 GPU 进程。\n' >&2
  printf '输入 yes 继续，其他输入或 EOF 取消: ' >&2
  if ! IFS= read -r answer || [ "$answer" != yes ]; then
    printf '\n[mx-base] 已取消；没有执行部署。\n' >&2
    return 1
  fi
}
