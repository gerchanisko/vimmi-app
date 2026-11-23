// The Rust desktop app's backend: the same window.vimmi API as the Electron preload, built from the
// shared core (shared/) on top of the Rust side (src-tauri): files on disk, keyring, dialogs.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { VimmiApi } from "../electron/preload";
import { sampleNotes } from "../electron/sample";
import { Agent, friendlyError } from "../shared/ai/agent";
import { Emitter } from "../shared/emitter";
import { isoDate } from "../shared/markdown";
import { fallbackProvider, PROVIDER_MAP, PROVIDERS, type ProviderId } from "../shared/providers";
import { createPrivateRepo, githubUser } from "../shared/sync";
import { SyncManager } from "../shared/sync-manager";
import { DEFAULT_SETTINGS, type Settings, type SyncSettings, type UpdateStatus } from "../shared/types";
import { Vault } from "../shared/vault";
import { dailyNote, noteFromTemplate, templatePaths } from "../shared/vault-actions";
import { CalendarFeed } from "../shared/calendar-feed";
import { CalendarSubscriptions } from "../shared/calendar-subs";
import { TauriStorage } from "./storage";

interface EnvInfo {
  platform: string;
  hostname: string;
  version: string;
  github_api: string | null;
  documents: string | null;
  env_keys: Record<string, string>;
}

/** Web requests to other sites go through Rust (no browser CORS), like Electron's main process did. */
function routeFetchThroughRust() {
  const own = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https?:\/\//i.test(url) && new URL(url).origin !== location.origin) return tauriFetch(input, init);
    return own(input, init);
  }) as typeof fetch;
}

/** Links open in the system browser, never inside the app window. */
function openLinksOutside() {
  const external = (href: string) => /^(https?:|mailto:)/i.test(href);
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !external(a.href)) return;
      e.preventDefault();
      void openUrl(a.href);
    },
    true,
  );
  window.open = ((url?: string | URL) => {
    const href = url ? String(url) : "";
    if (external(href)) void openUrl(href);
    return null;
  }) as typeof window.open;
}

/** Event reminders use the page's Notification API; here it shows system notifications. */
async function systemNotifications() {
  let permission: NotificationPermission = (await isPermissionGranted().catch(() => false)) ? "granted" : "default";
  class DesktopNotification {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      permission = (await requestPermission().catch(() => "denied")) as NotificationPermission;
      return permission;
    }
    onclick: (() => void) | null = null;
    constructor(title: string, opts?: NotificationOptions) {
      sendNotification({ title, body: opts?.body });
    }
    close() {}
  }
  (window as unknown as { Notification: unknown }).Notification = DesktopNotification;
}

/** PDF export: the system print dialog of the page ("Tisk do souboru" / "Uložit jako PDF"). */
function printHtml(html: string) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0";
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

