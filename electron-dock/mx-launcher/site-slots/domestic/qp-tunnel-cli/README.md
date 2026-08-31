# @qpjoy/tunnel-cli

Global CLI wrapper for the QPJoy Linux `mihomo-client` server script and
headless WireGuard enrollment for legacy HDO V1 and MX H2I V2.

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

## OpenVPN Reverse Access (`open`)

`qp-tunnel-cli open` connects an Oversea server to a machine that only has
outbound connectivity, so the Oversea side can reach back into it. The Oversea
host runs the server; the inside machine enrolls as a spoke.

The design rationale, the subnet decision and the guarantees are in
[docs/01-openvpn-reverse-access.md](docs/01-openvpn-reverse-access.md).

On the Oversea server:

```bash
sudo qp-tunnel-cli open preflight --server --subnet 100.127.0.0/24
sudo qp-tunnel-cli open install --host 203.0.113.10 --port-range 20000-20100
sudo qp-tunnel-cli open create internal-01 --ip 100.127.0.10
```

Copy the resulting `.ovpn` to the inside machine and enroll there:

```bash
sudo qp-tunnel-cli open preflight --file internal-01.ovpn
sudo qp-tunnel-cli open enroll --file internal-01.ovpn
sudo qp-tunnel-cli open doctor
```

Enrollment is deliberately containing. The generated client configuration uses
`route-nopull` plus explicit pull-filters and `script-security 0`, and the
server pushes nothing at all, so joining the link cannot install routes, move
the default gateway or touch the resolver. The only kernel change is the
connected route for the tunnel interface. `open doctor` proves it by diffing
the live default route, `/etc/resolv.conf` and the nat table against a snapshot
taken before enrollment.

`open preflight` enumerates the kernel routing table, Docker networks, the CNI
and any WireGuard overlay, and refuses a tunnel subnet that overlaps any of
them. The default `100.127.0.0/24` is RFC 6598 space, which Docker's address
pools never reach; note that `172.66`-`172.88` are **public** addresses, not
private ones, and that an AWS default VPC occupies `172.31.0.0/16`.

Each instance owns its own interface, unit, iptables chain and state directory,
so one inside machine can hold links to several Oversea servers at once:

```bash
sudo qp-tunnel-cli open enroll --instance jp01 --file jp01.ovpn
sudo qp-tunnel-cli open enroll --instance us01 --file us01.ovpn
```

The distribution `openvpn-server@.service` and `openvpn-client@.service`
templates are never created, modified or enabled; an unrelated OpenVPN
installation on the same host is left alone. `open` uses
`qp-openvpn-client@`, `qp-openvpn-server@` and `qp-openvpn-firewall@` instead,
and refuses to overwrite a same-named unit it did not write.

On the Oversea host the runtime is selected automatically: when the
qp-tunnel-cli managed `mx-oversea-hysteria2` stack is present, OpenVPN is
deployed as a sibling container on `network_mode: host`; otherwise it is
installed on the host directly. Host networking is required rather than
preferred - on a bridge network the tun device stays inside the container
namespace, where neither the host nor a sibling container can reach the spoke
addresses.

Routing internet traffic through the Oversea server is a separate, reversible
opt-in that enrollment never performs:

```bash
sudo qp-tunnel-cli open egress on --mode cn-direct
sudo qp-tunnel-cli open egress off
```

`cn-direct` reads this host's local networks from the live routing table at the
moment it is enabled, so LAN, Docker bridges, the CNI and existing overlays stay
direct, and applies a China IP-prefix split. That split is an approximation:
OpenVPN has no equivalent of Clash domain rules.

`open create` issues two profiles at once, because the two client generations
disagree about which options exist:

- `<name>.ovpn` for OpenVPN 2.4.7+, Tunnelblick, the Windows community GUI and
  `open enroll`
- `<name>.connect.ovpn` for OpenVPN Connect and the mobile apps, which run the
  OpenVPN 3 core

Both are self-contained: generic `dev tun`, inlined certificates, and the fixed
address still comes from the server's client-config-dir. Containment lives in
the file rather than in the tooling, and the server pushes nothing at all, so a
direct import is equally unable to install routes or DNS.

OpenVPN 3 rejects a whole profile rather than ignoring options it does not
know. Measured against a real Connect log, the option it names is `topology`,
which OpenVPN 3 has never had because it implements subnet topology internally;
`pull-filter` and `script-security` are unsupported for the same kind of
reason. The Connect variant therefore keeps `route-nopull` and `data-ciphers`
- both confirmed to parse - and drops the rest. That costs the `pull-filter`
layer, which only guards against a mis-set server; the primary guarantee, a
server that pushes nothing, is unaffected.

