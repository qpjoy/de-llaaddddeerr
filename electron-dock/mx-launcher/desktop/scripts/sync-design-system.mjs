// Ship the canonical Neon Void source unchanged to every desktop/static build.
import { mkdir, copyFile, readFile } from 'node:fs/promises';
const canonical = new URL('../../ui-design/src/', import.meta.url);
const output = new URL('../ui-design/', import.meta.url);
const assets = ['styles.css', 'tokens.css', 'select.css', 'select.js'];
await mkdir(output, { recursive: true });
for (const asset of assets) {
  const from = new URL(asset, canonical), to = new URL(asset, output);
  if (process.argv.includes('--check')) {
    if (!(await readFile(from)).equals(await readFile(to))) throw new Error(`Neon Void asset drift: ${asset}; run pnpm --dir desktop run sync:design`);
  } else await copyFile(from, to);
}
console.log('[mx-launcher] Neon Void assets synchronized');
