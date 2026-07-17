# @qpjoy/electron-core-wireguard

Electron-scoped WireGuard profile contracts and rendering helpers for QPJoy HDO.

This package owns the shared WireGuard config/runtime layer for HDO clients,
installers, and future plugins. It renders profiles, discovers bundled engine
tools, and can bring a generated profile up/down when the matching engine
package includes the required runtime binaries.

Current scope:

- HDO mesh address defaults
- peer/interface config rendering
- shared port and ACL types
- helpers for splitting home/user/service overlay ranges
- local route probing and CIDR conflict checks
- optional platform engine discovery for bundled `wg` / `wg.exe`
- WireGuard runtime discovery for `wg-quick`, `wireguard-go`, macOS Bash 4+,
  and Windows `wireguard.exe`
- macOS userspace up/down via bundled `wireguard-go` + `wg`
- macOS LaunchDaemon endpoint bypass watchdog across gateway, interface, and
  DHCP source/IFA changes
- macOS/Linux `wg-quick up/down` command generation and execution when the
  full quick runtime is available

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

Runtime expectations:

- macOS: `wg` and `wireguard-go` for the built-in userspace launcher;
  `wg-quick` plus Bash 4+ can also be packaged as an alternate launcher.
- Linux: `wg` and `wg-quick`; `wireguard-go` is accepted as a userspace
  fallback when packaged.
- Windows: `wg.exe` for low-level operations and `wireguard.exe` for installing
  tunnel services.

System-installed tools are only a development fallback. Published HDO clients
should rely on the matching engine package so user machines do not need
Homebrew, WireGuard.app, or preinstalled WireGuard command-line tools.
