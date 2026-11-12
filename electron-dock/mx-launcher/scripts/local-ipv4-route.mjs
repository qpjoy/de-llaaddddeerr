import { spawnSync } from 'node:child_process';
import { isIPv4 } from 'node:net';

export function hasLocalIPv4Route(address, run = spawnSync) {
  if (!isIPv4(address)) return false;
  const result = run('ip', ['-4', 'route', 'get', address], { encoding: 'utf8', timeout: 3000 });
  if (result.status !== 0 || !result.stdout) return false;
  const [type, destination] = result.stdout.trim().split(/\s+/, 2);
  return type === 'local' && destination === address;
}
