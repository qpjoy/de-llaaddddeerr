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

Mihomo itself is not installed as an npm dependency of this CLI package. During
`qp-tunnel-cli install`, the Linux client script lazily downloads the matching
npm engine package, for example
`@qpjoy/electron-plugin-tunnel-engine-linux-x64`, and installs the bundled
`resources/engine/<platform>/mihomo.gz`. If npm is unavailable, the package is
missing, or that download fails, the script falls back to the upstream
MetaCubeX/mihomo GitHub release. This keeps `npm i -g @qpjoy/tunnel-cli` small
while avoiding GitHub during bootstrap when the npm registry or a registry mirror
is reachable first.

## HDO Mesh Enrollment

For macOS, Windows, or a headless Linux machine such as an Internal/company
server, enroll into the HDO mesh without installing Electron:

```bash
npm i -g @qpjoy/tunnel-cli
HDO_PASSWORD='<password>' qp-tunnel-cli hdo enroll \
  --server-url 'https://domestic.example.com' \
  --internal-url 'http://127.0.0.1:18090' \
  --product-id h2o \
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
- requests an MX Launcher Internal product lease when `--internal-url` is set
- uses that lease as the WireGuard client address and adds the product route CIDR
- uses `@qpjoy/electron-core-wireguard` to find/install the platform WireGuard engine
- registers the machine as an HDO device
- downloads the HDO manifest from `electron-server`
- writes a local WireGuard config
- stores local HDO state and refresh credentials
- starts a system-level tunnel at boot. On Linux, if `wg-quick@.service` is not
  installed by the OS, the CLI writes a compatible systemd unit that uses the
  bundled WireGuard tools from the npm package.

To test the new Internal allocator without applying WireGuard yet, run lease-only
mode. If `--server-url` is omitted and `--internal-url` is present, the command
automatically behaves as lease-only:

```bash
qp-tunnel-cli hdo enroll \
  --internal-url 'http://127.0.0.1:18090' \
  --product-id h2o \
  --identity-kind anonymous \
  --lease-only
```

For H2O, Internal assigns logged-in users from `10.90.0.1-10.90.99.254` and
anonymous users from `10.90.100.1-10.90.254.254`, based on the Product Network
Registry.

Useful follow-up commands:

```bash
qp-tunnel-cli hdo status
qp-tunnel-cli hdo refresh
qp-tunnel-cli hdo down
```

If a tunnel was created by the Electron HDO plugin, its default interface is
`hdo-client`, so stop it with:

```bash
qp-tunnel-cli hdo down --interface hdo-client
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

### No-Node Bootstrap

The npm package also ships a standalone shell bootstrapper at
`resources/manage.sh`. It is designed for a fresh server that does not have Node
yet, so you can upload just this file first:

```bash
scp electron-plugin/packages/tunnel-cli/resources/manage.sh root@server:/tmp/qp-tunnel-bootstrap.sh
ssh root@server 'bash /tmp/qp-tunnel-bootstrap.sh'
```

The bootstrapper opens a small management panel. It prepares only the
prerequisites for `npm i -g @qpjoy/tunnel-cli`; mirror settings are current
script-session environment variables and do not write npm registry config or
Docker daemon mirror config globally.

- install nvm into `~/.nvm` when nvm is missing
- run `nvm install`, `nvm use`, and `nvm alias default` for the requested Node version
- choose Node download source for the current panel session
- try nvm's official Node source first and retry
  `https://mirrors.cloud.tencent.com/nodejs-release/` if the official source
  fails
- download nvm from the official GitHub tarball first, then fall back to the
  Gitee `mirrors/nvm` tarball if GitHub is unavailable
- choose npm registry for the current panel session
- choose a Docker Hub mirror prefix and pull/tag images through that helper
- apply common domestic env mirrors for Electron, Playwright, pip, uv, and Go
- run `npm i -g @qpjoy/tunnel-cli@latest --force`

Useful direct commands:

```bash
bash /tmp/qp-tunnel-bootstrap.sh
bash /tmp/qp-tunnel-bootstrap.sh install-nvm
bash /tmp/qp-tunnel-bootstrap.sh install-node 22
bash /tmp/qp-tunnel-bootstrap.sh install-cli @qpjoy/tunnel-cli@latest
bash /tmp/qp-tunnel-bootstrap.sh bootstrap 22 @qpjoy/tunnel-cli@latest
bash /tmp/qp-tunnel-bootstrap.sh env
```

If both built-in nvm tarball sources are unavailable, upload a nvm tarball
yourself and point the bootstrapper at it. You can pass one path/URL, or a
comma/space/newline separated fallback list:

```bash
QP_TUNNEL_NVM_TARBALL_URLS=/tmp/nvm-v0.40.3.tar.gz bash /tmp/qp-tunnel-bootstrap.sh
```

Run commands directly through the bundled script:

