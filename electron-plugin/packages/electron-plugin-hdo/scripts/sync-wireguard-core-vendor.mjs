#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workspaceRoot = resolve(root, '..', '..');
const coreRoot = resolve(root, '..', 'electron-core-wireguard');
const coreDist = resolve(coreRoot, 'dist');
const outRoot = resolve(root, 'dist', 'vendor', 'electron-core-wireguard');
const corePkg = JSON.parse(readFileSync(resolve(coreRoot, 'package.json'), 'utf8'));

console.log(`[sync-wireguard-core-vendor] building ${corePkg.name}`);
execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', corePkg.name, 'build'], {
  cwd: workspaceRoot,
  stdio: 'inherit'
});
if (!existsSync(resolve(coreDist, 'index.js'))) {
  throw new Error(`WireGuard core dist not found at ${coreDist}`);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });
cpSync(coreDist, resolve(outRoot, 'dist'), { recursive: true });

writeFileSync(
  resolve(outRoot, 'package.json'),
  JSON.stringify(
    {
      name: corePkg.name,
      version: corePkg.version,
      type: corePkg.type,
      main: corePkg.main,
      types: corePkg.types,
      exports: corePkg.exports
    },
    null,
    2
  ) + '\n'
);

console.log(`[sync-wireguard-core-vendor] copied ${corePkg.name}@${corePkg.version}`);
