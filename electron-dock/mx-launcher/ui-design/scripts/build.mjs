import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });

for (const asset of ['styles.css', 'tokens.css', 'tokens.json']) {
  await copyFile(join(root, 'src', asset), join(dist, asset));
}
