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
  {
    source: resolve(repoRoot, 'scripts/openvpn-server.sh'),
    target: resolve(packageRoot, 'resources/openvpn-server.sh'),
    label: 'openvpn-server.sh',
  },
  {
    source: resolve(repoRoot, 'scripts/openvpn-client.sh'),
    target: resolve(packageRoot, 'resources/openvpn-client.sh'),
    label: 'openvpn-client.sh',
  },
  // Shipped so `open egress on --mode cn-direct` has a China prefix list
  // without reaching the network. The coarse list is small enough to install as
  // kernel routes; the full list stays in the repository for hosts that want it
  // through --cn-routes.
  {
    source: resolve(repoRoot, 'ovpn/china-ipv4-coarse.txt'),
    target: resolve(packageRoot, 'resources/china-ipv4-coarse.txt'),
    label: 'china-ipv4-coarse.txt',
    mode: 0o644,
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
  chmodSync(resource.target, resource.mode ?? 0o755);

  console.log(`Copied ${resource.source} -> ${resource.target}`);
}
