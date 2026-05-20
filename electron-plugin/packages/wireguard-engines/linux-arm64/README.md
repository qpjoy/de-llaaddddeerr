# QPJoy WireGuard Engine: Linux arm64

Platform-specific WireGuard CLI resources for `@qpjoy/electron-core-wireguard`.

This package is installed as an optional dependency on matching systems. It
should ship:

- `resources/wireguard/linux-arm64/wg` or `.gz`
- `resources/wireguard/linux-arm64/wg-quick` or `.gz`
- optional `resources/wireguard/linux-arm64/wireguard-go` or `.gz`

Current binary source: official `wireguard-tools` source tarball `1.0.20260223`,
statically built in Alpine Linux arm64. Do not use Homebrew Linux bottles
directly here: their ELF interpreter targets Linuxbrew and is not portable for
normal Linux installs.
