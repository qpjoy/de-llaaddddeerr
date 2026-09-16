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