```bash
qp-tunnel-cli status
qp-tunnel-cli egress-on
qp-tunnel-cli egress-off
qp-tunnel-cli update-subscription
```

For server commands, `qp-tunnel-cli` re-runs itself with `sudo` when root is needed.
Use `egress-on` for public VPS hosts: it keeps Mihomo running as a local outbound
proxy and configures shell, SSH, Docker/containerd/buildkit proxy drop-ins without
enabling TUN route takeover. Reserve `tun-on` for machines that are not serving
public inbound traffic. `egress-off` removes those shell/SSH/daemon proxy
integrations and disables the TUN overlay; run `qp-tunnel-cli stop` as well if
you also want to stop the resident local proxy on the mixed port.

When `tun-on` is necessary on a server host, the generated overlay uses safer
defaults for inbound access: Linux `auto-redirect` is disabled by default,
private/local CIDRs bypass TUN, and the current SSH client IP is added to
`route-exclude-address`. Add known public ingress sources before enabling TUN:

```bash
MIHOMO_TUN_ROUTE_EXCLUDE_ADDRESS="203.0.113.10/32,198.51.100.0/24" \
  sudo -E qp-tunnel-cli tun-on
```

For persistent entries, write newline or comma separated CIDRs to
`/etc/mihomo-client/tun-route-exclude-addresses.txt` and rerun `tun-on`.

Domestic bootstrap can install from an Internal-pushed subscription file before
the WG relay can reach Internal:

```bash
sudo qp-tunnel-cli install \
  --file /opt/mx/current/qp-tunnel-cli/domestic-bootstrap-subscription.yaml
sudo qp-tunnel-cli egress-on
```

For Basic Auth subscription URLs, either pass credentials separately or embed
them in the URL:

```bash
sudo qp-tunnel-cli install --url 'http://download:pass@example.com/peer.yaml'
sudo qp-tunnel-cli install --url 'http://example.com/peer.yaml' --user download --password pass
```

`--no-auth` forces an unauthenticated fetch and also avoids prompting for saved
credentials, so do not combine it with a URL that needs `user:pass@` auth.

Mihomo core download fallback knobs:

```bash
# Disable npm engine package if you want GitHub-only behavior.
MIHOMO_NPM_ENGINE_FALLBACK=false sudo -E qp-tunnel-cli install --url ...

# Use a registry mirror or pin the engine package version/dist-tag.
MIHOMO_NPM_REGISTRY=https://registry.npmmirror.com \
MIHOMO_NPM_ENGINE_VERSION=latest \
sudo -E qp-tunnel-cli install --url ...
```

The fallback uses a temporary npm cache by default, so it does not depend on a
previous user's `~/.npm` permissions. Set `MIHOMO_NPM_CACHE` only if you want a
persistent cache directory.

Run any command through the active Mihomo local proxy:

```bash
qp-tunnel-cli ./electron-server/scripts/manage.sh redeploy
qp-tunnel-cli -- docker compose build
```

For host commands, `HTTP_PROXY` points at `127.0.0.1:<mixed-port>`. For
Docker/Compose build containers, the CLI also injects container-facing variables
such as `MARKET_CONTAINER_HTTP_PROXY` and `QP_TUNNEL_CONTAINER_HTTP_PROXY`
pointing at `host.docker.internal:<mixed-port>`.

### K8s/containerd Image Preload

Kubernetes on kubeadm/containerd does not use Docker's image store. If Docker
Compose can pull images through `tun-on` but pods still hit `ImagePullBackOff`,
preload the runtime images into containerd's `k8s.io` namespace on the K8s host:

```bash
sudo qp-tunnel-cli tun-on
sudo qp-tunnel-cli k8s preload-images
sudo qp-tunnel-cli tun-off
```

The default preload set matches the MX Launcher Internal runtime images:
`postgres:16-alpine`, `coredns/coredns:1.11.3`, and `caddy:2.8.4-alpine`.
Add more images as needed:

```bash
sudo qp-tunnel-cli k8s preload-images \
  --image postgres:16-alpine \
  --image qpjoy/mx-launcher-server:shadow
```

If the cluster already has pods stuck in `ImagePullBackOff`, read the current
pod specs and preload their referenced images:

```bash
sudo qp-tunnel-cli k8s preload-images --from-cluster
```

The command pulls missing images with Docker, saves them, and imports them with
`ctr -n k8s.io images import`, so kubelet can start pods without reaching the
remote registry. After preloading a previously failed pod image, restart the pod
or rerun the deployment rollout.

Install the bundled script as a normal Linux command:

```bash
sudo qp-tunnel-cli install-script
sudo qp-tunnel-cli upgrade-systemd
sudo mihomo-client status
sudo mihomo-client egress-on
```

Use a custom target when needed:

```bash
sudo qp-tunnel-cli install-script --target /opt/qpjoy/bin/mihomo-client
```

Show the underlying script help:

```bash
qp-tunnel-cli client-help
```
