# @qpjoy/tunnel-cli

Global CLI wrapper for the QPJoy Linux `mihomo-client` server script and
cross-platform headless HDO mesh enrollment.

```bash
npm i -g @qpjoy/tunnel-cli
qp-tunnel-cli help
```

The package ships the existing `scripts/mihomo-client.sh` file in the npm
tarball. It also depends on `@qpjoy/electron-core-wireguard`, which resolves the
matching platform engine package such as darwin-arm64, linux-x64, or win32-x64.
The core WireGuard package is consumed as-is; this CLI does not modify its HDO
plugin behavior.

## HDO Mesh Enrollment

For macOS, Windows, or a headless Linux machine such as an Internal/company
server, enroll into the HDO mesh without installing Electron:

```bash
npm i -g @qpjoy/tunnel-cli
HDO_PASSWORD='<password>' qp-tunnel-cli hdo enroll \
  --server-url 'https://domestic.example.com' \
  --username 'internal-i' \
  --device-id internal-i \
  --label 'Internal I'
```

On Linux, run the same command through `sudo -E` because it writes
`/etc/wireguard` and enables `wg-quick@hdo-internal`:

```bash
HDO_PASSWORD='<password>' sudo -E qp-tunnel-cli hdo enroll \
  --server-url 'https://domestic.example.com' \
  --username 'internal-i'
```

The command:

- logs in with username/password, or uses `--token` when provided
- uses `@qpjoy/electron-core-wireguard` to find/install the platform WireGuard engine
- registers the machine as an HDO device
- downloads the HDO manifest from `electron-server`
- writes a local WireGuard config
- stores local HDO state and refresh credentials
- starts a system-level tunnel at boot

Useful follow-up commands:

```bash
qp-tunnel-cli hdo status
qp-tunnel-cli hdo refresh
qp-tunnel-cli hdo down
```

Platform behavior:

- Linux: writes `/etc/wireguard/hdo-internal.conf` and enables `wg-quick@hdo-internal`
- macOS: installs a LaunchDaemon and may prompt for an administrator password
- Windows: installs a WireGuard tunnel service and may show a UAC prompt

Current MVP authentication accepts either username/password or the same bearer
token used by the HDO API. Production enrollment should move to short-lived
enrollment tokens and durable service tokens so external systems do not need to
handle user session JWTs.

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
