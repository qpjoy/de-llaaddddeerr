#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

const command = process.argv[2] ?? 'help';

function help(): void {
  process.stdout.write(`QPJoy Electron Tunnel CLI

Usage:
  qpjoy-tunnel help
  qpjoy-tunnel snippet
  qpjoy-tunnel init [--out <path>]

Commands:
  snippet   Print the minimal Electron main-process integration.
  init      Create a small integration module in the current project.
`);
}

function snippet(): string {
  return `import { app, ipcMain, session } from 'electron'
import { createElectronTunnel } from '@qpjoy/electron-plugin-tunnel'

const tunnel = createElectronTunnel(
  { app, ipcMain, session: session.defaultSession },
  {
    adminPort: 23456,
    controllerPort: 23457,
    mixedPort: 23458,
    dnsPort: 23459
  }
)

app.whenReady().then(async () => {
  await tunnel.applyProxy()
})

app.on('before-quit', () => {
  tunnel.close()
})
`;
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function init(): void {
  const outPath = resolve(process.cwd(), argValue('--out') ?? 'src-electron/qpjoy-tunnel.ts');
  if (existsSync(outPath)) {
    throw new Error(`File already exists: ${outPath}`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, snippet(), 'utf8');
  process.stdout.write(`Created ${outPath}

Next steps:
  1. Import this module from your Electron main process.
  2. Add the QPJoy tunnel engine resources to your Electron package config.

electron-builder example:
  extraResources: [
    {
      from: 'node_modules/@qpjoy/electron-plugin-tunnel/resources/engine',
      to: 'qpjoy-tunnel-engine',
      filter: ['**/*']
    }
  ]
`);
}

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    help();
  } else if (command === 'snippet') {
    process.stdout.write(snippet());
  } else if (command === 'init') {
    init();
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    help();
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
