#!/usr/bin/env bash
# Repair only one Internal-managed SSH connection; never deploy or restart services.
set +x
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash scripts/k8s-ssh-repair.sh [repair|refresh] SHA256:fingerprint
       bash scripts/k8s-ssh-repair.sh public-key|install-password|verify

Get the fingerprint from the replacement server's trusted console first:
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256

repair refreshes the pinned key, verifies public-key login, and asks for the new
server password only after Permission denied. Enter an empty password to print
the existing public key for installation through the server console instead.
install-password reads the password without echo on a terminal, or one line from
stdin when explicitly piped. Passwords are never passed in arguments or env vars.

Defaults (override with these environment variables):
  MX_SSH_NAMESPACE=mx-internal-shadow  MX_SSH_DEPLOYMENT=mx-launcher-internal
  MX_SSH_SITE_ID=mx-oversea-us01       MX_SSH_HOST=34.218.136.162
  MX_SSH_USER=root                    MX_SSH_PORT=22
  MX_SSH_KEY_DIR=/app/artifacts/ssh
Uses the current kubectl context and container internal-api. Only the dedicated
known_hosts.<site> file is replaced; private keys and SSH profiles stay unchanged.
USAGE
}

die() { printf '%s\n' "$*" >&2; exit 1; }
action="${1:-}"
case "$action" in
  -h|--help|help) usage; exit 0 ;;
  repair|refresh) [ "$#" -eq 2 ] || { usage >&2; exit 2; } ;;
  public-key|install-password|verify) [ "$#" -eq 1 ] || { usage >&2; exit 2; } ;;
  *) usage >&2; exit 2 ;;
esac

