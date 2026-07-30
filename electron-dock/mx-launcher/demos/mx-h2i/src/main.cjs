const Module = require('node:module');
const path = require('node:path');
const { app } = require('electron');
const {
  markMxH2IAsarLaunchFailed,
  selectMxH2IAsar
} = require('./asar-update-bootstrap.cjs');

const componentId = 'mx-h2i';
const baseDir = app.getPath('userData');
const baseVersion = app.getVersion();
const currentPackageRoot = path.resolve(__dirname, '..');
const alreadySelected = process.env.MX_H2I_ACTIVE_ASAR === currentPackageRoot;

if (alreadySelected) {
  module.exports = require('./main-runtime.cjs');
} else {
  const selected = selectMxH2IAsar({
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
    process.env.MX_H2I_ACTIVE_ASAR = selected.path;
    process.env.MX_H2I_ACTIVE_ASAR_VERSION = selected.version;
    process.env.MX_H2I_BASE_APP_VERSION = baseVersion;
    try {
      module.exports = require(selected.path);
    } catch (error) {
      markMxH2IAsarLaunchFailed({
        baseDir,
        componentId,
        baseVersion,
        activePath: selected.path,
        reason: error instanceof Error ? error.message : String(error)
      });
      delete process.env.MX_H2I_ACTIVE_ASAR;
      delete process.env.MX_H2I_ACTIVE_ASAR_VERSION;
      delete process.env.MX_H2I_BASE_APP_VERSION;
      module.exports = require('./main-runtime.cjs');
    }
  }
}
