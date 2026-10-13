// Builds Vimmi and installs it for the current user, so it starts from the app menu / taskbar.
// Usage: npm run install-desktop       (uninstall: npm run install-desktop -- --uninstall)
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const appDir = path.join(home, ".local/opt/vimmi");
const desktopFile = path.join(home, ".local/share/applications/vimmi.desktop");
const iconFile = path.join(home, ".local/share/icons/hicolor/512x512/apps/vimmi.png");
const refreshMenus = () => {
  try {
    execSync(`update-desktop-database ${JSON.stringify(path.dirname(desktopFile))}`, { stdio: "ignore" });
  } catch {
    /* optional tool */
  }
};

if (process.argv.includes("--uninstall")) {
  for (const p of [appDir, desktopFile, iconFile]) fs.rmSync(p, { recursive: true, force: true });
  refreshMenus();
  console.log("Vimmi odinstalováno (poznámky a nastavení zůstaly).");
  process.exit(0);
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
run("npm run build");
run("npx electron-builder --linux dir --publish never");

const unpacked = path.resolve("release/linux-unpacked");
if (!fs.existsSync(path.join(unpacked, "vimmi"))) throw new Error("Build nevytvořil release/linux-unpacked/vimmi");

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(appDir), { recursive: true });
fs.cpSync(unpacked, appDir, { recursive: true });

fs.mkdirSync(path.dirname(iconFile), { recursive: true });
fs.copyFileSync("resources/icon.png", iconFile);

fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
fs.writeFileSync(
  desktopFile,
  `[Desktop Entry]
Type=Application
Name=Vimmi
GenericName=Poznámky
Comment=Poznámky, úkoly a projekty s AI asistentem
Exec="${path.join(appDir, "vimmi")}" %U
Icon=vimmi
Terminal=false
Categories=Office;TextEditor;
Keywords=notes;poznámky;úkoly;markdown;ai;
StartupWMClass=vimmi
`,
);
refreshMenus();
console.log(`\nHotovo. Vimmi najdeš v nabídce aplikací (nainstalováno v ${appDir}).`);
