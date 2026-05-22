#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const enginesRoot = resolve(root, '..', 'wireguard-engines');
const outRoot = resolve(root, 'resources', 'wireguard');

const engines = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64'
];

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

let copied = 0;
for (const engine of engines) {
  const src = resolve(enginesRoot, engine, 'resources', 'wireguard', engine);
  if (!existsSync(src)) continue;
  cpSync(src, resolve(outRoot, engine), { recursive: true });
  copied += 1;
}

if (copied === 0) {
  throw new Error(`No WireGuard engine resources found under ${enginesRoot}`);
}

console.log(`[sync-wireguard-resources] copied ${copied} engine resource set(s)`);
