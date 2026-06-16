const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
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

function patchHdoWireGuardWindowsElevation(appDir) {
  const corePath = join(
    appDir,
    'node_modules',
    '@qpjoy',
    'electron-plugin-hdo',
    'dist',
    'vendor',
    'electron-core-wireguard',
    'dist',
    'index.js'
  );
  const visibleRunAs = '-Verb RunAs -Wait -PassThru';
  const hiddenRunAs = '-Verb RunAs -WindowStyle Hidden -Wait -PassThru';

  if (!existsSync(corePath)) {
    throw new Error(`HDO WireGuard vendor core is missing: ${corePath}`);
  }

  const source = readFileSync(corePath, 'utf8');
  if (source.includes(hiddenRunAs)) return false;
  if (!source.includes(visibleRunAs)) {
    throw new Error(`HDO WireGuard elevation command was not found in: ${corePath}`);
  }

  writeFileSync(corePath, source.replaceAll(visibleRunAs, hiddenRunAs));
  return true;
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
    if (context.electronPlatformName === 'win32') {
      const patched = patchHdoWireGuardWindowsElevation(dir);
      console.log(`[hdo] HDO WireGuard Windows elevation ${patched ? 'patched' : 'already hidden'}`);
    }
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
