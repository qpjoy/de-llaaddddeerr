# QPJoy WireGuard Engine: Windows x64

Platform-specific WireGuard CLI resources for `@qpjoy/electron-core-wireguard`.

This package is installed as an optional dependency on matching systems. It
should ship:

- `resources/wireguard/win32-x64/wg.exe` or `.gz`
- `resources/wireguard/win32-x64/wireguard.exe` or `.gz`

Current binary source: official WireGuard Windows MSI
`wireguard-amd64-1.1.msi`; `wg.exe` and `wireguard.exe` are extracted from the
MSI before publishing this package.
