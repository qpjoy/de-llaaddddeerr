# WireGuard qp-tunnel-cli

```bash
# AWS/Oversea server. The Elastic IP is the public endpoint; it does not need
# to appear on an EC2 network interface.

# 预检网关是否可用
sudo qp-tunnel-cli wg preflight --server --subnet 100.127.50.0/24
# 设置ip和端口
sudo qp-tunnel-cli wg install \
  --instance mx \
  --host 18.181.103.67 \
  --subnet 100.127.50.0/24 \
  --port 45000
# 生产客户端文件
qp-tunnel-cli wg create jp-04 \
  --instance mx --ip 100.127.50.4

# linux客户端，执行
qp-tunnel-cli wg enroll \
  --instance mx --file jp-04.conf --force

# 查看状态
qp-tunnel-cli wg status --server --instance mx

sudo qp-tunnel-cli wg install \
  --host <AWS_ELASTIC_IP> \
  --subnet 100.127.50.0/24 \
  --dns '1.1.1.1, 8.8.8.8' \
  --port-range 20000-20100

# Open UDP 20000-20100 in the AWS security group before using rotation.
sudo qp-tunnel-cli wg create internal-01 --ip 100.127.50.10

# Copy internal-01.conf to the spoke/internal server, then enroll it.
sudo qp-tunnel-cli wg enroll --file internal-01.conf
qp-tunnel-cli wg status

# Rotate to the next free port in the configured range. Without a range the
# current UDP port is incremented by one. No keys are changed.
sudo qp-tunnel-cli wg rotate-port
# On the server, export the refreshed profile and transfer it to the spoke.
sudo cp /etc/qp-wireguard/server/mx/clients/internal-01.conf ./internal-01.conf
# On the spoke:
sudo qp-tunnel-cli wg enroll --file internal-01.conf --force

# Or manually edit Endpoint in /etc/wireguard/qpwgc-mx.conf, then:
sudo qp-tunnel-cli wg restart --client

# Or select a specific port.
sudo qp-tunnel-cli wg rotate-port --port 20050

# Multiple independent servers on one host use different instances and /24s.
sudo qp-tunnel-cli wg install \
  --instance jp01 \
  --host <AWS_ELASTIC_IP> \
  --subnet 100.127.100.0/24 \
  --port-range 20100-20200

qp-tunnel-cli wg list --instance mx
qp-tunnel-cli wg revoke internal-01 --instance mx
qp-tunnel-cli wg restart --instance mx
qp-tunnel-cli wg logs --instance mx
```

`100.128.0.0/16` is not a private/shared block. RFC 6598 ends at
`100.127.255.255`, so the CLI rejects `100.128.*`. The default
`100.127.50.0/24` avoids OpenVPN's current `100.127.0.0/24`; another recommended
starting point is `100.127.100.0/24`. Preflight also checks active routes and
the subnets recorded by managed OpenVPN and WireGuard instances.

WireGuard profiles default to `DNS = 1.1.1.1, 8.8.8.8` and
`AllowedIPs = 0.0.0.0/0, ::/0`. `--dns` on `wg install` changes the default;
`--dns` on `wg create` overrides one client. The server enables IPv4 forwarding
and NAT, so client IPv4 traffic exits through it. The managed server is
currently IPv4-only; `::/0` blocks native IPv6 bypass rather than providing
IPv6 egress. Linux enrollment installs the `resolvconf` helper needed by
`wg-quick` to apply DNS.

## `wg create` reports `fopen: Permission denied` as root

