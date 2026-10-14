// Build of the web app (PWA) for phones and browsers: npm run build:web -> dist-web/
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// Every deploy gets a new build id; the running app compares it with version.json to notice updates.
const buildId = `${pkg.version}-${Date.now().toString(36)}`;

export default defineConfig({
  root: "web",
  base: "./",
  publicDir: "public",
  plugins: [
    react(),
    {
      name: "vimmi-version-file",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: pkg.version, build: buildId }) });
      },
    },
  ],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_ID__: JSON.stringify(buildId) },
  build: { outDir: "../dist-web", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
  server: { port: 5198, strictPort: true, fs: { allow: [".."] } },
  preview: { port: 5197, strictPort: true },
});
