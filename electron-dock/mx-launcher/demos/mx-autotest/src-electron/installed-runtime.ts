import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as ElectronLauncher from '@qpjoy/electron-launcher';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const basePackageJson = process.env.MX_LAUNCHER_BASE_PACKAGE_JSON
  || path.join(currentDir, 'package.json');
const baseRequire = createRequire(basePackageJson);

const launcher = await importInstalledPackage('@qpjoy/electron-launcher') as typeof ElectronLauncher;

export const {
  applyElectronLauncherStandaloneDataPlane,
  createElectronLauncher,
  createLauncherWireGuardKeyPair,
  defineLauncherProduct,
  loadElectronLauncherEnvFiles,
  parseElectronLauncherBootstrapUrls,
  resolveElectronLauncherBootstrap,
  stopElectronLauncherStandaloneDataPlane
} = launcher;

async function importInstalledPackage(specifier: string): Promise<Record<string, unknown>> {
  const packageName = packageNameFromSpecifier(specifier);
  const manifestPath = baseRequire.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    main?: string;
    exports?: Record<string, string | Record<string, string>>;
  };
  const exportKey = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`;
  const declaration = manifest.exports?.[exportKey];
  const relativeEntry = typeof declaration === 'string'
    ? declaration
    : declaration?.import || declaration?.default || declaration?.require;
  const entry = relativeEntry || (specifier === packageName ? manifest.main : null);
  if (!entry) throw new Error(`Installed package has no runtime export for ${specifier}`);
  const imported = await import(pathToFileURL(path.resolve(path.dirname(manifestPath), entry)).href);
  const defaultExport = imported.default && typeof imported.default === 'object'
    ? imported.default as Record<string, unknown>
    : {};
  return { ...defaultExport, ...imported };
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
