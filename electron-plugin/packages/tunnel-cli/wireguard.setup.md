# WireGuard qp-tunnel-cli

```bash
# AWS/Oversea server. The Elastic IP is the public endpoint; it does not need
# to appear on an EC2 network interface.
sudo qp-tunnel-cli wg preflight --server --subnet 100.127.50.0/24
sudo qp-tunnel-cli wg install \
  --host <AWS_ELASTIC_IP> \
  --subnet 100.127.50.0/24 \
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

WireGuard enrollment installs `AllowedIPs = 0.0.0.0/0`; the server enables IPv4
forwarding and NAT, so client IPv4 traffic exits through the server. The
client's existing DNS resolver is retained.
