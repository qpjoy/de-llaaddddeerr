import { readFileSync } from 'node:fs';

const { engines } = JSON.parse(readFileSync(new URL('../ui/package.json', import.meta.url), 'utf8'));
const minimum = engines.node.match(/^>=(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
if (!minimum) throw new Error(`Unsupported MinCave UI Node.js requirement: ${engines.node}`);

export function assertUiNodeVersion(version = process.versions.node) {
  const current = version.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (current[index] > minimum[index]) return;
    if (current[index] < minimum[index]) break;
    if (index === minimum.length - 1) return;
  }
  throw new Error(
    `MinCave UI requires Node.js ${engines.node}; current version is ${version}. ` +
    'Upgrade Node.js, reopen the terminal, verify node --version, then retry pnpm make:win (or the original build command).',
  );
}
