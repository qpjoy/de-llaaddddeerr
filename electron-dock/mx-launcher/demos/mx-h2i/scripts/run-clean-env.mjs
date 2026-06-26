#!/usr/bin/env node
import { spawn } from 'node:child_process';

import { cleanElectronNodeEnv } from './node-env.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/run-clean-env.mjs <command> [...args]');
  process.exit(2);
}

const child = spawn(command, args, {
  cwd: new URL('..', import.meta.url),
  env: cleanElectronNodeEnv(),
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
