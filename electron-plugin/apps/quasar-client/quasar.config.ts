import { configure } from 'quasar/wrappers';
import { fileURLToPath } from 'node:url';

const tunnelRuntimeEntry = fileURLToPath(new URL('../../packages/electron-plugin-tunnel/src/index.ts', import.meta.url));

export default configure(() => ({
  supportTS: true,
  css: ['app.scss'],
  extras: ['material-icons'],
  build: {
    vueRouterMode: 'hash',
    alias: {
      '@qpjoy/electron-plugin-tunnel': tunnelRuntimeEntry
    }
  },
  framework: {
    config: {},
    plugins: ['Notify']
  },
  devServer: {
    host: '127.0.0.1',
    open: false
  },
  electron: {
    bundler: 'builder',
    preloadScripts: ['electron-preload'],
    extendElectronMainConf(config) {
      config.external = (config.external ?? []).filter((dependency) => dependency !== '@qpjoy/electron-plugin-tunnel');
    },
    builder: {
      appId: 'dev.qpjoy.electron-tunnel',
      productName: 'QPJoy Tunnel',
      directories: {
        output: 'dist/electron'
      },
      asarUnpack: [
        '**/better-sqlite3/**',
        '**/mihomo*'
      ],
      extraResources: [
        {
          from: '../../resources/mihomo',
          to: 'qpjoy-tunnel-engine',
          filter: ['**/*']
        }
      ],
      mac: {
        target: ['dmg'],
        icon: 'src-electron/icons/icon-source.png'
      },
      linux: {
        target: ['AppImage'],
        icon: 'src-electron/icons/icon-source.png'
      }
    }
  }
}));
