#!/usr/bin/env bash
#
# 持续下载 podcast_rss 中文音频
# 用法：
#   bash download_zh_podcast.sh
#   WORKERS=30 LIMIT=500 bash download_zh_podcast.sh
#   FORMAT=original bash download_zh_podcast.sh   # 保留原始格式，跳过 ffmpeg 转 opus
#
set -euo pipefail

cd "$(dirname "$0")"

SOURCE="${SOURCE:-podcast_rss}"
LANGUAGE="${LANGUAGE:-zh}"
WORKERS="${WORKERS:-10}"
LIMIT="${LIMIT:-1000}"
INTERVAL="${INTERVAL:-0}"
FORMAT="${FORMAT:-opus}"   # opus | original

if [[ "$FORMAT" != "opus" && "$FORMAT" != "original" ]]; then
  echo "错误: FORMAT 只能是 opus 或 original，当前值: $FORMAT" >&2
  exit 1
fi

echo "[$(date '+%F %T')] 启动持续下载"
echo "  source=$SOURCE language=$LANGUAGE workers=$WORKERS limit=$LIMIT interval=$INTERVAL format=$FORMAT"

exec python main.py \
  --source "$SOURCE" \
  --language "$LANGUAGE" \
  --loop \
  --workers "$WORKERS" \
  --limit "$LIMIT" \
  --interval "$INTERVAL" \
  --format "$FORMAT"
