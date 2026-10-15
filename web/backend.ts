// The web app's "main process": implements the same window.vimmi API as the Electron preload,
// but entirely in the browser (IndexedDB storage, direct AI and GitHub calls).
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
import { IdbStorage, kvDelete, kvGet, kvSet, openDb } from "./idb-storage";
import { CalendarFeed } from "../shared/calendar-feed";
import { CalendarSubscriptions } from "../shared/calendar-subs";

const SETTINGS_KEY = "vimmi:settings";
const VAULT_FLAG = "vimmi:vault";
/** Tests point sync at a fake GitHub server through this key; normally unset. */
const githubApi = () => localStorage.getItem("vimmi:dev-github-api") || undefined;

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "prohlížeč";
}

export async function installBackend(): Promise<void> {
  const db = await openDb();
  // Ask the browser not to evict our data (Safari otherwise may after weeks without use).
  void navigator.storage?.persist?.().catch(() => false);

  const bus = new Emitter();
  const secrets = new Map<string, string>();
  for (const id of [...PROVIDERS.map((p) => p.id), "github"]) {
    const v = await kvGet<string>(db, "private", `secret/${id}`);
    if (v) secrets.set(id, v);
  }
  // Keys of providers removed from the app (NVIDIA in 0.4.5) should not linger on the device.
  for (const id of ["nvidia"]) void kvDelete(db, "private", `secret/${id}`).catch(() => {});

  // ---------- settings ----------

  let settings: Settings;
  const derive = (s: Settings): Settings => {
    const keys: Partial<Record<ProviderId, boolean>> = {};
    for (const p of PROVIDERS) keys[p.id] = secrets.has(p.id);
    const info = PROVIDER_MAP[s.provider] ?? PROVIDER_MAP.anthropic;
    return { ...s, keys, hasApiKey: keys[info.id] || !info.needsKey, hasSyncToken: secrets.has("github") };
  };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    const merged = { ...DEFAULT_SETTINGS, ...stored, sync: { ...DEFAULT_SETTINGS.sync, ...(stored.sync ?? {}) } };
    if (!PROVIDER_MAP[merged.provider]) merged.provider = fallbackProvider((id) => secrets.has(id));
    settings = derive(merged);
  } catch {
    settings = derive({ ...DEFAULT_SETTINGS });
  }
  const saveSettings = (patch: Partial<Settings>): Settings => {
    settings = derive({ ...settings, ...patch });
    const { hasApiKey: _h, keys: _k, hasSyncToken: _t, ...persist } = settings;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(persist));
    } catch {
      /* storage full or blocked */
    }
    return settings;
  };
  const setSecret = async (id: string, value: string | null) => {
    if (value) {
      secrets.set(id, value.trim());
      await kvSet(db, "private", `secret/${id}`, value.trim());
    } else {
      secrets.delete(id);
      await kvDelete(db, "private", `secret/${id}`);
    }
    return saveSettings({});
  };

  // ---------- vault ----------

  const storage = new IdbStorage(db);
  await storage.init();
  let vault: Vault | undefined;
  const openVault = async () => {
    const v = new Vault(storage);
    v.templatesFolder = settings.templatesFolder;
    await v.load();
    v.on("changed", () => bus.emit("vault:changed"));
    v.on("note-changed", (info) => bus.emit("vault:note-changed", info));
    vault = v;
    localStorage.setItem(VAULT_FLAG, "1");
    sync.restart();
    calendars.start();
    feed.start();
  };
  const requireVault = () => {
    if (!vault) throw new Error("Trezor není otevřený.");
    return vault;
  };

  const syncConfig = () => {
    const s = settings.sync;
    const token = secrets.get("github");
    if (!s.enabled || !token || !s.owner || !s.repo) return null;
    return { owner: s.owner, repo: s.repo, branch: s.branch, token, device: deviceName(), apiBase: githubApi() };
  };
  const sync = new SyncManager(() => vault, syncConfig);
  sync.on("status", (st) => bus.emit("sync:status", st));
  // Browsers usually may not download calendars from other sites (Google sends no CORS headers);
  // the desktop app downloads them into the vault and sync brings them here.
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
  // Sync when the app comes back to the foreground (switching apps on a phone).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && vault) void sync.syncNow({ quick: true });
  });
  window.addEventListener("online", () => vault && void sync.syncNow({ quick: true }));

  if (!storage.isEmpty() || localStorage.getItem(VAULT_FLAG)) await openVault();

  // ---------- updates: a new deploy changes version.json ----------

  let update: UpdateStatus = { state: "idle", method: "reload", current: __APP_VERSION__ };
  const setUpdate = (patch: Partial<UpdateStatus>) => {
    update = { ...update, ...patch };
    bus.emit("update:status", update);
  };
  const checkUpdate = async (): Promise<UpdateStatus> => {
    if (location.protocol !== "https:" && !localStorage.getItem("vimmi:dev-update-check")) return update;
    try {
      const res = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
      const info = (await res.json()) as { version: string; build: string };
      if (info.build !== __BUILD_ID__) setUpdate({ state: "ready", version: info.version, lastCheck: Date.now() });
      else setUpdate({ state: "latest", lastCheck: Date.now() });
    } catch {
      /* offline: try again later */
    }
    return update;
  };
  let hiddenSince = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
      return;
    }
    // Back in the app after a while with a new version waiting: reload into it (notes are saved continuously).
    if (update.state === "ready" && settings.autoUpdate && Date.now() - hiddenSince > 3000) location.reload();
    else void checkUpdate();
  });
  setInterval(() => void checkUpdate(), 10 * 60 * 1000);
  setTimeout(() => void checkUpdate(), 5000);

  // ---------- AI ----------

  const agent = new Agent({
    vault: () => vault,
    settings: () => settings,
    apiKey: (p) => secrets.get(p),
    emit: (e) => bus.emit("ai:event", e),
    emitQuick: (e) => bus.emit("ai:quick-event", e),
    openNote: (p) => bus.emit("vault:open-note", p),
  });

  const on = <T>(event: string, cb: (payload: T) => void) => bus.on<T>(event, cb);
  const wrap = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve().then(fn);

  const api: VimmiApi = {
    settings: {
      get: () => wrap(() => ({ ...settings, keyEncrypted: false })),
      set: (patch) =>
        wrap(async () => {
          const next = saveSettings(patch);
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
      pick: () => wrap(() => null),
      createSample: () =>
        wrap(async () => {
          if (storage.isEmpty()) for (const [p, text] of Object.entries(sampleNotes(isoDate()))) await storage.writeText(p, text);
          await openVault();
          return requireVault().snapshot();
        }),
      open: () =>
        wrap(async () => {
          await openVault();
          return requireVault().snapshot();
        }),
      close: () => wrap(() => undefined),
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
      reveal: () => wrap(() => undefined),
      onChanged: (cb) => on("vault:changed", cb),
      onNoteChanged: (cb) => on("vault:note-changed", cb),
      onOpenNote: (cb) => on("vault:open-note", cb),
      fileUrl: (rel) => storage.fileUrl(rel),
    },
    sync: {
      status: () => wrap(() => sync.status),
      now: () => sync.syncNow(),
      history: (p) => wrap(() => sync.history(p)),
      version: (p, sha) => wrap(() => sync.version(p, sha)),
      setToken: (token) => setSecret("github", token),
      user: () =>
        wrap(() => {
          const token = secrets.get("github");
          if (!token) throw new Error("Nejdřív vlož GitHub token.");
          return githubUser(token, githubApi());
        }),
      createRepo: (name) =>
        wrap(() => {
          const token = secrets.get("github");
          if (!token) throw new Error("Nejdřív vlož GitHub token.");
          return createPrivateRepo(token, name, githubApi());
        }),
      configure: (patch: Partial<SyncSettings>) =>
        wrap(async () => {
          const next = saveSettings({ sync: { ...settings.sync, ...patch } });
          if (!vault) await openVault();
          else sync.restart();
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
      check: () => checkUpdate(),
      install: () => wrap(() => undefined),
      restart: () =>
        wrap(() => {
          location.reload();
        }),
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
        wrap(() => {
          if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
        }),
      exportPdf: (html) =>
        wrap(() => {
          // Browsers print to PDF from the print dialog ("Uložit jako PDF").
          const w = window.open("", "_blank");
          if (!w) return null;
          w.document.write(html);
          w.document.close();
          w.onload = () => w.print();
          setTimeout(() => w.print(), 500);
          return null;
        }),
      version: () => wrap(() => __APP_VERSION__),
      platform: /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "web",
      kind: "web",
    },
  };
  window.vimmi = api;
}

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
