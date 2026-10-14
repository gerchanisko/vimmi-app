// Build of the web app (PWA) for phones and browsers: npm run build:web -> dist-web/
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  root: "web",
  base: "./",
  publicDir: "public",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: "../dist-web", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
  server: { port: 5198, strictPort: true, fs: { allow: [".."] } },
  preview: { port: 5197, strictPort: true },
});
