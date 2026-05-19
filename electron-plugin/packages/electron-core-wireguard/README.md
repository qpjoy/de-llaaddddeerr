# @qpjoy/electron-core-wireguard

Electron-scoped WireGuard profile contracts and rendering helpers for QPJoy HDO.

This package does not create system interfaces by itself. It is the stable
data/config layer that HDO clients, installers, and future plugins can share.

Current scope:

- HDO mesh address defaults
- peer/interface config rendering
- shared port and ACL types
- helpers for splitting home/user/service overlay ranges
- local route probing and CIDR conflict checks
- optional platform engine discovery for bundled `wg` / `wg.exe`

WireGuard CLI binaries are distributed separately as optional platform packages:

```text
@qpjoy/electron-core-wireguard-engine-darwin-arm64
@qpjoy/electron-core-wireguard-engine-darwin-x64
@qpjoy/electron-core-wireguard-engine-linux-arm64
@qpjoy/electron-core-wireguard-engine-linux-x64
@qpjoy/electron-core-wireguard-engine-win32-x64
```

HDO is not a built-in marketplace plugin, so these engines are downloaded with
the plugin dependency tree rather than bundled into `@qpjoy/electron-market`.
