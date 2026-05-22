#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const coreRoot = resolve(root, '..', 'electron-core-wireguard');
const coreDist = resolve(coreRoot, 'dist');
const outRoot = resolve(root, 'dist', 'vendor', 'electron-core-wireguard');

if (!existsSync(resolve(coreDist, 'index.js'))) {
  throw new Error(`WireGuard core dist not found at ${coreDist}; build @qpjoy/electron-core-wireguard first.`);
}

const corePkg = JSON.parse(readFileSync(resolve(coreRoot, 'package.json'), 'utf8'));

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
