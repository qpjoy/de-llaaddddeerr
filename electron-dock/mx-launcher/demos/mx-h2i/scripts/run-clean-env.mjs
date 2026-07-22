#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';

import { cleanElectronNodeEnv } from './node-env.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/run-clean-env.mjs <command> [...args]');
  process.exit(2);
}

const childEnv = cleanElectronNodeEnv();
if (process.platform === 'win32' && !windowsPowerShellIsAvailable(childEnv)) {
  console.error([
    'MX-H2I Windows packaging requires Windows PowerShell 5.1 (powershell.exe).',
    'electron-builder uses it to collect pnpm production dependencies.',
    'Expected location: %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'Restore Windows PowerShell or add that directory to PATH, then run pnpm make:win again.'
  ].join('\n'));
  process.exit(1);
}

const child = spawn(command, args, {
  cwd: new URL('..', import.meta.url),
  env: childEnv,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

function windowsPowerShellIsAvailable(env) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'exit 0'
  ], {
    env,
    stdio: 'ignore',
    windowsHide: true
  });
  return !result.error && result.status === 0;
}
