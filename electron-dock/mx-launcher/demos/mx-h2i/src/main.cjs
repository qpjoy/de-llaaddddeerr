const Module = require('node:module');
const path = require('node:path');
const { app } = require('electron');

const componentId = 'mx-h2i';
const baseDir = app.getPath('userData');
const baseVersion = app.getVersion();
const currentPackageRoot = path.resolve(__dirname, '..');
const activeAsar = process.env.MX_LAUNCHER_ACTIVE_ASAR || process.env.MX_H2I_ACTIVE_ASAR;
const alreadySelected = activeAsar === currentPackageRoot;

if (alreadySelected) {
  // ASARs built for the first 2.1.2 bootstrap only receive the MX-H2I names.
  // Promote them to the generic names before the shared runtime initializes.
  process.env.MX_LAUNCHER_ACTIVE_ASAR ||= process.env.MX_H2I_ACTIVE_ASAR;
  process.env.MX_LAUNCHER_ACTIVE_ASAR_VERSION ||= process.env.MX_H2I_ACTIVE_ASAR_VERSION;
  process.env.MX_LAUNCHER_BASE_APP_VERSION ||= process.env.MX_H2I_BASE_APP_VERSION;
  module.exports = require('./main-runtime.cjs');
} else {
  const {
    markElectronLauncherAsarLaunchFailed,
    selectElectronLauncherAsar
  } = require('@qpjoy/electron-launcher/asar-bootstrap');
  const selected = selectElectronLauncherAsar({
    baseDir,
    componentId,
    baseVersion
  });
  if (!selected.active) {
    module.exports = require('./main-runtime.cjs');
  } else {
    const baseNodeModules = path.join(currentPackageRoot, 'node_modules');
    process.env.NODE_PATH = [baseNodeModules, process.env.NODE_PATH]
      .filter(Boolean)
      .join(path.delimiter);
    Module._initPaths();
    process.env.MX_LAUNCHER_ACTIVE_ASAR = selected.path;
    process.env.MX_LAUNCHER_ACTIVE_ASAR_VERSION = selected.version;
    process.env.MX_LAUNCHER_BASE_APP_VERSION = baseVersion;
    process.env.MX_LAUNCHER_BASE_PACKAGE_JSON = path.join(currentPackageRoot, 'package.json');
    // Keep the 2.1.2 ASAR contract until all installed bases have upgraded.
    process.env.MX_H2I_ACTIVE_ASAR = selected.path;
    process.env.MX_H2I_ACTIVE_ASAR_VERSION = selected.version;
    process.env.MX_H2I_BASE_APP_VERSION = baseVersion;
    try {
      module.exports = require(selected.path);
    } catch (error) {
      markElectronLauncherAsarLaunchFailed({
        baseDir,
        componentId,
        baseVersion,
        activePath: selected.path,
        reason: error instanceof Error ? error.message : String(error)
      });
      delete process.env.MX_H2I_ACTIVE_ASAR;
      delete process.env.MX_H2I_ACTIVE_ASAR_VERSION;
      delete process.env.MX_H2I_BASE_APP_VERSION;
      delete process.env.MX_LAUNCHER_ACTIVE_ASAR;
      delete process.env.MX_LAUNCHER_ACTIVE_ASAR_VERSION;
      delete process.env.MX_LAUNCHER_BASE_APP_VERSION;
      module.exports = require('./main-runtime.cjs');
    }
  }
}
