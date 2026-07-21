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
  extraResources: [
    {
      from: 'scripts/repair-macos-dns.sh',
      to: 'repair/repair-macos-dns.sh'
    },
    {
      from: '../../../../electron-plugin/packages/wireguard-engines/darwin-arm64/resources/wireguard/darwin-arm64',
      to: 'wireguard/darwin-arm64'
    },
    {
      from: '../../../../electron-plugin/packages/wireguard-engines/darwin-x64/resources/wireguard/darwin-x64',
      to: 'wireguard/darwin-x64'
    },
    {
      from: '../../../../electron-plugin/packages/wireguard-engines/linux-arm64/resources/wireguard/linux-arm64',
      to: 'wireguard/linux-arm64'
    },
    {
      from: '../../../../electron-plugin/packages/wireguard-engines/linux-x64/resources/wireguard/linux-x64',
      to: 'wireguard/linux-x64'
    },
    {
      from: '../../../../electron-plugin/packages/wireguard-engines/win32-x64/resources/wireguard/win32-x64',
      to: 'wireguard/win32-x64'
    }
  ],
  toolsets: {
    // The legacy winCodeSign archive contains macOS symlinks and requires
    // elevated Windows privileges just to unpack. The Windows Kits bundle
    // avoids that host-specific extraction failure.
    winCodeSign: '1.0.0'
  },
  publish: null,
  mac: {
    target: ['zip', 'dmg'],
    category: 'public.app-category.business',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    x64ArchFiles: '**/wireguard/darwin-{arm64,x64}/**/*',
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
