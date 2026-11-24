# resources/edge

What `qp-tunnel-cli edge` sends to edge hosts (Domestic relays, jump hosts, new
public machines). Edge hosts do not run Kubernetes; they get releases pushed
over SSH into `/opt/mx/{incoming,releases,state,current}`, the v1 Launcher
layout.

```
edge/
  remote.sh            the remote half: check, status, releases, activate, rollback
  lib/edge-os.sh       OS adaptation: os-release family, apt/dnf/yum, systemd, firewall and SELinux reports, docker
  lib/edge-nginx.sh    nginx site files from state, nginx -t with restore, reload
  stacks/<name>/       one directory per technology stack
    stack.env          manifest (KEY=value, never sourced)
    deploy.sh          applies the release on the host (root)
    health.sh          read-only check after deploy and for `edge status --health`
    state.example/     what the operator fills in and pushes with --state-dir (never in Git)
  vendor/              filled by `prepack` from the repository (see STACK_VENDOR); not in Git
```

## Stacks

| Stack | Back-haul to Internal | Public side | Pick it when |
|---|---|---|---|
| `wg-nginx` | WireGuard relay from `edge link init` (shape of the Launcher's `mx-domestic`) | nginx 80/443, optional | throughput and low CPU per packet matter; kernel has WireGuard (not CentOS 7) |
| `open-nginx` | OpenVPN server instance (`qp-tunnel-cli open`) | nginx 80/443 | TCP fallback, TLS-wrapped transport, or kernels without WireGuard |
| `hy2` | none (it is the proxy) | Hysteria2 UDP, mihomo engine under systemd, no Docker | a local proxy port on the pushing machine; `qp-tunnel-cli hy2 up` makes the state and adds the engine to the bundle |
| `hy2-mihomo` | none (it is the proxy) | Hysteria2 UDP + subscription site | serving proxy subscriptions; runs `docker/hysteria2-mihomo-stack` unchanged |

`qp-tunnel-cli edge stacks` lists them, `edge stacks <name>` shows one,
`edge stacks <name> --init <dir>` writes its state template to fill in.

## wg-nginx and `edge link`

The tunnel is made on the Internal machine, not on the host:
`qp-tunnel-cli edge link init <host>` (or `edge setup`, which asks everything step by step) makes
both key pairs there and writes the relay side into the state it pushes
(`wg/relay.conf`, `wg/relay.env`). deploy.sh installs `wg/relay.conf` as
`/etc/wireguard/<EDGE_WG_INTERFACE>.conf` (default `qpjoy-relay`) and starts
`wg-quick@<interface>`. Same shape as the Launcher's Domestic relay
`mx-domestic` (`10.88.0.1/16`, `Table = off`): the host listens, the Internal
machine dials out with a keepalive. Unlike `mx-domestic` it does not turn on
`ip_forward` or add iptables rules: only the host itself talks to the peers.

deploy.sh refuses when the subnet is already routed on another interface,
or when `/etc/wireguard/<interface>.conf` exists without the
`# qp-tunnel-cli edge link` header. A changed config is backed up to
`/etc/wireguard/qp-edge-backup/<component>/` before it is replaced. nginx is
optional: with no `nginx/*.conf` in the state, nginx is not installed or touched.
The Internal side is `edge link up <host>` on the machine that ran init.

## hy2

`qp-tunnel-cli hy2 push <host>` (or `hy2 up`) makes the state on the pushing
machine (`server.yaml`, `hy2.env` with `HY2_PORT`, `tls/server.crt`,
`tls/server.key`) and adds `engine/mihomo.gz`, `engine/target` and
`engine/source` for the host's architecture to the bundle. deploy.sh refuses an
engine for another architecture, unpacks it to `<release>/bin/mihomo`, runs
`mihomo -t` on `server.yaml` before touching anything, refuses a UDP port held
by another process and a `qp-edge-<component>.service` it did not write, raises
`net.core.rmem_max`/`wmem_max` to 16 MiB for QUIC (`/etc/sysctl.d/90-qp-hy2.conf`,
only upwards), and restarts the unit only when the engine, `server.yaml`, the
certificate or the unit changed (`state/<component>/.hy2-applied`). The unit runs
`current/<component>/bin/mihomo`, so `edge rollback` restarts the old engine with
the restored state. health.sh: the unit is active and its process holds the port.

## Origins

Several Internal machines can push. `remote.sh` gets the pushing machine's name
as `EDGE_ORIGIN`, writes it to `state/<component>/.edge-origin` after a push or
rollback, and adds it to each `.edge-history` line
(`<utc time> <revision> <origin> <push|rollback>`). A different origin is
refused unless `EDGE_TAKE_OVER=1`. A host where any `current/*` was not pushed by
the edge tool is refused as a whole unless `EDGE_SHARED_HOST=1`. Refusals happen
before anything is unpacked and drop the uploaded files. `remote.sh state-export
<component>` writes the state files pushes carried (current content) to stdout
as tar.gz, for `edge state pull`.

## stack.env

| Key | Meaning |
|---|---|
| `STACK_NAME` | default component name |
| `STACK_SUMMARY` | one line for `edge stacks` |
| `STACK_OS` | OS families deploy.sh handles: `debian`, `rhel`. activate refuses others before switching anything (`--force-os` overrides) |
| `STACK_SYSTEMD` | `1`: refuse hosts without systemd |
| `STACK_PORTS` | ports the cloud security group must allow (informational; nothing opens ports) |
| `STACK_STATE_REQUIRED` | files or directories that must exist in `state/<component>/` before the switch |
| `STACK_STATE_HINT` | where the required state comes from, printed by the push plan and preflight when it is missing |
| `STACK_VENDOR` | repository-relative files copied into the bundle under `vendor/` |
| `STACK_IMAGES` | images the stack pulls; ship them with `--image` when the host cannot reach the registry |
| `STACK_STATE_TEMPLATES` | `name=vendor/path` pairs `--init` copies into the state template |
| `STACK_INSTALLS` | packages deploy.sh may install, shown in the push plan |
| `STACK_BUNDLE_REQUIRED` | files the pushing tool adds to the bundle itself (hy2: `engine/mihomo.gz engine/target`); `edge push` refuses before connecting, and preflight before switching, when they are missing |
| `STACK_BUNDLE_HINT` | what to run instead, printed with that refusal |
| `STACK_START` | the one command that sets the stack up, shown by `edge stacks <name>` instead of the state-template steps |

## OS families

`lib/edge-os.sh` maps `/etc/os-release` to a family:

| Family | IDs | Packages | Notes |
|---|---|---|---|
| `debian` | ubuntu, debian | apt-get | nginx, openvpn, wireguard-tools, docker.io from the distribution |
| `rhel` | centos, rocky, almalinux, rhel, fedora, ol | dnf, else yum | EPEL for openvpn (and nginx on 7); Docker CE repository from `EDGE_DOCKER_REPO`; SELinux blocks nginx proxying until `httpd_can_network_connect` is on. CentOS Linux 7/8 and CentOS Stream 8 are end of life: check, status (`eol=yes`) and preflight say so, and installs work only with vault or local repositories already configured |

Nothing in these scripts opens firewall ports: deploy.sh reports ufw or
firewalld state per port and prints the command. The vendored WireGuard and
OpenVPN scripts keep their own behaviour (they add their own rules).
