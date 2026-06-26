#!/usr/bin/env node
import { spawn } from 'node:child_process';

const env = { ...process.env };
for (const key of ['NODE_OPTIONS', 'NPM_CONFIG_NODE_OPTIONS', 'npm_config_node_options']) {
  if (!env[key]) continue;
  const next = env[key]
    .split(/\s+/)
    .filter((part) => part && !/^--no-expose-wasm(?:=.*)?$/.test(part))
    .join(' ');
  if (next) env[key] = next;
  else delete env[key];
}
delete env.ELECTRON_RUN_AS_NODE;

const command = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const child = spawn(command, ['.'], {
  cwd: new URL('..', import.meta.url),
  env,
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
