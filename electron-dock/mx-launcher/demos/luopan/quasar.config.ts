import { configure } from 'quasar/wrappers';

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
        target: ['dmg']
      },
      linux: {
        target: ['AppImage']
      },
      win: {
        target: ['nsis']
      }
    }
  }
}));
