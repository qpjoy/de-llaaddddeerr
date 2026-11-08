#!/usr/bin/env bash
set -euo pipefail

# Only the explicit Internal install command enters here. The optional helper
# is socket-activated; installing it never restarts Hub Pods or other services.
install_host_file_reader() (
  local prefix="$1" source="$2"
  local name=mx-insight-file-reader
  local lib="$prefix/usr/local/lib/mx-insight-hub" units="$prefix/etc/systemd/system"
  local socket_dir="$prefix/var/lib/mx-insight-hub/file-reader-socket"
  local pending="$lib/.host-file-reader-restart-pending" i unit probe_status entry
  local sources=("$source/scripts/host-file-reader.py" "$source/deploy/systemd/$name.service" "$source/deploy/systemd/$name.socket")
  local targets=("$lib/host-file-reader.py" "$units/$name.service" "$units/$name.socket")

  /usr/bin/python3 -I "${sources[0]}" --help >/dev/null
  systemd-analyze --man=no verify "${sources[1]}" "${sources[2]}"
  mkdir -p "$units"
  install -d -m 0755 "$lib"
  exec 9>"$lib/.host-file-reader-install.lock"
  flock -x 9
  if [ -L "$socket_dir" ]; then echo 'Host reader socket directory is a symlink.' >&2; return 1; fi
  # The socket mount is dedicated to IPC. Leave unrelated host files alone.
  shopt -s nullglob dotglob
  for entry in "$socket_dir"/*; do
    if [ "$entry" != "$socket_dir/reader.sock" ] || [ -L "$entry" ] || [ ! -S "$entry" ]; then
      echo 'Unexpected entry in the dedicated host reader socket directory.' >&2
      return 1
    fi
  done
  install -d -m 0755 -o "$(id -u)" -g "$(id -g)" "$socket_dir"
  for i in 0 1 2; do
    if ! cmp -s "${sources[i]}" "${targets[i]}"; then
      # Keep this marker until systemd is serving the installed version, even
      # if an earlier installation was interrupted after replacing the files.
      touch "$pending"
      install -m 0644 "${sources[i]}" "${targets[i]}.new"
      mv -f -- "${targets[i]}.new" "${targets[i]}"
    fi
  done

  systemctl daemon-reload
  if [ -f "$pending" ]; then
    # Stop both together so an old daemon cannot retain an obsolete listener.
    # The socket directory stays mounted in running Pods across the replacement.
    systemctl stop "$name.service" "$name.socket"
  fi
  for unit in "$name.service" "$name.socket"; do
    if systemctl is-failed --quiet "$unit"; then systemctl reset-failed "$unit"; fi
  done
  systemctl enable --now "$name.socket"
  systemctl is-active --quiet "$name.socket"
  # Exercise activation and registry startup without opening any data file.
  probe_status="$(curl --disable --silent --show-error --noproxy '*' --max-time 10 \
    --unix-socket "$socket_dir/reader.sock" --output /dev/null --write-out '%{http_code}' \
    --header 'Content-Type: application/json' --data '{}' http://localhost/open)"
  if [ "$probe_status" != 400 ]; then
    printf 'Host file reader activation probe returned HTTP %s; inspect journalctl -u %s.service\n' "$probe_status" "$name" >&2
    return 1
  fi
  rm -f -- "$pending"
  printf '%s\n' '[mx-insight-hub] Host file reader answered on its Unix socket.'
)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$(id -u)" != 0 ]; then
    echo 'Run sudo bash scripts/manage.sh install-host-file-reader on the Internal host.' >&2
    exit 1
  fi
  install_host_file_reader '' "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
