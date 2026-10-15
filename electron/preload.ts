// Exposes a small, typed API to the renderer. The renderer never touches Node or the API key.
import { contextBridge, ipcRenderer } from "electron";
import type { ProviderId } from "../shared/providers";
import type { NoteVersion } from "../shared/history";
import type {
  AiEvent,
  CalendarSubscription,
  CalendarSubscriptionStatus,
  Chat,
  ChatContext,
  ChatSummary,
  NoteMeta,
  Priority,
  QuickEvent,
  QuickRequest,
  SearchHit,
  Settings,
  SyncSettings,
  SyncStatus,
  UpdateStatus,
  VaultSnapshot,
} from "../shared/types";

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  settings: {
    get: () => invoke<Settings & { keyEncrypted: boolean }>("settings:get"),
    set: (patch: Partial<Settings>) => invoke<Settings>("settings:set", patch),
    setKey: (provider: ProviderId, key: string | null) => invoke<Settings>("settings:set-key", provider, key),
    testKey: (provider: ProviderId) => invoke<{ ok: boolean; message: string }>("ai:test-key", provider),
    models: (provider: ProviderId) => invoke<string[]>("ai:models", provider),
  },
  vault: {
    pick: () => invoke<VaultSnapshot | null>("vault:pick"),
    createSample: () => invoke<VaultSnapshot | null>("vault:create-sample"),
    open: (dir: string) => invoke<VaultSnapshot>("vault:open", dir),
    close: () => invoke<void>("vault:close"),
    snapshot: () => invoke<VaultSnapshot | null>("vault:snapshot"),
    read: (p: string) => invoke<string>("vault:read", p),
    write: (p: string, content: string) => invoke<NoteMeta>("vault:write", p, content),
    create: (p: string, content?: string) => invoke<string>("vault:create", p, content),
    mkdir: (p: string) => invoke<void>("vault:mkdir", p),
    rename: (from: string, to: string) => invoke<string>("vault:rename", from, to),
    trash: (p: string) => invoke<void>("vault:trash", p),
    toggleTask: (p: string, line: number, done?: boolean) => invoke<void>("vault:toggle-task", p, line, done),
    addTask: (text: string, opts: { path?: string; due?: string; priority?: Priority; heading?: string }) =>
      invoke<string>("vault:add-task", text, opts),
    search: (q: string, opts?: { limit?: number; kind?: "all" | "note" | "task" | "project" }) =>
      invoke<SearchHit[]>("vault:search", q, opts),
    backlinks: (p: string) => invoke<{ path: string; title: string; lines: number[] }[]>("vault:backlinks", p),
    related: (p: string) => invoke<{ path: string; title: string; score: number }[]>("vault:related", p),
    daily: (date?: string) => invoke<string>("vault:daily", date),
    attachment: (name: string, data: Uint8Array) => invoke<string>("vault:attachment", name, data),
    /** Versions of a note kept on this device, newest first. */
    versions: (p: string) => invoke<NoteVersion[]>("vault:versions", p),
    version: (p: string, id: string) => invoke<string | null>("vault:version", p, id),
    /** Puts an old version back; the current text is kept in the history first. */
    restore: (p: string, content: string) => invoke<NoteMeta>("vault:restore", p, content),
    templates: () => invoke<string[]>("vault:templates"),
    fromTemplate: (template: string, title: string, folder: string) => invoke<string>("vault:from-template", template, title, folder),
    reveal: (p: string) => invoke<void>("vault:reveal", p),
    onChanged: (cb: () => void) => on<void>("vault:changed", cb),
    onNoteChanged: (cb: (info: { path: string; external: boolean }) => void) => on("vault:note-changed", cb),
    onOpenNote: (cb: (path: string) => void) => on("vault:open-note", cb),
    /** URL for showing a vault file (image) in the page. */
    fileUrl: (rel: string) => "vimmi-file://vault/" + rel.split("/").map(encodeURIComponent).join("/"),
  },
  sync: {
    status: () => invoke<SyncStatus>("sync:status"),
    now: () => invoke<SyncStatus>("sync:now"),
    /** Versions of a note on GitHub (empty when sync is off). */
    history: (p: string) => invoke<NoteVersion[]>("sync:history", p),
    version: (p: string, sha: string) => invoke<string | null>("sync:version", p, sha),
    setToken: (token: string | null) => invoke<Settings>("sync:set-token", token),
    user: () => invoke<string>("sync:user"),
    createRepo: (name: string) => invoke<{ owner: string; repo: string }>("sync:create-repo", name),
    configure: (patch: Partial<SyncSettings>) => invoke<Settings>("sync:configure", patch),
    onStatus: (cb: (s: SyncStatus) => void) => on("sync:status", cb),
  },
  calendar: {
    /** Download state of subscribed calendars, by subscription id. */
    status: () => invoke<Record<string, CalendarSubscriptionStatus>>("calendar:status"),
    refresh: (id?: string) => invoke<Record<string, CalendarSubscriptionStatus>>("calendar:refresh", id),
    save: (subs: CalendarSubscription[]) => invoke<Settings>("calendar:save", subs),
    /** Text of a .ics file in the vault. */
    read: (p: string) => invoke<string>("calendar:read", p),
    onStatus: (cb: (s: Record<string, CalendarSubscriptionStatus>) => void) => on("calendar:status", cb),
  },
  update: {
    status: () => invoke<UpdateStatus>("update:status"),
    check: () => invoke<UpdateStatus>("update:check"),
    install: () => invoke<void>("update:install"),
    restart: () => invoke<void>("update:restart"),
    onStatus: (cb: (s: UpdateStatus) => void) => on("update:status", cb),
  },
  ai: {
    chats: () => invoke<ChatSummary[]>("ai:chats"),
    chat: (id: string) => invoke<Chat | undefined>("ai:chat", id),
    newChat: () => invoke<Chat>("ai:new-chat"),
    deleteChat: (id: string) => invoke<void>("ai:delete-chat", id),
    send: (id: string, text: string, ctx: ChatContext) => invoke<void>("ai:send", id, text, ctx),
    stop: (id: string) => invoke<void>("ai:stop", id),
    approve: (toolUseId: string, ok: boolean) => invoke<void>("ai:approve", toolUseId, ok),
    quick: (req: QuickRequest) => invoke<void>("ai:quick", req),
    stopQuick: (id: string) => invoke<void>("ai:stop-quick", id),
    onEvent: (cb: (e: AiEvent) => void) => on("ai:event", cb),
    onQuick: (cb: (e: QuickEvent) => void) => on("ai:quick-event", cb),
  },
  app: {
    openExternal: (url: string) => invoke<void>("app:open-external", url),
    exportPdf: (html: string, title: string) => invoke<string | null>("app:export-pdf", html, title),
    version: () => invoke<string>("app:version"),
    platform: process.platform as string,
    /** "desktop" in Electron, "web" in the browser app. */
    kind: "desktop" as "desktop" | "web",
  },
};

export type VimmiApi = typeof api;
contextBridge.exposeInMainWorld("vimmi", api);
