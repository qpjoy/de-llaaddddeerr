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
qp-tunnel-cli tun-on
qp-tunnel-cli tun-off
qp-tunnel-cli update-subscription
```

For server commands, `qp-tunnel-cli` re-runs itself with `sudo` when root is needed.

Install the bundled script as a normal Linux command:

```bash
sudo qp-tunnel-cli install-script
sudo mihomo-client status
sudo mihomo-client tun-on
```

Use a custom target when needed:

```bash
sudo qp-tunnel-cli install-script --target /opt/qpjoy/bin/mihomo-client
```

Show the underlying script help:

```bash
qp-tunnel-cli client-help
```
