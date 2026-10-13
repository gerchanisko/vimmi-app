// Tiny global store (useSyncExternalStore) for app-wide UI state.
import { useSyncExternalStore } from "react";
import { resolveLinkTarget } from "../../shared/markdown";
import type { NoteMeta, Settings, VaultSnapshot } from "../../shared/types";

export type ViewKind = "today" | "tasks" | "projects" | "graph" | "search" | "tag";
export type Tab = { id: string; kind: "note"; path: string; mode: "edit" | "read" } | { id: string; kind: "view"; view: ViewKind; arg?: string };
export type RightPanel = "ai" | "links" | "outline" | "info";
export type Overlay = null | { type: "spotlight"; query?: string } | { type: "commands" } | { type: "settings"; tab?: string } | { type: "template" };

export interface Toast {
  id: number;
  text: string;
  kind?: "error" | "ok";
}

export interface AppState {
  ready: boolean;
  snapshot: VaultSnapshot | null;
  settings: (Settings & { keyEncrypted?: boolean }) | null;
  tabs: Tab[];
  active: string | null;
  right: RightPanel | null;
  leftOpen: boolean;
  overlay: Overlay;
  toasts: Toast[];
  bookmarks: string[];
  /** Line to scroll to when a note opens (from search or backlinks). */
  jump: { path: string; line: number } | null;
  /** Text queued for the AI chat input (e.g. "Ask AI about selection"). */
  aiDraft: string | null;
  /** Active editor selection, kept for AI context. */
  selection: string;
  dialog: Dialog | null;
}

export interface Dialog {
  kind: "prompt" | "confirm";
  title: string;
  message?: string;
  value?: string;
  okLabel?: string;
  danger?: boolean;
  resolve: (value: string | null) => void;
}

let state: AppState = {
  ready: false,
  snapshot: null,
  settings: null,
  tabs: [],
  active: null,
  right: null,
  leftOpen: true,
  overlay: null,
  toasts: [],
  bookmarks: [],
  jump: null,
  aiDraft: null,
  selection: "",
  dialog: null,
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  persistLayout();
  for (const l of listeners) l();
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => select(state),
  );
}

// ---------- per-vault layout persistence (localStorage, best effort) ----------

function layoutKey(): string | null {
  return state.snapshot ? `vimmi:layout:${state.snapshot.root}` : null;
}

let persistTimer: number | undefined;
function persistLayout(): void {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const key = layoutKey();
    if (!key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ tabs: state.tabs, active: state.active, right: state.right, leftOpen: state.leftOpen, bookmarks: state.bookmarks }),
      );
    } catch {
      /* storage unavailable */
    }
  }, 300);
}

export function restoreLayout(snapshot: VaultSnapshot): Partial<AppState> {
  try {
    const raw = localStorage.getItem(`vimmi:layout:${snapshot.root}`);
    if (!raw) return {};
    const saved = JSON.parse(raw) as Partial<AppState>;
    const paths = new Set(snapshot.notes.map((n) => n.path));
    const tabs = (saved.tabs ?? []).filter((t) => t.kind === "view" || paths.has(t.path));
    return {
      tabs,
      active: tabs.some((t) => t.id === saved.active) ? saved.active : (tabs[0]?.id ?? null),
      right: saved.right ?? null,
      leftOpen: saved.leftOpen ?? true,
      bookmarks: (saved.bookmarks ?? []).filter((b) => paths.has(b)),
    };
  } catch {
    return {};
  }
}

// ---------- helpers ----------

let tabSeq = 0;
const newId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

export function noteMeta(path: string): NoteMeta | undefined {
  return state.snapshot?.notes.find((n) => n.path === path);
}

export function resolveLink(target: string, from?: string): string | undefined {
  const paths = state.snapshot?.notes.map((n) => n.path) ?? [];
  return resolveLinkTarget(target, paths, from);
}

export function activeTab(): Tab | undefined {
  return state.tabs.find((t) => t.id === state.active);
}

export function activeNotePath(): string | undefined {
  const t = activeTab();
  return t?.kind === "note" ? t.path : undefined;
}

/** Opens a note. Reuses an existing tab, or replaces the current note tab unless `newTab` is set. */
export function openNote(path: string, opts: { newTab?: boolean; line?: number; mode?: "edit" | "read" } = {}): void {
  setState((s) => {
    const jump = opts.line !== undefined ? { path, line: opts.line } : null;
    const existing = s.tabs.find((t) => t.kind === "note" && t.path === path);
    if (existing) {
      return { active: existing.id, jump, tabs: opts.mode ? s.tabs.map((t) => (t.id === existing.id ? { ...t, mode: opts.mode! } : t)) : s.tabs };
    }
    const tab: Tab = { id: newId(), kind: "note", path, mode: opts.mode ?? "edit" };
    const current = s.tabs.find((t) => t.id === s.active);
    if (!opts.newTab && current) {
      return { tabs: s.tabs.map((t) => (t.id === current.id ? tab : t)), active: tab.id, jump };
    }
    return { tabs: [...s.tabs, tab], active: tab.id, jump };
  });
}

export function openView(view: ViewKind, arg?: string): void {
  setState((s) => {
    const existing = s.tabs.find((t) => t.kind === "view" && t.view === view);
    if (existing) {
      return { active: existing.id, tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, arg } as Tab : t)) };
    }
    const tab: Tab = { id: newId(), kind: "view", view, arg };
    return { tabs: [...s.tabs, tab], active: tab.id };
  });
}

export function closeTab(id: string): void {
  setState((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    const active = s.active === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.active;
    return { tabs, active };
  });
}

export function renamePathInTabs(from: string, to: string): void {
  setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.kind === "note" && (t.path === from || t.path.startsWith(from + "/")) ? { ...t, path: to + t.path.slice(from.length) } : t,
    ),
    bookmarks: s.bookmarks.map((b) => (b === from ? to : b)),
  }));
}

let toastSeq = 0;
export function toast(text: string, kind?: Toast["kind"]): void {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 6000 : 3000);
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

export async function refreshSnapshot(): Promise<void> {
  const snapshot = await window.vimmi.vault.snapshot();
  setState({ snapshot });
}

export function prompt(title: string, value = "", okLabel = "Uložit"): Promise<string | null> {
  return new Promise((resolve) => setState({ dialog: { kind: "prompt", title, value, okLabel, resolve } }));
}

export function confirm(title: string, message?: string, okLabel = "Ano", danger = false): Promise<boolean> {
  return new Promise((resolve) =>
    setState({ dialog: { kind: "confirm", title, message, okLabel, danger, resolve: (v) => resolve(v !== null) } }),
  );
}
