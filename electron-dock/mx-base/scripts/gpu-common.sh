#!/usr/bin/env bash
# Source after setting BASE_DIR. The lock covers admission through start completion.
gpu_config() {
  if [ -f "$BASE_DIR/.env.gpu" ]; then set -a; source "$BASE_DIR/.env.gpu"; set +a; fi
  export MX_BASE_DISPLAY_GPU="${MX_BASE_DISPLAY_GPU:-3}"
  export MX_BASE_OCR_GPU="${MX_BASE_OCR_GPU:-2}"
  export MX_BASE_EMBEDDING_GPU="${MX_BASE_EMBEDDING_GPU:-1}"
}
gpu_admit() {
  command -v flock >/dev/null || { echo 'GPU 启动需要 Linux flock' >&2; return 1; }
  # Same lock across repository copies, applications and operators on this host.
  exec 9>/var/lock/mx-base-gpu.lock
  flock -n 9 || { echo '另一个 mx-base GPU 操作正在执行，请稍后重试' >&2; return 1; }
  GPU_UUID="$(python3 "$BASE_DIR/scripts/gpu-check.py" "$1")"
  export GPU_UUID
}
