import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPackage } from '@electron/asar';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const platform = normalizePlatform(requiredArg('platform', args.platform));
const arch = normalizeArch(requiredArg('arch', args.arch));
const packageJson = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
const version = normalizeVersion(requiredArg('version', args.version));
const outputDir = path.resolve(projectDir, args.outputDir || 'out/release-asar');
const stagingDir = path.join(outputDir, `.staging-${process.pid}-${platform}-${arch}`);
const fileName = `MX-H2I-${version}-${platform}-${arch}-app.asar`;
const outputPath = path.join(outputDir, fileName);

await mkdir(outputDir, { recursive: true });
await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });
try {
  await cp(path.join(projectDir, 'src'), path.join(stagingDir, 'src'), { recursive: true });
  await writeFile(path.join(stagingDir, 'package.json'), `${JSON.stringify({
    name: packageJson.name,
    productName: packageJson.productName,
    version,
    private: true,
    main: 'src/main.cjs'
  }, null, 2)}\n`, 'utf8');
  await rm(outputPath, { force: true });
  await createPackage(stagingDir, outputPath);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}

const outputStat = await stat(outputPath);
const digest = `sha256:${await sha256File(outputPath)}`;
const manifest = {
  productId: 'mx-h2i',
  packageName: packageJson.name,
  kind: 'app-asar',
  componentId: 'mx-h2i',
  version,
  platform,
  arch,
  fileName,
  sizeBytes: outputStat.size,
  digest,
  activation: 'restart-auto',
  baseCompatibility: {
    minimumVersion: packageJson.version,
    nativeDependencies: 'inherited-from-full-installer'
  }
};
await writeFile(`${outputPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, artifact: outputPath, manifest: `${outputPath}.json`, ...manifest }, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const [rawKey, inlineValue] = item.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      parsed[key] = argv[index + 1];
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function requiredArg(name, value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing --${name}`);
}

function normalizeVersion(value) {
  const version = String(value).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid --version: ${value}`);
  }
  return version;
}

function normalizePlatform(value) {
  const platform = String(value).trim().toLowerCase();
  if (platform === 'mac' || platform === 'macos' || platform === 'darwin') return 'darwin';
  if (platform === 'win' || platform === 'windows' || platform === 'win32') return 'win32';
  throw new Error(`Unsupported --platform: ${value}`);
}

function normalizeArch(value) {
  const arch = String(value).trim().toLowerCase();
  if (arch === 'amd64' || arch === 'x86_64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  if (['x64', 'arm64', 'ia32', 'universal'].includes(arch)) return arch;
  throw new Error(`Unsupported --arch: ${value}`);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}
