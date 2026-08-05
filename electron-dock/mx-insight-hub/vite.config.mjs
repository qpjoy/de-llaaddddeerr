import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
      "/api": "http://127.0.0.1:18180",
      "/health": "http://127.0.0.1:18180",
      "/internal": "http://127.0.0.1:18180",
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
