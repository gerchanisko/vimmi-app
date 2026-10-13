import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src",
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5199, strictPort: true },
  test: { root: ".", include: ["test/**/*.test.ts"] },
} as never);
