# @qpjoy/tunnel-cli

Global CLI wrapper for the QPJoy Linux `mihomo-client` server script.

```bash
npm i -g @qpjoy/tunnel-cli
qp-tunnel-cli help
```

The package ships the existing `scripts/mihomo-client.sh` file in the npm
tarball. It does not reimplement the Linux systemd, proxy, SSH, daemon, or TUN
orchestration in Node.

## Server Usage

Run commands directly through the bundled script:

```bash
qp-tunnel-cli status
qp-tunnel-cli server-on
qp-tunnel-cli update-subscription
```

For server commands, `qp-tunnel-cli` re-runs itself with `sudo` when root is needed.
Use `server-on` for public VPS hosts: it keeps Mihomo running as a local outbound
proxy and configures shell, SSH, Docker/containerd/buildkit proxy drop-ins without
enabling TUN route takeover. Reserve `tun-on` for machines that are not serving
public inbound traffic.

Run any command through the active Mihomo local proxy:

```bash
qp-tunnel-cli ./electron-server/scripts/manage.sh redeploy
qp-tunnel-cli -- docker compose build
```

For host commands, `HTTP_PROXY` points at `127.0.0.1:<mixed-port>`. For
Docker/Compose build containers, the CLI also injects container-facing variables
such as `MARKET_CONTAINER_HTTP_PROXY` and `QP_TUNNEL_CONTAINER_HTTP_PROXY`
pointing at `host.docker.internal:<mixed-port>`.

Install the bundled script as a normal Linux command:

```bash
sudo qp-tunnel-cli install-script
sudo qp-tunnel-cli upgrade-systemd
sudo mihomo-client status
sudo mihomo-client server-on
```

Use a custom target when needed:

```bash
sudo qp-tunnel-cli install-script --target /opt/qpjoy/bin/mihomo-client
```

Show the underlying script help:

```bash
qp-tunnel-cli client-help
```
