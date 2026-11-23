// Writes the update feeds and checksums for a release, next to the built files in <dir>:
//   latest.json        Tauri updater (Vimmi 0.8+): versions, download URLs and signatures
//   latest.yml         electron-updater on Windows (Vimmi 0.7): points it at the new installer
//   latest-linux.yml   electron-updater for the Electron AppImage (Vimmi 0.7)
//   SHA256SUMS         checked by install.sh
// Usage: node scripts/release-feeds.mjs out
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "out");
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const repo = process.env.GITHUB_REPOSITORY || "gerchanisko/vimmi-app";
const base = `https://github.com/${repo}/releases/download/v${version}`;
const files = { windows: "Vimmi-Setup.exe", linux: "Vimmi.AppImage" };
const now = new Date().toISOString();

const read = (name) => fs.readFileSync(path.join(dir, name));
for (const f of Object.values(files)) {
  if (!fs.existsSync(path.join(dir, f)) || !fs.existsSync(path.join(dir, `${f}.sig`))) throw new Error(`missing ${f} or its signature`);
}

const notes = fs.existsSync(".github/release-notes.md") ? fs.readFileSync(".github/release-notes.md", "utf8").trim() : "";
const latest = {
  version,
  notes,
  pub_date: now,
  platforms: {
    "windows-x86_64": { signature: read(`${files.windows}.sig`).toString("utf8").trim(), url: `${base}/${files.windows}` },
    "linux-x86_64": { signature: read(`${files.linux}.sig`).toString("utf8").trim(), url: `${base}/${files.linux}` },
  },
};
fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");

const electronFeed = (file) => {
  const data = read(file);
  const sha512 = createHash("sha512").update(data).digest("base64");
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${data.length}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    `releaseDate: '${now}'`,
    "",
  ].join("\n");
};
fs.writeFileSync(path.join(dir, "latest.yml"), electronFeed(files.windows));
fs.writeFileSync(path.join(dir, "latest-linux.yml"), electronFeed(files.linux));

const sums = Object.values(files)
  .map((f) => `${createHash("sha256").update(read(f)).digest("hex")}  ${f}`)
  .join("\n");
fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums + "\n");
console.log(`Feeds for ${version}: latest.json, latest.yml, latest-linux.yml, SHA256SUMS`);
