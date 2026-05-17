#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../../..');
const source = resolve(repoRoot, 'scripts/mihomo-client.sh');
const target = resolve(packageRoot, 'resources/mihomo-client.sh');

if (!existsSync(source)) {
  if (existsSync(target)) {
    console.log(`Using existing packaged script at ${target}`);
    process.exit(0);
  }
  throw new Error(`Cannot package @qpjoy/tunnel-cli; missing ${source}`);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
chmodSync(target, 0o755);

console.log(`Copied ${source} -> ${target}`);
