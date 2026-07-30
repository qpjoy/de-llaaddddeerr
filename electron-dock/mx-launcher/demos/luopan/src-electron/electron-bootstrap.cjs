const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const {
  markElectronLauncherAsarLaunchFailed,
  selectElectronLauncherAsar
} = require('@qpjoy/electron-launcher/asar-bootstrap');

const componentId = 'luopan';
const baseDir = app.getPath('userData');
const basePackageRoot = __dirname;
const basePackageJson = resolveBasePackageJson(basePackageRoot);
const baseVersion = readPackageVersion(basePackageJson) || app.getVersion();
const baseEntry = path.join(basePackageRoot, 'electron-main.js');
const selected = selectElectronLauncherAsar({
  baseDir,
  componentId,
  baseVersion
});

process.env.MX_LAUNCHER_BASE_APP_VERSION = baseVersion;
if (basePackageJson) process.env.MX_LAUNCHER_BASE_PACKAGE_JSON = basePackageJson;

void loadEntry(selected.active ? selected.path : null).catch(async (error) => {
  if (!selected.active || !selected.path) {
    console.error('[luopan] base Electron entry failed:', error);
    app.exit(1);
    return;
  }
  markElectronLauncherAsarLaunchFailed({
    baseDir,
    componentId,
    baseVersion,
    activePath: selected.path,
    reason: error instanceof Error ? error.message : String(error)
  });
  delete process.env.MX_LAUNCHER_ACTIVE_ASAR;
  delete process.env.MX_LAUNCHER_ACTIVE_ASAR_VERSION;
  console.warn('[luopan] ASAR entry failed; loading the installed base:', error);
  try {
    await import(pathToFileURL(baseEntry).href);
  } catch (fallbackError) {
    console.error('[luopan] installed base entry failed:', fallbackError);
    app.exit(1);
  }
});

async function loadEntry(asarPath) {
  if (!asarPath) {
    await import(pathToFileURL(baseEntry).href);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(asarPath, 'package.json'), 'utf8'));
  const main = typeof manifest.main === 'string' && manifest.main.trim()
    ? manifest.main.trim()
    : 'electron-main.js';
  process.env.MX_LAUNCHER_ACTIVE_ASAR = asarPath;
  process.env.MX_LAUNCHER_ACTIVE_ASAR_VERSION = selected.version;
  await import(pathToFileURL(path.join(asarPath, main)).href);
}

function resolveBasePackageJson(root) {
  for (const candidate of [
    path.join(root, 'package.json'),
    path.resolve(root, '..', 'package.json'),
    path.resolve(root, '..', '..', 'package.json'),
    path.resolve(root, '..', '..', '..', 'package.json')
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readPackageVersion(filePath) {
  if (!filePath) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return typeof manifest.version === 'string' && manifest.version.trim()
      ? manifest.version.trim()
      : null;
  } catch {
    return null;
  }
}
