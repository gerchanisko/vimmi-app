// Electron main process: window, IPC, vault lifecycle.
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import { pathToFileURL } from "node:url";
import { basename, isoDate } from "../shared/markdown";
import type { ProviderId } from "../shared/providers";
import type { ChatContext, QuickRequest, Settings } from "../shared/types";
import { Agent } from "../shared/ai/agent";
import { dailyNote as dailyNoteFor, noteFromTemplate, templatePaths } from "../shared/vault-actions";
import os from "node:os";
import { createPrivateRepo, githubUser } from "../shared/sync";
import { SyncManager } from "../shared/sync-manager";
import { Updater } from "./updater";
import type { SyncSettings } from "../shared/types";
import { getApiKey, getSyncToken, keyStorageIsEncrypted, loadSettings, saveSettings, setApiKey } from "./settings";
import { sampleNotes } from "./sample";
import { Vault } from "./vault";

// Lets tests and portable installs keep settings in their own folder.
if (process.env.VIMMI_USER_DATA) app.setPath("userData", process.env.VIMMI_USER_DATA);

let win: BrowserWindow | undefined;
let vault: Vault | undefined;

protocol.registerSchemesAsPrivileged([
  { scheme: "vimmi-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const send = (channel: string, payload?: unknown) => win?.webContents.send(channel, payload);

const agent = new Agent({
  vault: () => vault,
  settings: loadSettings,
  apiKey: getApiKey,
  emit: (e) => send("ai:event", e),
  emitQuick: (e) => send("ai:quick-event", e),
  openNote: (p) => send("vault:open-note", p),
});

const githubApi = () => process.env.VIMMI_GITHUB_API || undefined;

const sync = new SyncManager(
  () => vault,
  () => {
    const s = loadSettings().sync;
    const token = getSyncToken();
    if (!s.enabled || !token || !s.owner || !s.repo) return null;
    return { owner: s.owner, repo: s.repo, branch: s.branch, token, device: os.hostname() || "počítač", apiBase: githubApi() };
  },
);
sync.on("status", (st) => send("sync:status", st));

const updater = new Updater(
  (st) => send("update:status", st),
  () => loadSettings().autoUpdate,
);

async function openVault(dir: string): Promise<void> {
  vault?.close();
  agent.resetForVault();
  const v = new Vault(dir);
  v.templatesFolder = loadSettings().templatesFolder;
  await v.load();
  v.on("changed", () => send("vault:changed"));
  v.on("note-changed", (info) => send("vault:note-changed", info));
  vault = v;
  const s = loadSettings();
  saveSettings({ vaultPath: v.root, recentVaults: [v.root, ...s.recentVaults.filter((r) => r !== v.root)].slice(0, 8) });
  win?.setTitle(`${path.basename(v.root)} – Vimmi`);
  sync.restart();
}

function requireVault(): Vault {
  if (!vault) throw new Error("Není otevřený žádný trezor.");
  return vault;
}

async function createSampleVault(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).some((f) => f.endsWith(".md"))) return;
  for (const [rel, content] of Object.entries(sampleNotes(isoDate()))) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function dailyNote(date: string): Promise<string> {
  return dailyNoteFor(requireVault(), date, loadSettings());
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (_e, ...args) => fn(...(args as A)));
}

function registerIpc(): void {
  // settings
  handle("settings:get", () => ({ ...loadSettings(), keyEncrypted: keyStorageIsEncrypted() }));
  handle("settings:set", async (patch: Partial<Settings>) => {
    const next = saveSettings(patch);
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    if (patch.templatesFolder !== undefined && vault) {
      vault.templatesFolder = patch.templatesFolder;
      await vault.load();
      send("vault:changed");
    }
    return next;
  });
  handle("settings:set-key", (provider: ProviderId, key: string | null) => setApiKey(provider, key));
  handle("ai:test-key", (provider: ProviderId) => agent.testKey(provider));
  handle("ai:models", (provider: ProviderId) => agent.listModels(provider));

  // vault lifecycle
  handle("vault:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: "Vyber složku trezoru" });
    if (r.canceled || !r.filePaths[0]) return null;
    await openVault(r.filePaths[0]);
    return requireVault().snapshot();
  });
  handle("vault:create-sample", async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
      title: "Kam uložit nový trezor?",
      defaultPath: path.join(app.getPath("documents"), "Vimmi"),
    });
    if (r.canceled || !r.filePaths[0]) return null;
    await createSampleVault(r.filePaths[0]);
    await openVault(r.filePaths[0]);
    return requireVault().snapshot();
  });
  handle("vault:open", async (dir: string) => {
    if (!fs.existsSync(dir)) throw new Error("Složka už neexistuje.");
    await openVault(dir);
    return requireVault().snapshot();
  });
  handle("vault:close", () => {
    sync.stop();
    vault?.close();
    vault = undefined;
    saveSettings({ vaultPath: undefined });
  });
  handle("vault:snapshot", () => vault?.snapshot() ?? null);

  // notes
  handle("vault:read", (rel: string) => requireVault().read(rel));
  handle("vault:write", (rel: string, content: string) => requireVault().write(rel, content));
  handle("vault:create", (rel: string, content?: string) => requireVault().create(rel, content ?? ""));
  handle("vault:mkdir", (rel: string) => requireVault().mkdir(rel));
  handle("vault:rename", (from: string, to: string) => requireVault().rename(from, to));
  handle("vault:trash", (rel: string) => requireVault().trash(rel));
  handle("vault:toggle-task", (rel: string, line: number, done?: boolean) => requireVault().toggleTask(rel, line, done));
  handle("vault:add-task", (text: string, opts: Parameters<Vault["addTask"]>[1]) => requireVault().addTask(text, opts));
  handle("vault:search", (q: string, opts?: Parameters<Vault["search"]>[1]) => requireVault().search(q, opts));
  handle("vault:backlinks", (rel: string) => requireVault().backlinks(rel));
  handle("vault:related", (rel: string) => requireVault().related(rel));
  handle("vault:daily", (date?: string) => dailyNote(date ?? isoDate()));
  handle("vault:attachment", (name: string, data: Uint8Array) =>
    requireVault().saveAttachment(name, data, loadSettings().attachmentsFolder),
  );
  handle("vault:templates", () => templatePaths(requireVault(), loadSettings().templatesFolder));
  handle("vault:from-template", (template: string, title: string, folder: string) =>
    noteFromTemplate(requireVault(), template, title, folder),
  );
  handle("vault:reveal", (rel: string) => shell.showItemInFolder(requireVault().abs(rel)));

  // updates
  handle("update:status", () => updater.status);
  handle("update:check", () => updater.check());
  handle("update:install", () => updater.install());
  handle("update:restart", () => updater.restart());

  // sync
  handle("sync:status", () => sync.status);
  handle("sync:now", () => sync.syncNow());
  handle("sync:set-token", (token: string | null) => setApiKey("github", token));
  handle("sync:user", async () => {
    const token = getSyncToken();
    if (!token) throw new Error("Nejdřív vlož GitHub token.");
    return githubUser(token, githubApi());
  });
  handle("sync:create-repo", async (name: string) => {
    const token = getSyncToken();
    if (!token) throw new Error("Nejdřív vlož GitHub token.");
    return createPrivateRepo(token, name, githubApi());
  });
  handle("sync:configure", (patch: Partial<SyncSettings>) => {
    const next = saveSettings({ sync: { ...loadSettings().sync, ...patch } });
    sync.restart();
    return next;
  });

  // app
  handle("app:open-external", (url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
  handle("app:export-pdf", async (html: string, title: string) => {
    const r = await dialog.showSaveDialog(win!, {
      title: "Exportovat do PDF",
      defaultPath: path.join(app.getPath("documents"), `${basename(title)}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (r.canceled || !r.filePath) return null;
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await pdfWin.webContents.printToPDF({ printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
    pdfWin.destroy();
    fs.writeFileSync(r.filePath, pdf);
    return r.filePath;
  });
  handle("app:version", () => app.getVersion());

  // AI
  handle("ai:chats", () => agent.listChats());
  handle("ai:chat", (id: string) => agent.getChat(id));
  handle("ai:new-chat", () => agent.newChat());
  handle("ai:delete-chat", (id: string) => agent.deleteChat(id));
  handle("ai:send", (id: string, text: string, ctx: ChatContext) => {
    // Runs in the background; progress arrives through ai:event.
    void agent.send(id, text, ctx).catch((err) => send("ai:event", { type: "error", convId: id, message: String(err?.message ?? err) }));
  });
  handle("ai:stop", (id: string) => agent.stop(id));
  handle("ai:approve", (toolUseId: string, ok: boolean) => agent.approve(toolUseId, ok));
  handle("ai:quick", (req: QuickRequest) => {
    void agent.quick(req);
  });
  handle("ai:stop-quick", (id: string) => agent.stopQuick(id));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "Vimmi",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#f7f7f5",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../dist/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.setMenuBarVisibility(false);

  // The app only needs notifications (event reminders) and the clipboard; refuse camera,
  // microphone, location, USB and everything else a malicious page or note could ask for.
  const allowed = new Set(["notifications", "clipboard-sanitized-write", "clipboard-read"]);
  win.webContents.session.setPermissionRequestHandler((_wc, permission, done) => done(allowed.has(permission)));
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // Links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, "../dist/index.html"));
  win.on("closed", () => (win = undefined));
}

// Czech date and time pickers (24-hour clock) regardless of the system language.
app.commandLine.appendSwitch("lang", "cs-CZ");

// Windows groups taskbar buttons and shortcuts by this id (same as build.appId).
if (process.platform === "win32") app.setAppUserModelId("io.github.gerchanisko.vimmi");

app.whenReady().then(async () => {
  nativeTheme.themeSource = loadSettings().theme;

  // Serves vault files (images, attachments) to the renderer: vimmi-file://vault/<relative path>
  protocol.handle("vimmi-file", (req) => {
    const v = vault;
    if (!v) return new Response("No vault", { status: 404 });
    try {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
      return net.fetch(pathToFileURL(v.abs(rel)).toString());
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
  });

  registerIpc();
  const last = loadSettings().vaultPath;
  if (last && fs.existsSync(last)) {
    try {
      await openVault(last);
    } catch {
      saveSettings({ vaultPath: undefined });
    }
  }
  createWindow();
  updater.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  vault?.close();
  if (process.platform !== "darwin") app.quit();
});
