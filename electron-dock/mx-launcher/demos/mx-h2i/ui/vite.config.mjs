import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  build: {
    outDir: '../src/renderer-dist',
    emptyOutDir: true,
    target: 'chrome132',
  },
  server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
});
