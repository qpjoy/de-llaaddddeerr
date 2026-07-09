import { configure } from 'quasar/wrappers';

// Signing/notarization activates automatically when release credentials are
// present (same contract as mx-h2i): Windows needs CSC_LINK + CSC_KEY_PASSWORD;
// macOS notarization needs APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
// (or an App Store Connect API key). Unset = unsigned dev build.
const shouldNotarize = Boolean(
  process.env.LUOPAN_NOTARIZE === '1' ||
  process.env.APPLE_ID ||
  process.env.APPLE_API_KEY ||
  process.env.APPLE_API_KEY_ID
);

export default configure(() => ({
  supportTS: true,
  css: ['app.scss'],
  extras: ['material-icons'],
  build: {
    vueRouterMode: 'hash'
  },
  framework: {
    config: {
      dark: true
    },
    plugins: ['Notify']
  },
  devServer: {
    host: '0.0.0.0',
    port: 9031,
    open: false
  },
  electron: {
    bundler: 'builder',
    preloadScripts: ['electron-preload'],
    builder: {
      appId: 'dev.qpjoy.luopan',
      productName: 'Luopan',
      directories: {
        output: 'dist/electron'
      },
      mac: {
        target: ['dmg'],
        category: 'public.app-category.business',
        hardenedRuntime: true,
        gatekeeperAssess: false,
        entitlements: 'src-electron/entitlements.mac.plist',
        entitlementsInherit: 'src-electron/entitlements.mac.plist',
        ...(shouldNotarize ? { notarize: true } : {})
      },
      dmg: {
        sign: true
      },
      linux: {
        target: ['AppImage']
      },
      win: {
        target: ['nsis'],
        signAndEditExecutable: true,
        requestedExecutionLevel: 'asInvoker'
      }
    }
  }
}));
