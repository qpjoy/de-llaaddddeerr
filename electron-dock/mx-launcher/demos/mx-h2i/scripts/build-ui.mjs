import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanElectronNodeEnv } from './node-env.mjs';

const uiRoot = fileURLToPath(new URL('../ui/', import.meta.url));
const commands = [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['node_modules/vite/bin/vite.js', 'build'],
];
for (const [entry, ...args] of commands) {
  const file = fileURLToPath(new URL(entry, new URL('../ui/', import.meta.url)));
  if (!existsSync(file)) {
    console.error('MinCave UI dependencies are missing. Run: npm --prefix ui ci');
    process.exit(1);
  }
  const child = spawnSync(process.execPath, [file, ...args], {
    cwd: uiRoot,
    env: cleanElectronNodeEnv(),
    stdio: 'inherit',
  });
  if (child.status !== 0) process.exit(child.status || 1);
}
