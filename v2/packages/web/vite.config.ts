import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: ["kgl-songs.exe.xyz"],
    proxy: {
      "/api/v2": {
        target: "http://127.0.0.1:8001",
        changeOrigin: false,
        headers: {
          "X-ExeDev-UserID": "vite-local-development",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "kgl-songs.exe.xyz:8001",
        },
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    assetsDir: "assets",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
