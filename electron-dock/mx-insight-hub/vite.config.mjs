import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devApiTarget = process.env.MX_INSIGHT_DEV_API_TARGET || "http://127.0.0.1:18180";

export default defineConfig({
  // Relative asset base so the built Admin SPA works both at the listener root
  // (direct http://HOST:18151/) and behind the public edge under /admin/ where
  // nginx strips the prefix. Client routing is hash-based, so the document dir
  // stays fixed and relative asset URLs resolve correctly in both mounts.
  base: "./",
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    proxy: {
      "/api": devApiTarget,
      "/health": devApiTarget,
      "/internal": devApiTarget,
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
