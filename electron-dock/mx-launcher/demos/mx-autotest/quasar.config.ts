import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { configure } from 'quasar/wrappers';

const shouldNotarize = Boolean(
  process.env.MX_AUTOTEST_NOTARIZE === '1'
  || process.env.APPLE_ID
  || process.env.APPLE_API_KEY
  || process.env.APPLE_API_KEY_ID
);

const extraResources = existsSync('.env') ? [{ from: '.env', to: '.env' }] : [];

export default configure(() => ({
  supportTS: true,
  css: ['app.scss'],
  extras: ['material-icons'],
  build: {
    vueRouterMode: 'hash'
  },
  framework: {
    config: { dark: true },
    plugins: ['Notify']
  },
  devServer: {
    host: '127.0.0.1',
    port: 9032,
    open: false
  },
  electron: {
    bundler: 'builder',
    unPackagedInstallParams: ['install', '--prod', '--ignore-workspace'],
    preloadScripts: ['electron-preload'],
    builder: {
      appId: 'dev.qpjoy.mx-autotest',
      productName: 'MX AutoTest',
      artifactName: 'mx-autotest-${version}-${os}-${arch}.${ext}',
      extraMetadata: { main: 'electron-bootstrap.cjs' },
      beforePack: async () => {
        await copyFile(
          resolve('src-electron/electron-bootstrap.cjs'),
          resolve('dist/electron/UnPackaged/electron-bootstrap.cjs')
        );
      },
      directories: { output: 'dist/electron' },
      extraResources,
      mac: {
        icon: 'src-electron/icons/icon.png',
        target: ['dmg'],
        category: 'public.app-category.developer-tools',
        hardenedRuntime: true,
        gatekeeperAssess: false,
        entitlements: 'src-electron/entitlements.mac.plist',
        entitlementsInherit: 'src-electron/entitlements.mac.plist',
        ...(shouldNotarize ? { notarize: true } : {})
      },
      dmg: { sign: true },
      linux: {
        icon: 'src-electron/icons/icon.png',
        target: ['AppImage']
      },
      win: {
        icon: 'src-electron/icons/icon.png',
        target: ['nsis'],
        signAndEditExecutable: true,
        requestedExecutionLevel: 'asInvoker'
      }
    }
  }
}));
