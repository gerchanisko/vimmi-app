// Bundles the Electron main and preload scripts into dist-electron/.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // electron-updater stays a normal dependency (it is packed into the app by electron-builder).
  external: ["electron", "electron-updater"],
  logLevel: "info",
};
const entries = [
  { ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.js" },
  { ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.js" },
  // Used by test/smoke.mjs to create the starter vault.
  { ...common, entryPoints: ["test/fixtures/sample-vault.ts"], outfile: "dist-electron/sample-for-test.cjs", sourcemap: false },
  // Used by test/sync-e2e.mjs.
  { ...common, entryPoints: ["test/fake-github.ts"], outfile: "dist-electron/fake-github-for-test.mjs", format: "esm", sourcemap: false },
];

if (watch) {
  for (const options of entries) await (await context(options)).watch();
} else {
  await Promise.all(entries.map((options) => build(options)));
}
