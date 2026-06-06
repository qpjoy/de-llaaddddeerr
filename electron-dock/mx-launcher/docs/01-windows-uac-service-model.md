# Windows UAC and Service Model

The repeated UAC prompt comes from mixing zip / portable startup with privileged
network operations. The product should use a strict split:

- Electron UI: signed user-mode app, never requires admin.
- MX Launcher: user-mode orchestrator, elevates only for install, repair, or
  service upgrade.
- Windows Service: privileged networking owner.

## Startup Flow

1. User starts `MxLauncher.exe`.
2. Launcher reads the installed manifest and product state.
3. If the service is missing, invalid, or too old, Launcher requests UAC once.
4. Elevated helper installs or repairs the service.
5. Launcher verifies signer and hashes for UI, service, and product resources.
6. Launcher starts Electron UI unelevated.

## Update Flow

1. Launcher downloads or receives a staged update.
2. Launcher verifies the package manifest hash.
3. Launcher verifies Authenticode signer for `*.exe`, `*.dll`, and native node
   modules.
4. Launcher stops the UI and asks the service to prepare privileged resources.
5. Launcher swaps user-mode resources atomically.
6. Launcher upgrades the service only when the service binary changed.
7. Launcher records the previous version for rollback.

## UAC Policy

- No UAC for opening a zip.
- No UAC for launching the already installed product.
- No UAC for UI-only update.
- UAC allowed for first service install.
- UAC allowed for service upgrade.
- UAC allowed for repair when service, route, DNS, NRPT, or WireGuard state is
  broken.

## Service-Owned Operations

- WireGuard adapter install, start, stop, and config apply.
- NRPT policy apply and cleanup.
- DNS server and domain routing changes.
- Route table and firewall changes.
- Privileged diagnostics.

## Launcher-Owned Operations

- Package verification.
- UI process start and restart.
- Product resource staging.
- Rollback.
- Service IPC authentication.
- Backend config sync.

## electron-builder-Owned Operations

- Package Electron UI.
- Produce `zip`, `portable`, and `dir`.
- Sign Electron executable.
- Copy `MxService.exe` and `MxLauncher.exe` into `extraResources`.
- Run `afterSign` for every executable, DLL, and native node module.

## Verification Gates

Each activation must pass:

- package manifest hash matches;
- every executable signer matches an allowed thumbprint;
- service version is compatible with product manifest;
- backend product id and legacy HDO id are both accepted;
- rollback copy is available before overwrite.
