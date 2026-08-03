import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri spawns Vite with `TAURI_DEV` set; we use that to pick the port.
const port = Number(process.env.VITE_PORT ?? 5173);
const backendUrl =
  process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@lia/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: backendUrl,
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
    sourcemap: true,
  },
  clearScreen: false,
});