On hosts with the standard [AppArmor `wg` profile](https://gitlab.com/apparmor/apparmor/-/raw/master/profiles/apparmor.d/wg),
`wg` may read key files under `/etc/wireguard`, but not under
`/etc/qp-wireguard`. Older CLI versions put the temporary pre-shared key in
the latter directory. The live `wg set ... preshared-key FILE` operation can
therefore fail even when the caller is root. The fix keeps that temporary key
under `/etc/wireguard` with mode `0600` and removes it after use. This does not
require weakening AppArmor or file permissions.

Confirm the denial and whether the failed attempt saved a profile. These
commands do not display private keys:

```bash
command -v wg
wg --version
sudo journalctl -k --since '-15 min' --no-pager |
  grep -E 'apparmor="DENIED".*(profile="wg"|comm="wg")' || true
sudo stat -c '%a %U %n' /etc/qp-wireguard/server/us01/clients/us0105.conf
```

The old implementation saved the server peer and client profile before the
live update. A failed creation may therefore leave an existing profile while
`./us0105.conf` was never exported. Do not revoke/recreate it or restart the
server to repair this: preserve its original keys. If the saved profile exists,
the following recovery runs as root on the server, validates it against the
unique saved peer block, and applies only that peer. Run it without concurrent
peer creation/revocation. It refuses to overwrite an existing export; if the
destination already exists, choose another unused output filename.

```bash
sudo bash <<'BASH'
(
  set +x
  set -euo pipefail
  umask 077
  instance=us01
  name=us0105
  client_ip=100.127.100.5
  dev="qpwgs-$instance"
  server="/etc/wireguard/$dev.conf"
  profile="/etc/qp-wireguard/server/$instance/clients/$name.conf"
  output="$PWD/$name.conf"
  fail() { printf 'Recovery stopped: %s\n' "$1" >&2; exit 1; }
  [[ -f "$server" && -f "$profile" && ! -L "$profile" ]] || fail 'Saved configuration/profile missing or unsafe.'
  [[ ! -e "$output" && ! -L "$output" ]] || fail 'Export already exists; choose an unused output path.'

  # Extract exactly one complete named block, without printing its contents.
  block=$(awk -v begin="# BEGIN_QP_WG_PEER $name" -v end="# END_QP_WG_PEER $name" '
    $0 == begin { starts++; inside = 1; next }
    $0 == end { if (!inside) bad = 1; ends++; inside = 0; next }
    inside { text = text $0 "\n" }
    END {
      if (bad || inside || starts != 1 || ends != 1) exit 1
      printf "%s", text
    }
  ' "$server") || fail 'Expected exactly one complete saved peer block.'
  value() {
    awk -v prefix="$1" '
      index($0, prefix) == 1 { count++; result = substr($0, length(prefix) + 1) }
      END { if (count != 1 || result == "") exit 1; print result }
    '
  }
  [[ "$(value '# qp-wg-instance: ' < "$profile")" == "$instance" &&
     "$(value '# qp-wg-client-name: ' < "$profile")" == "$name" &&
     "$(value '# qp-wg-client-ip: ' < "$profile")" == "$client_ip" ]] || fail 'Profile metadata does not match the requested peer.'
  address=$(value 'Address = ' < "$profile") || fail 'Missing or duplicate profile address.'
  [[ "${address%/*}" == "$client_ip" &&
     "$(value 'AllowedIPs = ' <<< "$block")" == "$client_ip/32" ]] || fail 'Saved peer/profile IP mismatch.'
  public_key=$(value 'PrivateKey = ' < "$profile" | wg pubkey) || fail 'Cannot derive the saved client public key.'
  [[ "$public_key" == "$(value 'PublicKey = ' <<< "$block")" ]] || fail 'Client public key does not match the saved server peer.'
  psk=$(value 'PresharedKey = ' < "$profile") || fail 'Missing or duplicate saved pre-shared key.'
  [[ "$psk" =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]] || fail 'Saved pre-shared key is not a valid base64 WireGuard key.'
  [[ "$psk" == "$(value 'PresharedKey = ' <<< "$block")" ]] || fail 'Saved pre-shared keys do not match.'
  [[ "$(grep -Fxc "PublicKey = $public_key" "$server")" == 1 &&
     "$(grep -Fxc "AllowedIPs = $client_ip/32" "$server")" == 1 ]] || fail 'Public key or IP is duplicated in the server configuration.'
  wg show "$dev" >/dev/null || fail 'Selected interface is not running; no lifecycle action was taken.'

  tmp_psk=$(mktemp "/etc/wireguard/.$dev.psk.XXXXXX")
  trap 'rm -f -- "$tmp_psk"' EXIT
  chmod 0600 "$tmp_psk"
  printf '%s\n' "$psk" > "$tmp_psk"
  wg set "$dev" peer "$public_key" preshared-key "$tmp_psk" allowed-ips "$client_ip/32"
  set -o noclobber
  cat "$profile" > "$output"
  chmod 0600 "$output"
  printf 'Recovered %s on %s; exported %s\n' "$name" "$dev" "$output"
)
BASH
```

This repairs the local peer installation and exports the existing client
profile. It does not establish that the remote client has enrolled or completed
a handshake. If no profile was saved, use the fixed CLI to create the peer
normally instead of running this recovery.

## Lifecycle and port rotation

Use `qp-tunnel-cli wg` consistently for managed instances. The repository script
with a command (for example `bash scripts/wireguard.sh install ...`) uses the
same managed implementation, but invoking it without arguments opens the legacy
`wg0` installer. Do not use that legacy removal menu to remove CLI instances:
its package/directory cleanup can affect other installed tunnels.

`rotate-port` retains server/client keys, peer authorization and tunnel addresses.
It checks explicit port availability and the active listener against saved state,
opens and verifies the new local firewall rule, verifies the new listener, saves
profiles, then removes the old rule. Failure attempts to restore the old port,
firewall access and saved files. If rollback fails, the error names a private
recovery directory; retain it until the instance has been repaired. A stopped
interface remains stopped, with an explicit configuration-only warning.
This is not crash-proof against power loss or SIGKILL. Run lifecycle operations
serially; do not edit configuration or issue/revoke peers during rotation.

A successful rotation verifies local configuration, not Internet reachability.
Cloud security groups/upstream UDP forwarding must allow the new port. Update
every remote client's Endpoint and reload its tunnel. Server-side exported
profiles are updated automatically; already copied profiles are not. Check a
fresh handshake and traffic from the actual client network before declaring
connectivity restored. Changing ports does not require changing the subnet.

```bash
sudo qp-tunnel-cli wg uninstall --server --instance mx
# On the corresponding client, only when you also want to remove it:
sudo qp-tunnel-cli wg uninstall --client --instance mx
```

Uninstall stops the selected instance and verifies its interface is gone. If a
manually started interface survives the service stop, it tries `wg-quick down`
using the retained configuration. Server firewall cleanup is checked before
configuration is deleted. Stop/cleanup errors preserve the configuration and
report failure instead of silently discarding recovery information. Unrelated
interfaces, routes, OpenVPN instances and WireGuard packages are not removed.
Removing the sysctl file does not globally disable live IP forwarding: other
services may still require it.

## Client-to-client connectivity

Generated clients have only the server as a peer. The topology is hub-and-spoke:
client A -> server -> client B, not a direct peer mesh. The server authorizes each
client's tunnel IPv4 /32 and enables forwarding; current generated rules allow
forwarding from the tunnel interface. Clients can therefore normally reach each
other's tunnel IPv4 addresses, subject to host firewalls and any additional
server firewall policy. There is no default client isolation. Firewalld/nftables
policies may impose additional restrictions even when direct ACCEPT rules exist.

For example, if A is `100.127.50.10` and B is `100.127.50.11`, test ping or an
allowed TCP service at B's tunnel address from A. The service must listen on B's
tunnel address or an appropriate wildcard address, not only `127.0.0.1`.
Both clients depend on server availability and bandwidth. This does not provide
broadcast LAN discovery or automatic direct peer connections. No peer or
forwarding permissions are changed by the lifecycle hardening.
