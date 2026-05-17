# Bundled QPJoy Tunnel Engine

Put pre-downloaded tunnel engine files here before packaging the Electron app.
The runtime looks for one of these files and installs it into the user's app
data directory on first start:

```text
electron/resources/mihomo/darwin-arm64/mihomo.gz
electron/resources/mihomo/darwin-x64/mihomo.gz
electron/resources/mihomo/linux-x64/mihomo.gz
electron/resources/mihomo/linux-arm64/mihomo.gz
electron/resources/mihomo/win32-x64/mihomo.exe.gz
```

An uncompressed executable named `mihomo` (or `mihomo.exe` on Windows) works
too. The `.gz` form is preferred because it keeps the application package
smaller.
