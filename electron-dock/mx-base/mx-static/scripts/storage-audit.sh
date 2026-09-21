#!/usr/bin/env bash
# Linux metadata-only triage. Never list/stat NAS directories, mount, restart,
# inspect container environments, or calculate Docker/NFS volume sizes.
set -uo pipefail
export LC_ALL=C SYSTEMD_PAGER=cat SYSTEMD_COLORS=0

usage() {
  cat <<'HELP'
Usage: bash scripts/storage-audit.sh [host|docker|all]
  host    Local disks, current NFS mounts, fstab, loaded systemd dependencies,
          matching unit/drop-in lines (including .bak), and recent NFS errors.
  docker  Docker root, container/Compose names and mount mappings (no sizing).
  all     Both reports. Default: host.
Run on the Linux server with permission to read system logs and Docker.
No files or services are changed. Review hostnames/paths before sharing output.
HELP
}

section() { printf '\n### %s\n' "$*"; }
run() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '(not installed: %s)\n' "$1"
    return 0
  fi
  local status=0
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 2s 12s "$@" || status=$?
  else
    "$@" || status=$?
  fi
  if [ "$status" -ne 0 ]; then printf '(exit %s: %s)\n' "$status" "$1"; fi
}

host_report() {
  section 'Host and local capacity'
  run uname -a
  run nproc
  run free -h
  run df -lh
  run df -li
  section 'Current kernel mounts (no traversal of /mnt/nas)'
  run findmnt -rn -t nfs,nfs4,autofs -o TARGET,SOURCE,FSTYPE,OPTIONS
  section 'fstab entries, including commented entries'
  run grep -nE 'nas-storage|/mnt/nas' /etc/fstab
  section 'systemd manager currently loaded configuration'
  run systemctl show docker.service mnt-nas.mount mnt-nas.automount \
    -p Id -p LoadState -p ActiveState -p SubState -p NeedDaemonReload \
    -p FragmentPath -p DropInPaths -p Requires -p Wants -p After -p RequiresMountsFor
  section 'Relevant files on disk; .conf.bak is not an active drop-in'
  # Lowercase -r does not follow symlinks discovered during recursion.
  run grep -rnsE 'nas-storage|/mnt/nas|mnt-nas\.(mount|automount)|RequiresMountsFor' \
    /etc/systemd/system /run/systemd/system /run/systemd/generator \
    /run/systemd/generator.early /run/systemd/generator.late
  section 'NFS mount parameters and client counters'
  run nfsstat -m
  run nfsstat -c
  section 'Tasks in uninterruptible sleep (D state)'
  ps -eo pid,ppid,stat,wchan:32,comm | awk 'NR == 1 || $3 ~ /^D/'
  section 'Recent kernel NFS/RPC messages (last 6 hours, at most 60 lines)'
  run journalctl -k -b --since '-6 hours' -n 1500 --no-pager -o short-iso |
    grep -Ei 'nfs|rpc|not responding|blocked for more than' | tail -n 60 || true
}

docker_report() {
  section 'Docker context and storage root'
  run docker context show
  run docker info --format 'DockerRootDir={{.DockerRootDir}} StorageDriver={{.Driver}}'
  section 'Containers and Compose projects (includes stopped containers)'
  run docker ps -a --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}'
  section 'Container mount mappings and restart policy; no environment/secrets'
  local ids
  ids=$(run docker ps -aq)
  while IFS= read -r container; do
    [[ "$container" =~ ^[0-9a-f]{12,64}$ ]] || continue
    run docker inspect --format 'name={{.Name}} restart={{.HostConfig.RestartPolicy.Name}} compose_files={{index .Config.Labels "com.docker.compose.project.config_files"}}{{range .Mounts}}{{printf "\n  type=%s name=%s source=%s target=%s rw=%t" .Type .Name .Source .Destination .RW}}{{end}}' "$container"
  done <<< "$ids"
  section 'Volume names and drivers (no traversal)'
  run docker volume ls
  printf '\nSize scans are intentionally separate; see docs/storage-migration.md.\n'
}

case "${1:-host}" in
  -h|--help|help) usage; exit 0 ;;
  host|docker|all) mode=${1:-host} ;;
  *) usage >&2; exit 2 ;;
esac
if [ "$(uname -s)" != Linux ]; then
  printf 'Run this report on the Linux Docker host, not the local workstation.\n' >&2
  exit 1
fi
case "$mode" in host|all) host_report ;; esac
case "$mode" in docker|all) docker_report ;; esac
