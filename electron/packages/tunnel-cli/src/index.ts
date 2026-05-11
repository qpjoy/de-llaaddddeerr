#!/usr/bin/env node

const command = process.argv[2] ?? 'help';

function help(): void {
  process.stdout.write(`QPJoy Electron Tunnel CLI

Usage:
  qpjoy-tunnel help
  qpjoy-tunnel snippet

The current MVP ships the reusable runtime as @qpjoy/electron-mihomo-tunnel.
Use "snippet" to print the minimal Electron main-process integration.
`);
}

function snippet(): void {
  process.stdout.write(`import {
  AdminServer,
  MihomoManager,
  applyElectronProxy,
  registerTunnelIpc
} from '@qpjoy/electron-mihomo-tunnel'

const manager = new MihomoManager({
  userDataPath: app.getPath('userData'),
  adminPort: 23456,
  controllerPort: 23457
})

const admin = new AdminServer(manager)
admin.start()

registerTunnelIpc(ipcMain, manager, {
  afterSettingsChange: () => {
    const status = manager.status()
    return applyElectronProxy(session.defaultSession, status.mode, status.ports)
  }
})
`);
}

if (command === 'help' || command === '--help' || command === '-h') {
  help();
} else if (command === 'snippet') {
  snippet();
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  help();
  process.exitCode = 1;
}
