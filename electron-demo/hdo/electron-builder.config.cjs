const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadProjectEnv } = require('./src/env.cjs');

loadProjectEnv({ appDir: __dirname });

const packagedServerBaseUrl = (
  process.env.QPJOY_HDO_SERVER ||
  process.env.QPJOY_MARKET_SERVER ||
  ''
).trim().replace(/\/+$/, '');

const shouldNotarize = Boolean(
  process.env.HDO_NOTARIZE === '1' ||
  process.env.APPLE_ID ||
  process.env.APPLE_API_KEY ||
  process.env.APPLE_API_KEY_ID
);

function appContentDir(context) {
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  return join(resourcesDir, 'app');
}

module.exports = {
  appId: 'dev.qpjoy.hdo',
  productName: 'MX HDO',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  asar: false,
  directories: {
    output: 'out/electron-builder'
  },
  files: [
    'package.json',
    'src/**/*'
  ],
  publish: null,
  afterPack: async (context) => {
    const dir = appContentDir(context);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'qpjoy-hdo.config.json'),
      JSON.stringify({ serverBaseUrl: packagedServerBaseUrl }, null, 2)
    );
  },
  mac: {
    target: ['zip', 'dmg'],
    category: 'public.app-category.business',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    x64ArchFiles: '**/node_modules/@qpjoy/electron-plugin-hdo/resources/wireguard/darwin-{arm64,x64}/**/*',
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    ...(shouldNotarize ? { notarize: true } : {})
  },
  dmg: {
    sign: true
  },
  win: {
    target: [
      {
        target: 'zip',
        arch: ['x64']
      },
      {
        target: 'nsis',
        arch: ['x64']
      }
    ],
    executableName: 'mx-hdo',
    signAndEditExecutable: true,
    requestedExecutionLevel: 'asInvoker'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true
  }
};
