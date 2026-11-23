#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  {
    source: resolve(repoRoot, 'scripts/wireguard.sh'),
    target: resolve(packageRoot, 'resources/wireguard.sh'),
    label: 'wireguard.sh',
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

// Edge stacks run some repository files unchanged (STACK_VENDOR in each
// resources/edge/stacks/<name>/stack.env). The npm package carries copies under
// resources/edge/vendor/<repository path>; a source checkout reads the
// repository directly. The copies are not committed (.gitignore).
const stacksDir = resolve(packageRoot, 'resources/edge/stacks');
for (const stack of existsSync(stacksDir) ? readdirSync(stacksDir) : []) {
  const manifest = resolve(stacksDir, stack, 'stack.env');
  if (!existsSync(manifest)) continue;
  const line = readFileSync(manifest, 'utf8').split('\n').find((entry) => entry.startsWith('STACK_VENDOR='));
  const files = line ? line.slice('STACK_VENDOR='.length).replace(/^"|"$/g, '').split(/\s+/).filter(Boolean) : [];
  for (const file of files) {
    const source = resolve(repoRoot, file);
    const target = resolve(packageRoot, 'resources/edge/vendor', file);
    if (!existsSync(source)) {
      if (existsSync(target)) {
        console.log(`Using existing vendored ${file} for stack ${stack}`);
        continue;
      }
      throw new Error(`Cannot package @qpjoy/tunnel-cli; stack ${stack} needs ${source}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode & 0o777);
    console.log(`Vendored ${file} for stack ${stack}`);
  }
}
