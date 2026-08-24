#!/bin/sh

# Repair MX-H2I split DNS after macOS changes its physical network while the
# launcher and WireGuard tunnel remain running.

set -eu

DOMAINS=${MX_H2I_DNS_DOMAINS:-"mxinfo-inc.cn internal.mx corp.mx h2i.mx"}
LOCAL_EDGE_PORT=${MX_H2I_LOCAL_EDGE_PORT:-2053}
TEST_HOST=${MX_H2I_DNS_TEST_HOST:-h2i.mxinfo-inc.cn}
EXPECTED_TARGETS=${MX_H2I_DNS_EXPECTED_TARGETS:-10.88.88.88}
DYNAMIC_DNS_KEY='State:/Network/Service/com.qpjoy.electron-launcher.domain-proxy/DNS'
CHECK_ONLY=0
REMOVE_LEGACY=0
TEMP_FILE=''

usage() {
  printf '%s\n' \
    'Usage: repair-macos-dns.sh [--check-only] [--remove-legacy-hdo-resolvers]' \
    '' \
    'Environment overrides:' \
    '  MX_H2I_DNS_DOMAINS       Space-separated split-DNS suffixes.' \
    '  MX_H2I_LOCAL_EDGE_PORT   MX-H2I local DNS relay port (default: 2053).' \
    '  MX_H2I_DNS_TEST_HOST     Host used for direct relay verification.' \
    '  MX_H2I_DNS_EXPECTED_TARGETS  Space-separated exact IPv4 targets (default: 10.88.88.88).' \
    '' \
    '--remove-legacy-hdo-resolvers moves only resolver files carrying an HDO' \
    'marker or the legacy 100.88.0.1 DNS address into a /var/tmp backup.'
}

log() {
  printf '[mx-h2i-dns] %s\n' "$*"
}

fail() {
  printf '[mx-h2i-dns] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TEMP_FILE" ] && [ -f "$TEMP_FILE" ]; then
    rm -f "$TEMP_FILE"
  fi
}

trap cleanup EXIT HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-only)
      CHECK_ONLY=1
      ;;
    --remove-legacy-hdo-resolvers)
      REMOVE_LEGACY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

[ "$(uname -s)" = 'Darwin' ] || fail 'this repair script only supports macOS.'
case "$LOCAL_EDGE_PORT" in
  ''|*[!0-9]*) fail "invalid local DNS relay port: $LOCAL_EDGE_PORT" ;;
esac
[ "$LOCAL_EDGE_PORT" -ge 1 ] && [ "$LOCAL_EDGE_PORT" -le 65535 ] \
  || fail "local DNS relay port is out of range: $LOCAL_EDGE_PORT"

for domain in $DOMAINS; do
  case "$domain" in
    ''|*[!A-Za-z0-9.-]*) fail "invalid split-DNS domain: $domain" ;;
  esac
done
case "$TEST_HOST" in
  ''|*[!A-Za-z0-9.-]*) fail "invalid split-DNS test host: $TEST_HOST" ;;
esac
for target in $EXPECTED_TARGETS; do
  printf '%s\n' "$target" | /usr/bin/awk -F. '
    NF != 4 { exit 1 }
    { for (i = 1; i <= 4; i += 1) if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1 }
  ' || fail "invalid expected MX-H2I IPv4 target: $target"
done
[ -n "$EXPECTED_TARGETS" ] || fail 'at least one expected MX-H2I IPv4 target is required.'

# Keep a covered exact V2 service host in the supplemental resolver list. On
# macOS the longer suffix wins over a still-active V1 HDO parent resolver,
# without deleting or rewriting the V1 /etc/resolver file.
test_host_covered=0
test_host_present=0
for domain in $DOMAINS; do
  [ "$TEST_HOST" = "$domain" ] && test_host_present=1
  case "$TEST_HOST" in
    "$domain"|*."$domain") test_host_covered=1 ;;
  esac
done
if [ "$test_host_covered" -eq 1 ] && [ "$test_host_present" -ne 1 ]; then
  DOMAINS="$DOMAINS $TEST_HOST"
fi

command -v dig >/dev/null 2>&1 || fail 'dig is required but was not found.'
command -v scutil >/dev/null 2>&1 || fail 'scutil is required but was not found.'

