# QPJoy WireGuard Engine Packages

Each subdirectory is a platform-specific npm package for
`@qpjoy/electron-core-wireguard`.

These packages are optional dependencies. When HDO is installed from the
marketplace, npm downloads only the package matching the user's operating
system and CPU.

```text
darwin-arm64 -> @qpjoy/electron-core-wireguard-engine-darwin-arm64
darwin-x64   -> @qpjoy/electron-core-wireguard-engine-darwin-x64
linux-arm64  -> @qpjoy/electron-core-wireguard-engine-linux-arm64
linux-x64    -> @qpjoy/electron-core-wireguard-engine-linux-x64
win32-x64    -> @qpjoy/electron-core-wireguard-engine-win32-x64
```

Expected runtime resource path:

```text
resources/wireguard/<platform-arch>/wg
resources/wireguard/<platform-arch>/wg.gz
resources/wireguard/<platform-arch>/wg-quick
resources/wireguard/<platform-arch>/wg-quick.gz
resources/wireguard/<platform-arch>/wireguard-go
resources/wireguard/<platform-arch>/wireguard-go.gz
resources/wireguard/<platform-arch>/bash
resources/wireguard/<platform-arch>/bash.gz
resources/wireguard/<platform-arch>/wg.exe
resources/wireguard/<platform-arch>/wg.exe.gz
resources/wireguard/<platform-arch>/wireguard.exe
resources/wireguard/<platform-arch>/wireguard.exe.gz
```

Current bundled artifacts:

- macOS arm64/x64: `wg` from Homebrew `wireguard-tools` bottle
  `1.0.20260223`; `wireguard-go` from the matching userspace engine.
  `wg-quick` and Bash 4+ may be packaged as an alternate launcher, but HDO can
  use its built-in userspace launcher without relying on macOS Bash 3.2.
- Linux arm64/x64: `wg` and `wg-quick` built from the official
  `wireguard-tools` source tarball `1.0.20260223`; `wireguard-go` may be
  included as a userspace fallback.
- Windows x64: `wg.exe` and `wireguard.exe` extracted from the official
  WireGuard Windows MSI `wireguard-amd64-1.1.msi`.

All packages include the WireGuard tools GPL-2.0-only `COPYING` file beside
the executable. Packages that include `wireguard-go` should also include its
MIT license file beside the runtime.
