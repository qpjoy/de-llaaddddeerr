# QPJoy WireGuard Engine: Windows x64

Platform-specific WireGuard CLI resources for `@qpjoy/electron-core-wireguard`.

This package is installed as an optional dependency on matching systems. It
should ship:

- `resources/wireguard/win32-x64/wg.exe` or `.gz`
- `resources/wireguard/win32-x64/wireguard.exe` or `.gz`

Current upstream download target: official WireGuard Windows MSI from
`https://download.wireguard.com/windows-client/`. Extract `wg.exe` and
`wireguard.exe` from the MSI before publishing this package.
