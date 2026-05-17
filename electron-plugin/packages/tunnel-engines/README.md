# QPJoy Tunnel Engine Packages

Each subdirectory is a platform-specific npm package for
`@qpjoy/electron-plugin-tunnel`.

The package names stay long and explicit on npm, but the workspace directories
use only the target triplet:

```text
darwin-arm64 -> @qpjoy/electron-plugin-tunnel-engine-darwin-arm64
darwin-x64   -> @qpjoy/electron-plugin-tunnel-engine-darwin-x64
linux-arm64  -> @qpjoy/electron-plugin-tunnel-engine-linux-arm64
linux-x64    -> @qpjoy/electron-plugin-tunnel-engine-linux-x64
win32-x64    -> @qpjoy/electron-plugin-tunnel-engine-win32-x64
```