if [ "$CHECK_ONLY" -ne 1 ] && [ "$(id -u)" -ne 0 ]; then
  log 'administrator authorization is required to refresh macOS DNS caches.'
  if [ "$REMOVE_LEGACY" -eq 1 ]; then
    exec /usr/bin/sudo -- /usr/bin/env \
      "MX_H2I_DNS_DOMAINS=$DOMAINS" \
      "MX_H2I_LOCAL_EDGE_PORT=$LOCAL_EDGE_PORT" \
      "MX_H2I_DNS_TEST_HOST=$TEST_HOST" \
      "MX_H2I_DNS_EXPECTED_TARGETS=$EXPECTED_TARGETS" \
      "$0" --remove-legacy-hdo-resolvers
  fi
  exec /usr/bin/sudo -- /usr/bin/env \
    "MX_H2I_DNS_DOMAINS=$DOMAINS" \
    "MX_H2I_LOCAL_EDGE_PORT=$LOCAL_EDGE_PORT" \
    "MX_H2I_DNS_TEST_HOST=$TEST_HOST" \
    "MX_H2I_DNS_EXPECTED_TARGETS=$EXPECTED_TARGETS" \
    "$0"
fi

addresses_match_expected_targets() {
  addresses=$1
  [ -n "$addresses" ] || return 1
  for address in $addresses; do
    matched=0
    for expected in $EXPECTED_TARGETS; do
      [ "$address" = "$expected" ] && matched=1
    done
    [ "$matched" -eq 1 ] || return 1
  done
}

find_legacy_resolvers() {
  found=0
  for resolver_file in /etc/resolver/*; do
    [ -f "$resolver_file" ] || continue
    resolver_domain=${resolver_file##*/}
    relevant=0
    for domain in $DOMAINS; do
      case "$resolver_domain" in
        "$domain"|*."$domain") relevant=1 ;;
      esac
    done
    if [ "$relevant" -eq 1 ] \
      && /usr/bin/grep -Eiq '100\.88\.0\.1|MX[[:space:]-]*HDO|QPJoy[[:space:]-]*HDO|electron-plugin-hdo' "$resolver_file"; then
        printf '%s\n' "$resolver_file"
        found=1
    fi
  done
  return "$found"
}

check_local_relay() {
  relay_a=$(/usr/bin/dig +time=1 +tries=1 +noall +comments +answer @127.0.0.1 -p "$LOCAL_EDGE_PORT" "$TEST_HOST" A 2>/dev/null || true)
  relay_aaaa=$(/usr/bin/dig +time=1 +tries=1 +noall +comments +answer @127.0.0.1 -p "$LOCAL_EDGE_PORT" "$TEST_HOST" AAAA 2>/dev/null || true)

  printf '%s\n' "$relay_a" | /usr/bin/grep -Eq 'status:[[:space:]]+NOERROR' \
    || fail "the MX-H2I relay at 127.0.0.1:$LOCAL_EDGE_PORT did not return NOERROR for the A query. Start or reconnect MX-H2I first."
  printf '%s\n' "$relay_a" | /usr/bin/grep -Eq '[[:space:]]IN[[:space:]]+A[[:space:]]' \
    || fail "the MX-H2I relay at 127.0.0.1:$LOCAL_EDGE_PORT did not return an A record for $TEST_HOST. Start or reconnect MX-H2I first."
  relay_ipv4=$(printf '%s\n' "$relay_a" \
    | /usr/bin/awk '$0 ~ /[[:space:]]IN[[:space:]]+A[[:space:]]/ { print $NF }')
  addresses_match_expected_targets "$relay_ipv4" \
    || fail "the MX-H2I relay returned an unexpected product target for $TEST_HOST: $(printf '%s' "$relay_ipv4" | /usr/bin/tr '\n' ' ')"

  printf '%s\n' "$relay_aaaa" | /usr/bin/grep -Eq 'status:[[:space:]]+NOERROR' \
    || fail "the local relay did not return NOERROR/NODATA for the AAAA query to $TEST_HOST."
  if printf '%s\n' "$relay_aaaa" | /usr/bin/grep -Eq '[[:space:]]IN[[:space:]]+A[[:space:]]'; then
    fail "the local relay returned an A record to an AAAA query. Install a build containing the MX-H2I A/AAAA relay fix, then run this script again."
  fi

  log "local relay protocol check passed for $TEST_HOST (A and AAAA)."
}

