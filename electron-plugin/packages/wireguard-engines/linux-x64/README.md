# QPJoy WireGuard Engine: Linux x64

Platform-specific WireGuard CLI resources for `@qpjoy/electron-core-wireguard`.

This package is installed as an optional dependency on matching systems. It
should ship `resources/wireguard/linux-x64/wg` or
`resources/wireguard/linux-x64/wg.gz`.

Current binary source: official `wireguard-tools` source tarball `1.0.20260223`,
statically built in Alpine Linux x64. Do not use Homebrew Linux bottles
directly here: their ELF interpreter targets Linuxbrew and is not portable for
normal Linux installs.
