#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: verify-wireguard-engine.mjs <platform-arch>');
  process.exit(2);
}

const names = target.startsWith('win32-')
  ? ['wg.exe', 'wg.exe.gz', 'wg', 'wg.gz']
  : ['wg', 'wg.gz'];
const root = join(process.cwd(), 'resources', 'wireguard', target);
const found = names
  .map((name) => join(root, name))
  .find((path) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0);

if (!found) {
  console.error(`Missing WireGuard CLI for ${target}.`);
  console.error(`Expected one of: ${names.map((name) => join('resources', 'wireguard', target, name)).join(', ')}`);
  console.error('Add the real wg/wg.exe binary before packing or publishing this engine package.');
  process.exit(1);
}

console.log(`WireGuard CLI found for ${target}: ${found}`);
