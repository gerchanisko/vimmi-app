// Automatic updates of the desktop app.
// - Windows installer and Linux AppImage: electron-updater with GitHub Releases.
// - Linux installed by install.sh (~/.local/opt/vimmi): re-run the install script in the background.
// - Development builds: no updates.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
// Accessing `autoUpdater` creates the updater lazily, so importing it here is cheap.
import { autoUpdater as electronAutoUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/types";

const REPO = "gerchanisko/vimmi-app";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15_000;

/** Compares dotted versions: 1 if a > b, -1 if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

type Method = UpdateStatus["method"];

function detectMethod(): Method {
  if (process.env.VIMMI_UPDATE_METHOD) return process.env.VIMMI_UPDATE_METHOD as Method;
  if (!app.isPackaged) return "none";
  if (process.platform === "win32" || process.env.APPIMAGE) return "auto";
  if (process.platform === "linux" && process.execPath.startsWith(path.join(os.homedir(), ".local", "opt", "vimmi"))) return "script";
  return "none";
}

export class Updater {
  status: UpdateStatus;
  private timer?: ReturnType<typeof setInterval>;
  private autoUpdater?: typeof electronAutoUpdater;

  constructor(
    private emit: (s: UpdateStatus) => void,
    private enabled: () => boolean,
  ) {
    this.status = { state: "idle", method: detectMethod(), current: app.getVersion() };
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit(this.status);
  }

  start(): void {
    if (this.status.method === "none") return;
    setTimeout(() => this.enabled() && void this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.enabled() && void this.check(), CHECK_EVERY_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async updaterLib() {
    if (!this.autoUpdater) {
      const autoUpdater = electronAutoUpdater;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("update-available", (info) => this.set({ state: "downloading", version: info.version, progress: 0 }));
      autoUpdater.on("download-progress", (p) => this.set({ state: "downloading", progress: Math.round(p.percent) }));
      autoUpdater.on("update-downloaded", (info) => this.set({ state: "ready", version: info.version, progress: 100 }));
      autoUpdater.on("update-not-available", () => this.set({ state: "latest", message: undefined }));
      autoUpdater.on("error", (err) => this.set({ state: "error", message: String(err?.message ?? err) }));
      this.autoUpdater = autoUpdater;
    }
    return this.autoUpdater;
  }

  /** Newest released version according to GitHub. */
  private async latestRelease(): Promise<string> {
    const feed = process.env.VIMMI_UPDATE_FEED || `https://api.github.com/repos/${REPO}/releases/latest`;
    const res = await fetch(feed, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub odpověděl ${res.status}`);
    const data = (await res.json()) as { tag_name: string };
    return data.tag_name.replace(/^v/, "");
  }

  async check(): Promise<UpdateStatus> {
    if (this.status.method === "none") {
      this.set({ state: "latest", message: "Vývojová verze se neaktualizuje." });
      return this.status;
    }
    if (["downloading", "installing", "ready"].includes(this.status.state)) return this.status;
    this.set({ state: "checking", message: undefined });
    try {
      if (this.status.method === "auto") {
        await (await this.updaterLib()).checkForUpdates();
        return this.status;
      }
      const latest = await this.latestRelease();
      if (compareVersions(latest, app.getVersion()) <= 0) {
        this.set({ state: "latest", version: latest, lastCheck: Date.now() });
        return this.status;
      }
      this.set({ state: "available", version: latest, lastCheck: Date.now() });
      if (this.enabled()) void this.installWithScript();
    } catch (err) {
      this.set({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return this.status;
  }

  /** Linux (install.sh): runs the installer again, which fetches, builds and installs the new version. */
  async installWithScript(): Promise<void> {
    if (this.status.state === "installing") return;
    this.set({ state: "installing", message: undefined });
    const logFile = path.join(os.homedir(), ".local", "share", "vimmi", "update.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = fs.openSync(logFile, "w");
    const command =
      process.env.VIMMI_UPDATE_COMMAND || `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --update`;
    const child = spawn("bash", ["-c", command], { stdio: ["ignore", log, log], env: { ...process.env, VIMMI_NONINTERACTIVE: "1" } });
    child.on("close", (code) => {
      fs.closeSync(log);
      if (code === 0) this.set({ state: "ready" });
      else {
        const tail = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-3).join(" ");
        this.set({ state: "error", message: `Aktualizace selhala (${tail || `kód ${code}`}). Podrobnosti v ${logFile}.` });
      }
    });
  }

  /** Restarts into the new version. */
  async restart(): Promise<void> {
    if (this.status.state !== "ready") return;
    if (this.status.method === "auto") {
      (await this.updaterLib()).quitAndInstall(false, true);
      return;
    }
    app.relaunch();
    app.exit(0);
  }

  /** Starts the update the user asked for (when automatic updates are off). */
  async install(): Promise<void> {
    if (this.status.method === "script" && this.status.state === "available") await this.installWithScript();
    if (this.status.method === "auto") await this.check();
  }
}
