// Dev mode: Vite dev server for the UI + esbuild watch for Electron, then launches Electron.
import { spawn } from "node:child_process";
import { createServer } from "vite";

const server = await createServer({ configFile: "vite.config.mts" });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;

spawn("node", ["scripts/build-electron.mjs"], { stdio: "inherit" }).on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  spawn("node", ["scripts/build-electron.mjs", "--watch"], { stdio: "inherit" });
  const electron = spawn("npx", ["electron", "."], {
    stdio: "inherit",
    shell: process.platform === "win32", // npx is npx.cmd on Windows

    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  electron.on("exit", () => {
    server.close();
    process.exit(0);
  });
});
