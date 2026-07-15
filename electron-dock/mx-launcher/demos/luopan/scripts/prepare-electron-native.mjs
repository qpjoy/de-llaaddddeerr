import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.join(projectDir, '.electron-native');
const markerPath = path.join(nativeRoot, 'ready.json');
const projectPackage = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
const electronVersion = String(projectPackage.devDependencies?.electron || '').replace(/^[^0-9]*/, '');
if (!electronVersion) throw new Error('Luopan devDependencies.electron must contain an exact Electron version.');

const projectRequire = createRequire(path.join(projectDir, 'package.json'));
const tunnelPackagePath = projectRequire.resolve('@qpjoy/electron-plugin-tunnel/package.json');
const tunnelRequire = createRequire(tunnelPackagePath);
const betterSqlitePackagePath = tunnelRequire.resolve('better-sqlite3/package.json');
const betterSqliteRequire = createRequire(betterSqlitePackagePath);
const betterSqlitePackage = JSON.parse(await readFile(betterSqlitePackagePath, 'utf8'));
const fingerprint = {
  preparationRevision: 2,
  electronVersion,
  betterSqliteVersion: String(betterSqlitePackage.version),
  platform: process.platform,
  arch: process.arch
};

try {
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const nativeBinary = path.join(nativeRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  await readFile(nativeBinary);
  if (JSON.stringify(marker) === JSON.stringify(fingerprint)) {
    console.log(`[luopan] Electron native runtime ready (${process.platform}-${process.arch}, Electron ${electronVersion}).`);
    process.exit(0);
  }
} catch {
  // Missing or stale marker: recreate the isolated native dependency below.
}

await rm(nativeRoot, { recursive: true, force: true });
await mkdir(path.join(nativeRoot, 'node_modules'), { recursive: true });
for (const moduleName of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  const packagePath = moduleName === 'better-sqlite3'
    ? betterSqlitePackagePath
    : betterSqliteRequire.resolve(`${moduleName}/package.json`);
  await cp(path.dirname(packagePath), path.join(nativeRoot, 'node_modules', moduleName), {
    recursive: true,
    dereference: true
  });
}
await writeFile(path.join(nativeRoot, 'package.json'), `${JSON.stringify({
  private: true,
  dependencies: { 'better-sqlite3': betterSqlitePackage.version }
}, null, 2)}\n`, { mode: 0o600 });

const electronBuilderPath = projectRequire.resolve('electron-builder');
const builderRequire = createRequire(electronBuilderPath);
const { rebuild } = builderRequire('@electron/rebuild');
process.env.npm_config_devdir ||= path.join(nativeRoot, '.electron-gyp');
await rebuild({
  buildPath: nativeRoot,
  // Keep electron-rebuild from walking the parent pnpm workspace and
  // rebuilding its shared Node-native copy with Electron's ABI.
  projectRootPath: nativeRoot,
  electronVersion,
  force: true,
  onlyModules: ['better-sqlite3']
});
const betterSqliteTarget = path.join(nativeRoot, 'node_modules', 'better-sqlite3');
for (const relativePath of [
  'bin',
  'deps',
  'src',
  'node_modules',
  'binding.gyp',
  'build/Makefile',
  'build/binding.Makefile',
  'build/config.gypi',
  'build/better_sqlite3.target.mk',
  'build/test_extension.target.mk',
  'build/Release/obj.target',
  'build/Release/obj',
  'build/Release/sqlite3.a',
  'build/Release/test_extension.node'
]) {
  await rm(path.join(betterSqliteTarget, relativePath), { recursive: true, force: true });
}
await writeFile(markerPath, `${JSON.stringify(fingerprint, null, 2)}\n`, { mode: 0o600 });
console.log(`[luopan] Prepared isolated better-sqlite3 ${betterSqlitePackage.version} for Electron ${electronVersion}.`);
