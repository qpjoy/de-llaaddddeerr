# Native Launcher and Service Artifacts

This directory is copied by electron-builder through `extraResources`.

Expected Windows release layout:

```text
native/win32-x64/MxLauncher.exe
native/win32-x64/MxService.exe
```

The files are intentionally not mocked. `scripts/check-package-contract.mjs`
fails Windows release builds when these executables are absent unless
`MX_LAUNCHER_ALLOW_MISSING_NATIVE=1` is set for local UI-only smoke builds.
