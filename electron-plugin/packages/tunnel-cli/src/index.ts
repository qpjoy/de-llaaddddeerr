#!/usr/bin/env node

const command = process.argv[2] ?? 'help';

function help(): void {
  process.stdout.write(`QPJoy Electron Tunnel CLI

Usage:
  qpjoy-tunnel help
  qpjoy-tunnel snippet

The published SDK ships the reusable runtime as @qpjoy/electron-tunnel.
Use "snippet" to print the minimal Electron main-process integration.
`);
}

function snippet(): void {
  process.stdout.write(`import { app, ipcMain, session } from 'electron'
import { createElectronTunnel } from '@qpjoy/electron-tunnel'

const tunnel = createElectronTunnel({ app, ipcMain, session: session.defaultSession }, {
  adminPort: 23456,
  controllerPort: 23457,
  mixedPort: 23458,
  dnsPort: 23459
})

app.whenReady().then(async () => {
  await tunnel.applyProxy()
})

app.on('before-quit', () => {
  tunnel.close()
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
