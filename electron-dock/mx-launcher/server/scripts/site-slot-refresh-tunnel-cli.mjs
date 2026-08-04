#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mxRoot = resolve(scriptDir, '../..');
const args = process.argv.slice(2);
const fromLocal = optionValue('--from-local');
const fromTarball = optionValue('--from-tarball') || optionValue('--tarball');
const targetDir = resolve(optionValue('--target-dir') || join(mxRoot, 'site-slots/domestic/qp-tunnel-cli'));
const tempDir = resolve(optionValue('--temp-dir') || join(mxRoot, '.tmp/site-slot-tunnel-cli-refresh'));
const requestedVersion = optionValue('--version') || positionalArgs()[0] || (fromTarball ? 'tarball' : 'latest');

if (fromLocal && fromTarball) die('Use only one of --from-local DIR or --from-tarball FILE');

const requiredFiles = [
  'package.json',
  'README.md',
  'README.setup.md',
  'dist/index.js',
  'dist/hdo.js',
  'dist/h2i.js',
  'dist/index.d.ts',
  'dist/hdo.d.ts',
  'dist/h2i.d.ts',
  'resources/mihomo-client.sh',
  'resources/manage.sh'
];

const sourceDir = fromLocal ? resolve(fromLocal) : fromTarball ? fetchFromTarball(fromTarball) : fetchFromNpm();
const packageJson = readPackageJson(sourceDir);
const source = fromLocal ? 'local' : fromTarball ? 'tarball' : 'npm-pack';
const sourceReference = fromLocal
  ? resolve(fromLocal)
  : fromTarball
    ? resolve(fromTarball)
    : `@qpjoy/tunnel-cli@${requestedVersion}`;
copyFallbackSource(sourceDir, targetDir);
writeFileSync(join(targetDir, 'refresh-metadata.json'), JSON.stringify({
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  requestedVersion: requestedVersion === 'tarball' ? packageJson.version : requestedVersion,
  source,
  sourceReference,
  officialInstallCommand: 'npm i -g @qpjoy/tunnel-cli@latest --force',
  refreshedAt: new Date().toISOString()
}, null, 2));

console.log(JSON.stringify({
  ok: true,
  targetDir,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  source,
  sourceReference,
  officialInstallCommand: 'npm i -g @qpjoy/tunnel-cli@latest --force',
  fallbackUsage: 'Internal-pushed no-node/no-outbound bootstrap first, optional npm refresh after egress-on'
}, null, 2));

function fetchFromNpm() {
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  const spec = `@qpjoy/tunnel-cli@${requestedVersion}`;
  const output = execFileSync('npm', ['pack', spec, '--pack-destination', tempDir, '--silent'], {
    cwd: mxRoot,
    encoding: 'utf8'
  }).trim();
  const tarballName = output.split('\n').filter(Boolean).at(-1);
  if (!tarballName) die(`npm pack did not return a tarball for ${spec}`);
  const tarball = join(tempDir, tarballName);
  execFileSync('tar', ['-xzf', tarball, '-C', tempDir], {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  });
  return join(tempDir, 'package');
}

function fetchFromTarball(tarballPath) {
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  execFileSync('tar', ['-xzf', resolve(tarballPath), '-C', tempDir], {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  });
  return findExtractedPackageRoot(tempDir);
}

function findExtractedPackageRoot(extractRoot) {
  const packageRoot = join(extractRoot, 'package');
  if (existsSync(join(packageRoot, 'package.json'))) return packageRoot;
  if (existsSync(join(extractRoot, 'package.json'))) return extractRoot;
  for (const entry of readdirSync(extractRoot)) {
    const candidate = join(extractRoot, entry);
    if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'package.json'))) return candidate;
  }
  die(`Could not find package.json after extracting tarball into ${extractRoot}`);
}

function copyFallbackSource(sourceRoot, targetRoot) {
  for (const file of requiredFiles) {
    const source = join(sourceRoot, file);
    if (!existsSync(source)) die(`Missing required @qpjoy/tunnel-cli file: ${source}`);
  }
  rmSync(targetRoot, { recursive: true, force: true });
  for (const file of requiredFiles) {
    const source = join(sourceRoot, file);
    const target = join(targetRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    if (file === 'resources/mihomo-client.sh' || file === 'resources/manage.sh') chmodSync(target, 0o755);
  }
}

function readPackageJson(sourceRoot) {
  const packagePath = join(sourceRoot, 'package.json');
  if (!existsSync(packagePath)) die(`Missing package.json: ${packagePath}`);
  const parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (parsed.name !== '@qpjoy/tunnel-cli') {
    die(`Unexpected package name ${parsed.name}; expected @qpjoy/tunnel-cli`);
  }
  return parsed;
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) die(`Missing value for ${name}`);
  return value;
}

function positionalArgs() {
  const out = [];
  const optionsWithValue = new Set(['--from-local', '--from-tarball', '--tarball', '--target-dir', '--temp-dir', '--version']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('--')) out.push(arg);
  }
  return out;
}

function die(message) {
  console.error(message);
  process.exit(1);
}
