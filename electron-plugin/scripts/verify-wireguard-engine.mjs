#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: verify-wireguard-engine.mjs <platform-arch>');
  process.exit(2);
}

const root = join(process.cwd(), 'resources', 'wireguard', target);
const requiredGroups = target.startsWith('win32-')
  ? [
      ['wg.exe', 'wg.exe.gz', 'wg', 'wg.gz'],
      ['wireguard.exe', 'wireguard.exe.gz']
    ]
  : target.startsWith('darwin-')
    ? [
        ['wg', 'wg.gz'],
        ['wireguard-go', 'wireguard-go.gz']
      ]
    : [
        ['wg', 'wg.gz'],
        ['wg-quick', 'wg-quick.gz']
      ];

const found = [];
const missing = [];
for (const group of requiredGroups) {
  const match = group
    .map((name) => join(root, name))
    .find((path) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0);
  if (match) found.push(match);
  else missing.push(group);
}

if (missing.length > 0) {
  console.error(`Missing WireGuard runtime tools for ${target}.`);
  for (const group of missing) {
    console.error(`Expected one of: ${group.map((name) => join('resources', 'wireguard', target, name)).join(', ')}`);
  }
  console.error('Add real WireGuard runtime binaries before packing or publishing this engine package.');
  process.exit(1);
}

console.log(`WireGuard runtime tools found for ${target}:`);
for (const path of found) console.log(`- ${path}`);
