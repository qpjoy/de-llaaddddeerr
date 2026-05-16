import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { quasar, transformAssetUrls } from '@quasar/vite-plugin';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    vue({ template: { transformAssetUrls } }),
    quasar({ sassVariables: 'src/css/quasar.variables.scss' })
  ],
  resolve: {
    alias: {
      src: fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  // Build to a relative path so the served HTML works from any mount point.
  base: './',
  build: {
    outDir: 'dist',
    // Small SPA — keep everything in one chunk for simpler serving.
    rollupOptions: {
      output: { manualChunks: undefined }
    }
  },
  server: {
    // While developing, proxy API calls to a running host on 23455.
    port: 5175,
    proxy: {
      '/api': 'http://127.0.0.1:23455'
    }
  }
});