check_system_resolver() {
  attempt=1
  system_ipv4=''
  while [ "$attempt" -le 3 ]; do
    system_lookup=$(/usr/bin/dscacheutil -q host -a name "$TEST_HOST" 2>/dev/null || true)
    system_ipv4=$(printf '%s\n' "$system_lookup" \
      | /usr/bin/awk '$1 == "ip_address:" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print $2 }')
    if addresses_match_expected_targets "$system_ipv4"; then
      log "macOS system resolver check passed for $TEST_HOST: $(printf '%s' "$system_ipv4" | /usr/bin/tr '\n' ' ')"
      return
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le 3 ] && /bin/sleep 1
  done
  [ -n "$system_ipv4" ] \
    || fail "the macOS system resolver did not return an IPv4 address for $TEST_HOST."
  fail "the macOS system resolver returned an unexpected MX-H2I target for $TEST_HOST: $(printf '%s' "$system_ipv4" | /usr/bin/tr '\n' ' ')"
}

legacy_resolvers=$(find_legacy_resolvers || true)
if [ -n "$legacy_resolvers" ]; then
  log 'legacy HDO resolver files detected:'
  printf '%s\n' "$legacy_resolvers"
  if [ "$REMOVE_LEGACY" -ne 1 ]; then
    log 'they were left unchanged; disconnect HDO and rerun with --remove-legacy-hdo-resolvers if MX-H2I should own these domains.'
  fi
fi

check_local_relay

if [ "$CHECK_ONLY" -eq 1 ]; then
  check_system_resolver
  log 'check-only mode completed; no system state was changed.'
  exit 0
fi

if [ -n "$legacy_resolvers" ] && [ "$REMOVE_LEGACY" -eq 1 ]; then
  backup_dir="/var/tmp/mx-h2i-dns-repair-$(date '+%Y%m%d-%H%M%S')"
  /bin/mkdir -p "$backup_dir"
  printf '%s\n' "$legacy_resolvers" | while IFS= read -r resolver_file; do
    [ -n "$resolver_file" ] || continue
    /bin/mv "$resolver_file" "$backup_dir/"
  done
  log "legacy HDO resolver files were moved to $backup_dir"
fi

TEMP_FILE=$(/usr/bin/mktemp -t mx-h2i-dns.XXXXXX)
{
  printf '%s\n' 'd.init'
  printf '%s\n' 'd.add ServerAddresses * 127.0.0.1'
  printf 'd.add ServerPort # %s\n' "$LOCAL_EDGE_PORT"
  printf 'd.add SupplementalMatchDomains *'
  for domain in $DOMAINS; do
    printf ' %s' "$domain"
  done
  printf '\n'
  printf 'd.add SupplementalMatchOrders *'
  match_order=50
  for domain in $DOMAINS; do
    printf ' %s' "$match_order"
    match_order=$((match_order + 1))
  done
  printf '\n'
  printf '%s\n' 'd.add SupplementalMatchDomainsNoSearch # 1'
  printf 'set %s\n' "$DYNAMIC_DNS_KEY"
  printf '%s\n' 'quit'
} > "$TEMP_FILE"

/usr/sbin/scutil < "$TEMP_FILE"
/usr/bin/dscacheutil -flushcache
/usr/bin/killall -HUP mDNSResponder >/dev/null 2>&1 || true
log "reapplied dynamic split DNS to 127.0.0.1:$LOCAL_EDGE_PORT and flushed macOS DNS caches."

check_local_relay
check_system_resolver

dynamic_state=$(printf 'show %s\nquit\n' "$DYNAMIC_DNS_KEY" | /usr/sbin/scutil 2>/dev/null || true)
if ! printf '%s\n' "$dynamic_state" | /usr/bin/grep -Eq "ServerPort[[:space:]]*:[[:space:]]*$LOCAL_EDGE_PORT"; then
  fail 'macOS did not report the expected split-DNS resolver port after repair.'
fi
if ! printf '%s\n' "$dynamic_state" | /usr/bin/grep -Fq '127.0.0.1'; then
  fail 'macOS did not report 127.0.0.1 as the dynamic split-DNS resolver.'
fi
for domain in $DOMAINS; do
  printf '%s\n' "$dynamic_state" | /usr/bin/grep -Fq "$domain" \
    || fail "macOS dynamic split DNS is missing domain: $domain"
done

log 'repair completed. Retry the affected HTTP URL; if HTTPS is forced, check the gateway TLS/vhost separately.'
