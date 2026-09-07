#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
let exitCode = 0;

try {
  run(process.execPath, ['scripts/dev-mode.mjs', 'npm']);
  run(pnpm, ['run', 'check']);
  run(pnpm, ['exec', 'quasar', 'build', '-m', 'electron']);
} catch (error) {
  exitCode = typeof error?.exitCode === 'number' ? error.exitCode : 1;
  console.error(`[mx-autotest] package failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try {
    run(process.execPath, ['scripts/dev-mode.mjs', 'local']);
  } catch (error) {
    exitCode ||= typeof error?.exitCode === 'number' ? error.exitCode : 1;
    console.error(`[mx-autotest] could not restore local mode: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(exitCode);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}
