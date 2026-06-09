#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mxRoot = resolve(scriptDir, '../..');
const args = process.argv.slice(2);
const fromLocal = optionValue('--from-local');
const targetDir = resolve(optionValue('--target-dir') || join(mxRoot, 'site-slots/domestic/qp-tunnel-cli'));
const tempDir = resolve(optionValue('--temp-dir') || join(mxRoot, '.tmp/site-slot-tunnel-cli-refresh'));
const requestedVersion = optionValue('--version') || positionalArgs()[0] || 'latest';

const requiredFiles = [
  'package.json',
  'README.md',
  'README.setup.md',
  'dist/index.js',
  'dist/hdo.js',
  'dist/index.d.ts',
  'dist/hdo.d.ts',
  'resources/mihomo-client.sh'
];

const sourceDir = fromLocal ? resolve(fromLocal) : fetchFromNpm();
const packageJson = readPackageJson(sourceDir);
copyFallbackSource(sourceDir, targetDir);
writeFileSync(join(targetDir, 'refresh-metadata.json'), JSON.stringify({
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  requestedVersion,
  source: fromLocal ? 'local' : 'npm-pack',
  officialInstallCommand: 'npm i -g @qpjoy/tunnel-cli',
  refreshedAt: new Date().toISOString()
}, null, 2));

console.log(JSON.stringify({
  ok: true,
  targetDir,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  officialInstallCommand: 'npm i -g @qpjoy/tunnel-cli',
  fallbackUsage: 'no-outbound bootstrap only'
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
  return index >= 0 ? args[index + 1] : null;
}

function positionalArgs() {
  const out = [];
  const optionsWithValue = new Set(['--from-local', '--target-dir', '--temp-dir', '--version']);
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
