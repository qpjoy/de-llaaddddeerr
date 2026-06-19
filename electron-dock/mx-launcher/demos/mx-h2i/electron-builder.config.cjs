const shouldNotarize = Boolean(
  process.env.MX_H2I_NOTARIZE === '1' ||
  process.env.APPLE_ID ||
  process.env.APPLE_API_KEY ||
  process.env.APPLE_API_KEY_ID
);

module.exports = {
  appId: 'dev.qpjoy.mx-h2i',
  productName: 'MX-H2I',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  asar: true,
  directories: {
    output: 'out/electron-builder'
  },
  files: [
    'package.json',
    'src/**/*'
  ],
  publish: null,
  mac: {
    target: ['zip', 'dmg'],
    category: 'public.app-category.business',
    hardenedRuntime: true,
    gatekeeperAssess: false,
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
    executableName: 'mx-h2i',
    signAndEditExecutable: true,
    requestedExecutionLevel: 'asInvoker'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true
  },
  linux: {
    target: ['dir']
  }
};
