import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const tunnelCliDegradedFallbackFiles = [
  'package.json',
  'README.md',
  'README.setup.md',
  'resources/mihomo-client.sh'
];

export const tunnelCliFullFallbackFiles = [
  ...tunnelCliDegradedFallbackFiles,
  'dist/index.js',
  'dist/hdo.js',
  'dist/h2i.js',
  'dist/open.js',
  'dist/wg.js',
  'dist/index.d.ts',
  'dist/hdo.d.ts',
  'dist/h2i.d.ts',
  'dist/open.d.ts',
  'dist/wg.d.ts',
  'resources/manage.sh',
  'resources/openvpn-server.sh',
  'resources/openvpn-client.sh',
  'resources/wireguard.sh',
  'resources/china-ipv4-coarse.txt'
];

export const tunnelCliExecutableFiles = [
  'resources/mihomo-client.sh',
  'resources/manage.sh',
  'resources/openvpn-server.sh',
  'resources/openvpn-client.sh',
  'resources/wireguard.sh'
];

export function tunnelCliFullFallbackReady(sourceRoot) {
  return tunnelCliFullFallbackFiles.every((file) => existsSync(join(sourceRoot, file)));
}