export async function installBackend(): Promise<void> {
  routeFetchThroughRust();
  openLinksOutside();
  await systemNotifications();

  const env = await invoke<EnvInfo>("env_info");
  const win = getCurrentWindow();
  const bus = new Emitter();
  const githubApi = () => env.github_api ?? undefined;

  // ---------- secrets (system keyring) ----------

  const secrets = new Map<string, string>();
  for (const id of [...PROVIDERS.map((p) => p.id), "github"]) {
    const v = await invoke<string | null>("secret_get", { id }).catch(() => null);
    if (v) secrets.set(id, v);
  }
  const keyEncrypted = await invoke<boolean>("secret_encrypted");
  /** Keys from environment variables win, so developers can use e.g. OPENAI_API_KEY. */
  const secret = (id: string): string | undefined => {
    if (id === "github") return env.env_keys.VIMMI_GITHUB_TOKEN ?? secrets.get(id);
    const name = PROVIDER_MAP[id as ProviderId]?.keyEnv;
    return (name && env.env_keys[name]) || secrets.get(id);
  };

  // ---------- settings ----------

  let settings: Settings;
  const derive = (s: Settings): Settings => {
    const keys: Partial<Record<ProviderId, boolean>> = {};
    for (const p of PROVIDERS) keys[p.id] = Boolean(secret(p.id));
    const info = PROVIDER_MAP[s.provider] ?? PROVIDER_MAP.anthropic;
    return { ...s, keys, hasApiKey: Boolean(keys[info.id]) || !info.needsKey, hasSyncToken: Boolean(secret("github")) };
  };
  const writeSettings = () => {
    const { hasApiKey: _h, keys: _k, hasSyncToken: _t, ...persist } = settings;
    return invoke("settings_write", { json: JSON.stringify(persist, null, 2) });
  };
  const stored = await invoke<{ json: string | null; imported: boolean }>("settings_read");
  try {
    const parsed = JSON.parse(stored.json ?? "{}") as Partial<Settings> & { model?: string };
    const { model: legacyModel, ...rest } = parsed;
    const merged = { ...DEFAULT_SETTINGS, ...rest, sync: { ...DEFAULT_SETTINGS.sync, ...(rest.sync ?? {}) } };
    if (legacyModel && !merged.models.anthropic) merged.models = { ...merged.models, anthropic: legacyModel };
    if (!PROVIDER_MAP[merged.provider]) merged.provider = fallbackProvider((id) => Boolean(secret(id)));
    settings = derive(merged);
  } catch {
    settings = derive({ ...DEFAULT_SETTINGS });
  }
  if (stored.imported) await writeSettings();
  const saveSettings = (patch: Partial<Settings>): Settings => {
    settings = derive({ ...settings, ...patch });
    void writeSettings();
    return settings;
  };
  const setSecret = async (id: string, value: string | null) => {
    await invoke("secret_set", { id, value });
    if (value?.trim()) secrets.set(id, value.trim());
    else secrets.delete(id);
    return saveSettings({});
  };
  const applyTheme = (t: Settings["theme"]) => void win.setTheme(t === "system" ? null : t).catch(() => {});
  applyTheme(settings.theme);

  // ---------- vault ----------

  let vault: Vault | undefined;

  const agent = new Agent({
    vault: () => vault,
    settings: () => settings,
    apiKey: (p) => secret(p),
    emit: (e) => bus.emit("ai:event", e),
    emitQuick: (e) => bus.emit("ai:quick-event", e),
    openNote: (p) => bus.emit("vault:open-note", p),
  });

  const syncConfig = () => {
    const s = settings.sync;
    const token = secret("github");
    if (!s.enabled || !token || !s.owner || !s.repo) return null;
    return { owner: s.owner, repo: s.repo, branch: s.branch, token, device: env.hostname || "počítač", apiBase: githubApi() };
  };
  const sync = new SyncManager(() => vault, syncConfig);
  sync.on("status", (st) => bus.emit("sync:status", st));
  const calendars = new CalendarSubscriptions(
    () => vault,
    () => settings,
    (subs) => saveSettings({ calendars: subs }),
  );
  calendars.on("status", (st) => bus.emit("calendar:status", st));
  const feed = new CalendarFeed(
    () => vault,
    syncConfig,
    () => settings.calendarFeed,
    (f) => saveSettings({ calendarFeed: f }),
  );
  feed.on("status", (st) => bus.emit("calendar:feed-status", st));

  let storage: TauriStorage | undefined;
  const openVault = async (dir: string) => {
    vault?.close();
    agent.resetForVault();
    storage = await TauriStorage.open(dir);
    const v = new Vault(storage);
    v.templatesFolder = settings.templatesFolder;
    await v.load();
    v.on("changed", () => bus.emit("vault:changed"));
    v.on("note-changed", (info) => bus.emit("vault:note-changed", info));
    vault = v;
    saveSettings({ vaultPath: v.root, recentVaults: [v.root, ...settings.recentVaults.filter((r) => r !== v.root)].slice(0, 8) });
    void win.setTitle(`${storage.name} – Vimmi Beta`);
    sync.restart();
    calendars.start();
    feed.start();
  };
  const requireVault = () => {
    if (!vault) throw new Error("Není otevřený žádný trezor.");
    return vault;
  };
  const pickFolder = async (title: string, defaultPath?: string) => {
    const r = await openDialog({ directory: true, multiple: false, title, defaultPath });
    return typeof r === "string" ? r : null;
  };

  // Reopen the last vault (settings imported from the Electron app point to the same folder).
  if (settings.vaultPath) {
    try {
      await openVault(settings.vaultPath);
    } catch {
      saveSettings({ vaultPath: undefined });
    }
  }

  // ---------- updates: the beta is installed by hand for now ----------

  const update: UpdateStatus = { state: "idle", method: "none", current: env.version };

  const on = <T>(event: string, cb: (payload: T) => void) => bus.on<T>(event, cb);
  const wrap = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve().then(fn);

  const api: VimmiApi = {
    settings: {
      get: () => wrap(() => ({ ...settings, keyEncrypted })),
      set: (patch) =>
        wrap(async () => {
          const next = saveSettings(patch);
          if (patch.theme) applyTheme(patch.theme);
          if (patch.templatesFolder !== undefined && vault) {
            vault.templatesFolder = patch.templatesFolder;
            await vault.load();
            bus.emit("vault:changed");
          }
          return next;
        }),
      setKey: (provider, key) => setSecret(provider, key),
      testKey: (provider) => agent.testKey(provider),
      models: (provider) => agent.listModels(provider),
    },
    vault: {
      pick: () =>
        wrap(async () => {
          const dir = await pickFolder("Vyber složku trezoru");
          if (!dir) return null;
          await openVault(dir);
          return requireVault().snapshot();
        }),
      createSample: () =>
        wrap(async () => {
          const base = env.documents ? `${env.documents}${env.platform === "win32" ? "\\" : "/"}Vimmi` : undefined;
          const dir = await pickFolder("Kam uložit nový trezor?", base);
          if (!dir) return null;
          await openVault(dir);
          const s = storage!;
          const { files } = await s.list();
          if (!files.some((f) => !f.path.includes("/") && /\.md$/i.test(f.path))) {
            for (const [rel, text] of Object.entries(sampleNotes(isoDate()))) await s.writeText(rel, text);
            await requireVault().load();
          }
          return requireVault().snapshot();
        }),
      open: (dir) =>
        wrap(async () => {
          await openVault(dir);
          return requireVault().snapshot();
        }),
      close: () =>
        wrap(async () => {
          sync.stop();
          vault?.close();
          vault = undefined;
          storage = undefined;
          await invoke("vault_close");
          saveSettings({ vaultPath: undefined });
          void win.setTitle("Vimmi Beta");
        }),
      snapshot: () => wrap(() => vault?.snapshot() ?? null),
      read: (p) => wrap(() => requireVault().read(p)),
      write: (p, c) => requireVault().write(p, c),
      create: (p, c) => requireVault().create(p, c ?? ""),
      mkdir: (p) => requireVault().mkdir(p),
      rename: (a, b) => requireVault().rename(a, b),
      trash: (p) => requireVault().trash(p),
      toggleTask: (p, line, done) => requireVault().toggleTask(p, line, done),
      addTask: (text, opts) => requireVault().addTask(text, opts),
      search: (q, opts) => wrap(() => requireVault().search(q, opts)),
      backlinks: (p) => wrap(() => requireVault().backlinks(p)),
      related: (p) => wrap(() => requireVault().related(p)),
      daily: (date) => dailyNote(requireVault(), date ?? isoDate(), settings),
      attachment: (name, data) => requireVault().saveAttachment(name, data, settings.attachmentsFolder),
      versions: (p) => wrap(() => requireVault().history.list(p)),
      version: (p, id) => wrap(() => requireVault().history.read(p, id)),
      restore: (p, content) =>
        wrap(() => {
          const v = requireVault();
          return v.as("restore", () => v.write(p, content));
        }),
      templates: () => wrap(() => templatePaths(requireVault(), settings.templatesFolder)),
      fromTemplate: (t, title, folder) => noteFromTemplate(requireVault(), t, title, folder),
      reveal: (p) =>
        wrap(async () => {
          await revealItemInDir(await invoke<string>("vault_abs", { rel: p }));
        }),
      onChanged: (cb) => on("vault:changed", cb),
      onNoteChanged: (cb) => on("vault:note-changed", cb),
      onOpenNote: (cb) => on("vault:open-note", cb),
      fileUrl: (rel) => {
        const path = rel.split("/").map(encodeURIComponent).join("/");
        return env.platform === "win32" ? `http://vimmi-file.localhost/${path}` : `vimmi-file://localhost/${path}`;
      },
    },
    sync: {
      status: () => wrap(() => sync.status),
      now: () => sync.syncNow(),
      history: (p) => wrap(() => sync.history(p)),
      version: (p, sha) => wrap(() => sync.version(p, sha)),
      setToken: (token) => setSecret("github", token),
      user: () =>
        wrap(() => {
          const token = secret("github");
          if (!token) throw new Error("Nejdřív vlož GitHub token.");
          return githubUser(token, githubApi());
        }),
      createRepo: (name) =>
        wrap(() => {
          const token = secret("github");
          if (!token) throw new Error("Nejdřív vlož GitHub token.");
          return createPrivateRepo(token, name, githubApi());
        }),
      configure: (patch: Partial<SyncSettings>) =>
        wrap(() => {
          const next = saveSettings({ sync: { ...settings.sync, ...patch } });
          sync.restart();
          return next;
        }),
      onStatus: (cb) => on("sync:status", cb),
    },
    calendar: {
      status: () => wrap(() => calendars.status),
      refresh: (id) => calendars.refresh(id),
      save: (subs) => calendars.save(subs).then(() => settings),
      read: (p) =>
        wrap(async () => {
          if (!/\.ics$/i.test(p)) throw new Error("Jen soubory kalendáře (.ics).");
          return new TextDecoder().decode(await requireVault().readBytes(p));
        }),
      onStatus: (cb) => on("calendar:status", cb),
      feedStatus: () => wrap(() => feed.status),
      feedEnable: () => feed.enable(),
      feedDisable: () => feed.disable(),
      onFeedStatus: (cb) => on("calendar:feed-status", cb),
    },
    update: {
      status: () => wrap(() => update),
      check: () => wrap(() => update),
      install: () => wrap(() => undefined),
      restart: () => wrap(() => location.reload()),
      onStatus: (cb) => on("update:status", cb),
    },
    ai: {
      chats: () => agent.listChats(),
      chat: (id) => agent.getChat(id),
      newChat: () => wrap(() => agent.newChat()),
      deleteChat: (id) => agent.deleteChat(id),
      send: (id, text, ctx) =>
        wrap(() => {
          void agent.send(id, text, ctx).catch((err) => bus.emit("ai:event", { type: "error", convId: id, message: friendlyError(err) }));
        }),
      stop: (id) => wrap(() => agent.stop(id)),
      approve: (toolUseId, ok) => wrap(() => agent.approve(toolUseId, ok)),
      quick: (req) =>
        wrap(() => {
          void agent.quick(req);
        }),
      stopQuick: (id) => wrap(() => agent.stopQuick(id)),
      onEvent: (cb) => on("ai:event", cb),
      onQuick: (cb) => on("ai:quick-event", cb),
    },
    app: {
      openExternal: (url) =>
        wrap(async () => {
          if (/^https?:\/\//i.test(url)) await openUrl(url);
        }),
      exportPdf: (html) =>
        wrap(() => {
          printHtml(html);
          return null;
        }),
      version: () => wrap(() => env.version),
      platform: env.platform,
      kind: "desktop",
    },
  };
  window.vimmi = api;
}
