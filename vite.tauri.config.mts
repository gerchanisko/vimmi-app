// Build of the page for the Rust desktop app (Tauri beta): npm run build:tauri-web -> dist-tauri/
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  root: "tauri",
  base: "./",
  publicDir: false,
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_ID__: JSON.stringify(pkg.version) },
  build: { outDir: "../dist-tauri", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
  server: { port: 5196, strictPort: true, fs: { allow: [".."] } },
  clearScreen: false,
});