Importing directly does give up the checks around the connection: the subnet
collision preflight, the pinned host route, the before/after snapshot behind
`open doctor`, and the deterministic interface name. Note also that GUI clients
apply their own settings on top of the profile - Tunnelblick's per-config "Set
nameserver" changes DNS regardless of what the profile says. Prefer
`open enroll` on a production host; a direct import is fine for a phone or a
throwaway check. See the design note for the full matrix.

Spoke commands run on Linux and macOS; the server and `egress` are Linux-only.

## WireGuard Global IPv4 VPN (`wg`)

`qp-tunnel-cli wg` provides isolated WireGuard server/client interfaces with
IPv4 forwarding and NAT on the server. On AWS, pass the Elastic IP as `--host`;
EIPs are VPC NAT mappings and are not expected to appear in the local interface
list.

```bash
sudo qp-tunnel-cli wg preflight --server --subnet 100.127.50.0/24
sudo qp-tunnel-cli wg install \
  --host 203.0.113.10 \
  --subnet 100.127.50.0/24 \
  --port-range 20000-20100
sudo qp-tunnel-cli wg create internal-01 --ip 100.127.50.10
```

Copy the generated `.conf` to the spoke, then enroll it:

```bash
sudo qp-tunnel-cli wg enroll --file internal-01.conf
```

The profile routes all IPv4 traffic through WireGuard (`0.0.0.0/0`) while
retaining the client's existing DNS resolver. The default `100.127.50.0/24`
avoids the OpenVPN default at `100.127.0.0/24`. `100.127.100.0/24` is another
recommended start. `100.128.*` is rejected because RFC 6598 ends at
`100.127.255.255`.

Rotate the live listener and all issued profiles with one command. Without a
configured range it increments the current port by one; `--port` selects an
exact port. No WireGuard keys change:

```bash
sudo qp-tunnel-cli wg rotate-port
```

Already-enrolled clients can manually change the `Endpoint` port in
`/etc/wireguard/qpwgc-mx.conf` and run `wg restart --client`, or receive the
updated profile and run `wg enroll --force`. See
[wireguard.setup.md](wireguard.setup.md) for the full command sequence and
multi-instance example.

## MX H2I V2 Enrollment on Ubuntu

`qp-tunnel-cli h2i` is the native V2 path. It uses the same
`@qpjoy/mx-launcher-standalone` network session as the standalone Launcher and
does not call the legacy `electron-server` HDO APIs.

Install the CLI and WireGuard tools on the Ubuntu host:

```bash
sudo apt-get update
sudo apt-get install -y wireguard-tools
sudo npm i -g @qpjoy/tunnel-cli@0.3.0 --force
```

Account enrollment uses the Domestic HTTPS bootstrap facade. Keep the password
out of shell history by using an environment variable or a root-readable file:

```bash
read -rsp 'H2I password: ' H2I_PASSWORD; export H2I_PASSWORD; printf '\n'
qp-tunnel-cli h2i enroll \
  --bootstrap-url 'https://h2i.example.com' \
  --username 'user@example.com'
unset H2I_PASSWORD
```

Anonymous enrollment skips OAuth but follows the same V2 lease, snapshot, and
Domestic peer-sync flow:

```bash
qp-tunnel-cli h2i enroll \
  --bootstrap-url 'https://h2i.example.com' \
  --anonymous
```

The command re-runs itself through `sudo` while preserving only the H2I
environment variables when the default root-owned paths are used. It then:

- verifies `/bootstrap-healthz` through the Domestic edge
- exchanges an Internal local-password account for an `mx-sdk` token, or uses
  the anonymous lease pool
- creates/renews a stable standalone launcher-network lease and snapshot
- saves the WireGuard key and lease capability with mode `0600`; it never saves
  the password or OAuth access token
- synchronously appends the same public key and lease `/32` to `mx-domestic`
- writes `/etc/wireguard/mx-h2i.conf` and enables the dedicated
  `qpjoy-h2i@mx-h2i.service` unit
- requires a WireGuard handshake and probes `/healthz` over the snapshot's
  Internal control IP and service port before reporting success

Useful lifecycle commands:

```bash
qp-tunnel-cli h2i status
qp-tunnel-cli h2i down
```