namespace="${MX_SSH_NAMESPACE:-mx-internal-shadow}"
deployment="${MX_SSH_DEPLOYMENT:-mx-launcher-internal}"
site="${MX_SSH_SITE_ID:-mx-oversea-us01}"
host="${MX_SSH_HOST:-34.218.136.162}"
ssh_user="${MX_SSH_USER:-root}"
port="${MX_SSH_PORT:-22}"
key_dir="${MX_SSH_KEY_DIR:-/app/artifacts/ssh}"
fingerprint="${2:-}"
[[ "$namespace" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || die 'Invalid namespace'
[[ "$deployment" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || die 'Invalid deployment'
[[ "$site" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ ]] || die 'Invalid site ID'
[[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]] || die 'Invalid SSH host'
[[ "$ssh_user" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || die 'Invalid SSH user'
[[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port > 0 && 10#$port < 65536 )) || die 'Invalid SSH port'
port="$((10#$port))"
[[ "$key_dir" == /* && "$key_dir" != *$'\n'* ]] || die 'SSH key directory must be an absolute path'
if [[ "$action" == repair || "$action" == refresh ]]; then
  [[ "$fingerprint" =~ ^SHA256:[a-zA-Z0-9+/]{43}$ ]] || die 'Supply the SHA256 fingerprint from the replacement server console'
fi
command -v kubectl >/dev/null || die 'kubectl is required'

IFS= read -r -d '' remote_script <<'REMOTE' || true
set +x
set -euo pipefail
action="$1"; site="$2"; host="$3"; ssh_user="$4"; port="$5"; key_dir="$6"; expected="$7"
identity="$key_dir/${site}_rsa"
known_hosts="$key_dir/known_hosts.$site"
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ -d "$key_dir" && ! -L "$key_dir" ]] || die 'Managed SSH directory is missing or is a symlink'
[[ -f "$identity" && ! -L "$identity" ]] || die "Existing private key is missing or is a symlink: $identity; stop instead of generating a new key"
[[ ! -L "$known_hosts" ]] || die 'Refusing to replace a symlinked known_hosts file'

check_dedicated_file() {
  [[ ! -e "$known_hosts" || -f "$known_hosts" ]] || die 'known_hosts is not a regular file'
  if [[ -s "$known_hosts" ]]; then
    awk -v host="$host" -v alias="$site" -v port="$port" '
      /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
      {
        count = split($1, names, ",")
        for (i = 1; i <= count; i++) {
          if (names[i] != host && names[i] != "[" host "]:" port &&
              names[i] != alias && names[i] != "[" alias "]:" port) exit 1
        }
        if (NF < 3) exit 1
      }
    ' "$known_hosts" || die 'Refusing to overwrite shared, hashed, or unexpected known_hosts entries; use this site dedicated file only'
  fi
}

ssh_options=(
  -F /dev/null -i "$identity" -p "$port"
  -o "UserKnownHostsFile=$known_hosts" -o GlobalKnownHostsFile=/dev/null
  -o "HostKeyAlias=$site" -o CheckHostIP=no -o StrictHostKeyChecking=yes
  -o IdentitiesOnly=yes -o IdentityAgent=none -o UpdateHostKeys=no
  -o ProxyCommand=none -o ProxyJump=none -o ControlMaster=no -o ControlPath=none
  -o ConnectTimeout=10 -o ConnectionAttempts=1
)
verify() {
  [[ -s "$known_hosts" ]] || die 'No pinned host key; run refresh with a trusted fingerprint first'
  ssh "${ssh_options[@]}" -o BatchMode=yes -o PreferredAuthentications=publickey \
    -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    "$ssh_user@$host" 'printf "mx-ssh-repair-verified\n"; id -un; hostname'
}

case "$action" in
  refresh)
    check_dedicated_file
    scan=$(mktemp "$key_dir/.${site}.scan.XXXXXX")
    candidate=$(mktemp "$key_dir/.${site}.candidate.XXXXXX")
    single_key=$(mktemp "$key_dir/.${site}.key.XXXXXX")
    trap 'rm -f -- "$scan" "$candidate" "$single_key"' EXIT
    ssh-keyscan -T 10 -p "$port" "$host" > "$scan" || die 'Host key scan failed; existing pin was preserved'
    matched=0
    while IFS= read -r line; do
      [[ -n "$line" && "$line" != \#* ]] || continue
      printf '%s\n' "$line" > "$single_key"
      actual=$(ssh-keygen -lf "$single_key" -E sha256 2>/dev/null | awk '{ print $2 }') || continue
      [[ "$actual" == "$expected" ]] || continue
      read -r scanned_host key_type key_data rest <<< "$line"
      host_field="$host"
      [[ "$port" == 22 ]] || host_field="[$host]:$port"
      printf '%s %s %s\n' "$host_field" "$key_type" "$key_data" > "$candidate"
      printf '%s %s %s\n' "$site" "$key_type" "$key_data" >> "$candidate"
      if [[ "$port" != 22 ]]; then
        printf '[%s]:%s %s %s\n' "$site" "$port" "$key_type" "$key_data" >> "$candidate"
      fi
      matched=1
      break
    done < "$scan"
    [[ "$matched" == 1 ]] || die 'Scanned keys do not match the trusted fingerprint; existing pin was preserved'
    chmod 600 "$candidate"
    check_dedicated_file
    if [[ -e "$known_hosts" ]]; then
      backup="${known_hosts}.bak.$(date -u +%Y%m%dT%H%M%SZ).$$"
      cp -p -- "$known_hosts" "$backup"
      chmod 600 "$backup"
      printf 'Previous pin backed up: %s\n' "$backup"
    fi
    mv -f -- "$candidate" "$known_hosts"
    printf 'Pinned %s for %s (%s:%s); private key unchanged\n' "$expected" "$site" "$host" "$port"
    ;;
  public-key)
    ssh-keygen -y -P '' -f "$identity"
    ;;
  verify)
    verify
    ;;
  install-password)
    [[ -s "$known_hosts" ]] || die 'No pinned host key; run refresh with a trusted fingerprint first'
    command -v sshpass >/dev/null || die 'sshpass is not installed in internal-api'
    public_key=$(ssh-keygen -y -P '' -f "$identity")
    # Imported OpenSSH private keys can include a comment; never put it in shell code.
    read -r key_type key_data key_comment <<< "$public_key"
    public_key="$key_type $key_data"
    [[ "$public_key" =~ ^[a-zA-Z0-9@._+-]+\ [a-zA-Z0-9+/=]+$ ]] || die 'Unexpected public-key format'
    install_command="set -eu; umask 077; mkdir -p \"\$HOME/.ssh\"; touch \"\$HOME/.ssh/authorized_keys\"; grep -qxF '$public_key' \"\$HOME/.ssh/authorized_keys\" || printf '%s\\n' '$public_key' >> \"\$HOME/.ssh/authorized_keys\"; chmod 700 \"\$HOME/.ssh\"; chmod 600 \"\$HOME/.ssh/authorized_keys\""
    sshpass -d 0 ssh "${ssh_options[@]}" -o BatchMode=no \
      -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no \
      "$ssh_user@$host" "$install_command"
    verify
    ;;
  *) die 'Invalid remote action' ;;
esac
REMOTE

run_remote() {
  kubectl -n "$namespace" exec -i "deployment/$deployment" -c internal-api -- \
    bash -c "$remote_script" -- "$1" "$site" "$host" "$ssh_user" "$port" "$key_dir" "$fingerprint"
}

install_password() {
  local password=''
  if [[ -t 0 ]]; then
    IFS= read -r -s -p "New server password for $ssh_user@$host (empty: show public key): " password || return 1
    printf '\n' >&2
  else
    IFS= read -r password || return 1
  fi
  if [[ -z "$password" ]]; then
    printf 'Append this public key to %s authorized_keys using the server console, then run verify:\n' "$ssh_user" >&2
    run_remote public-key
    return 3
  fi
  local result=0
  printf '%s\n' "$password" | run_remote install-password || result=$?
  unset password
  return "$result"
}

printf 'SSH recovery target: %s / %s / %s@%s:%s\n' "$namespace" "$site" "$ssh_user" "$host" "$port" >&2
case "$action" in
  repair)
    run_remote refresh
    if output=$(run_remote verify 2>&1); then
      printf '%s\n' "$output"
    else
      printf '%s\n' "$output" >&2
      [[ "$output" == *'Permission denied'* ]] || exit 1
      if [[ -t 0 ]]; then
        install_password
      else
        printf 'Public key is not accepted. Run install-password interactively, or install this public key from the server console and run verify:\n' >&2
        run_remote public-key
        exit 3
      fi
    fi
    ;;
  install-password) install_password ;;
  *) run_remote "$action" ;;
esac
