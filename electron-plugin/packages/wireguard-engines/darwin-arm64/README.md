# QPJoy WireGuard Engine: macOS arm64

Platform-specific WireGuard CLI resources for `@qpjoy/electron-core-wireguard`.

This package is installed as an optional dependency on matching systems. It
should ship:

- `resources/wireguard/darwin-arm64/wg` or `.gz`
- `resources/wireguard/darwin-arm64/wireguard-go` or `.gz`
- optional `resources/wireguard/darwin-arm64/wg-quick` or `.gz`
- optional `resources/wireguard/darwin-arm64/bash` or `.gz`

Current binary source: Homebrew `wireguard-tools` bottle `1.0.20260223`.
WireGuard tools are GPL-2.0-only; the bundled `COPYING` file is included next
to the executable. `wireguard-go` is MIT licensed; the bundled
`WIREGUARD_GO_LICENSE` file is included beside it.