`down` retains the V2 lease by default so the host can reconnect with the same
identity. Re-running `h2i enroll` renews the lease and rotates its client-held
capability while reusing the installation id, device id, and WireGuard key.
Lease revocation is not exposed yet because the current server release endpoint
does not remove the corresponding peer from Domestic.

H2I never replaces or trusts the global `wg-quick@.service` template, which may
still belong to a V1 HDO installation. Each interface owns a concrete unit such
as `/etc/systemd/system/qpjoy-h2i@mx-h2i.service`; this avoids runtime-path
conflicts between H2I instances. The CLI refuses to overwrite an unmanaged unit
or an existing WireGuard config that is not bound to the same H2I state.

The first Linux implementation is intentionally Domestic-relay-only:

```text
Ubuntu mx-h2i -> Domestic mx-domestic:51280/UDP -> Internal 10.88.88.88
```

It does not enable the optional client-to-Internal direct/hybrid path. Use
`--no-start` with explicit `--state-file`, `--config-path`, and `--install-dir`
to stage and inspect a profile without changing the system. DNS is off by
default, so enrollment does not replace Ubuntu's resolver. `--dns` explicitly
adds the Internal DNS server through `wg-quick`; this is global resolver
integration, not split DNS, and requires `resolvconf`/`openresolv`. Keep the
default when DNS is managed separately.

When selecting a custom directory, the config basename must still match the
interface (for example `--interface lab-h2i --config-path /srv/wg/lab-h2i.conf`).
State, interface, and config locks cover the complete enrollment so concurrent
renewals cannot race lease capabilities or restart the same kernel interface.

Server-side prerequisites must already be ready: the `mx-h2i` Product Network
and AppCenter entitlement, an active Domestic WG secret with public endpoint
and key, an active Domestic Site Slot SSH profile, and a running `mx-domestic`
interface. Enrollment deliberately fails when Domestic peer sync is blocked;
receiving a lease alone is not considered connected.

## Legacy HDO V1 Mesh Enrollment

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

Do not combine V1 `hdo --server-url` with a V2 `--internal-url` lease for a
production H2I connection: the legacy Domestic peer is assigned a `100.89.*`
address while the V2 lease is `10.*`, so its `AllowedIPs` do not form a valid V2
path. Use `qp-tunnel-cli h2i enroll` for V2.

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

### Isolated application subscription instance

The historical/default instance remains unchanged: it uses
`/etc/mihomo-client`, `mihomo-client.service`, and local mixed-port `7788`.
To keep that login/bootstrap egress intact while exposing a second subscription
to applications on `7890`, install the reserved named instance explicitly:

```bash
npm i -g @qpjoy/tunnel-cli@2.0.8

sudo qp-tunnel-cli install \
  --instance subscriptions \
  --mixed-port 7890 \
  --url 'http://user:pass@OVERSEA_IP:3434/peer_subscriptions.mihomo.yaml'
```

Use the export port assigned to that Oversea deployment; it is normally `3434`
and may be `3435` when the default port is already occupied.

`--mixed-port` is persisted in the named instance's private `client.env` and
overrides any `mixed-port` embedded in the downloaded YAML. A named instance's
first install requires the option, which prevents an omitted flag from silently
competing with the default listener on `7788`.

The `subscriptions` instance owns separate resources:

- state and credentials: `/etc/mihomo-client/instances/subscriptions`
- service: `mihomo-client@subscriptions.service`
- binary and launcher: `/usr/local/bin/mihomo-subscriptions` and
  `/usr/local/bin/mihomo-client-subscriptions`
- profile, SSH helper/config, and daemon drop-in names (kept separate even
  though this reserved instance refuses to enable those integrations)

Manage or update it by passing the same instance name:

```bash
sudo qp-tunnel-cli status --instance subscriptions
sudo qp-tunnel-cli update-subscription --instance subscriptions
sudo qp-tunnel-cli restart --instance subscriptions
sudo qp-tunnel-cli stop --instance subscriptions
sudo qp-tunnel-cli start --instance subscriptions

curl --proxy http://127.0.0.1:7890 https://www.google.com/generate_204
```

This instance is explicit-use-only. Host integration changes (`egress-*`,
`server-*`, `tun-*`, `listen on/off`, `proxy-*`, `ssh-proxy-*`, and
daemon/Docker proxy changes) are rejected for it, so installing or updating port
`7890` cannot replace or restart the host-wide `7788` egress used by MX-H2I.
Removal is instance-scoped:

```bash
sudo qp-tunnel-cli uninstall --instance subscriptions
# Add --purge only when its private config and binary should also be deleted.
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
