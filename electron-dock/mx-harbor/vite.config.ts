import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./ui-design", import.meta.url)) },
  },
  build: {
    outDir: "dist/web",
    rollupOptions: {
      input: {
        app: "index.html",
        gallery: "demos/ui-design-harbor/index.html",
      },
    },
  },
  server: {
    strictPort: true,
    proxy: Object.fromEntries(
      ["/auth/", "/bff/", "/api/v1/", "/health"].map((p) => [
        p,
        process.env.MX_HARBOR_DEV_API_TARGET || "http://127.0.0.1:18220",
      ]),
    ),
  },
});
