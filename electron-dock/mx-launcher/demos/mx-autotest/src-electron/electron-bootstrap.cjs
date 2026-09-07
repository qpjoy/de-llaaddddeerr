const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');

const baseEntry = path.join(__dirname, 'electron-main.js');

process.env.MX_LAUNCHER_BASE_APP_VERSION = app.getVersion();
process.env.MX_LAUNCHER_BASE_PACKAGE_JSON = resolveBasePackageJson(__dirname) || '';

void import(pathToFileURL(baseEntry).href).catch((error) => {
  console.error('[mx-autotest] Electron entry failed:', error);
  app.exit(1);
});

function resolveBasePackageJson(root) {
  for (const candidate of [
    path.join(root, 'package.json'),
    path.resolve(root, '..', 'package.json'),
    path.resolve(root, '..', '..', 'package.json'),
    path.resolve(root, '..', '..', '..', 'package.json')
  ]) {
    try {
      require('node:fs').accessSync(candidate);
      return candidate;
    } catch {
      // Try the next packaged/unpackaged layout.
    }
  }
  return null;
}
