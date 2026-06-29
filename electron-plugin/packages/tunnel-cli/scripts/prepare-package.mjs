#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../../..');
const resources = [
  {
    source: resolve(repoRoot, 'scripts/mihomo-client.sh'),
    target: resolve(packageRoot, 'resources/mihomo-client.sh'),
    label: 'mihomo-client.sh',
  },
  {
    source: resolve(repoRoot, 'scripts/tunnel-cli-bootstrap.sh'),
    target: resolve(packageRoot, 'resources/manage.sh'),
    label: 'manage.sh',
  },
];

for (const resource of resources) {
  if (!existsSync(resource.source)) {
    if (existsSync(resource.target)) {
      console.log(`Using existing packaged script at ${resource.target}`);
      continue;
    }
    throw new Error(`Cannot package @qpjoy/tunnel-cli; missing ${resource.source}`);
  }

  mkdirSync(dirname(resource.target), { recursive: true });
  copyFileSync(resource.source, resource.target);
  chmodSync(resource.target, 0o755);

  console.log(`Copied ${resource.source} -> ${resource.target}`);
}
