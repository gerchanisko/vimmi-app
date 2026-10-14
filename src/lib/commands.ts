// All commands: shown in the palette (Ctrl+P) and bound to keyboard shortcuts.
import { QUICK_ACTIONS, runQuick } from "../components/AiQuick";
import {
  askAi,
  closeActiveTab,
  cycleTab,
  newFolder,
  newNote,
  openDaily,
  renamePath,
  switchVault,
  toggleBookmark,
  toggleMode,
  toggleRight,
  trashPath,
} from "./actions";
import { flushAll } from "./docs";
import { activeNotePath, getState, openView, setState } from "./store";

export interface Command {
  id: string;
  label: string;
  icon?: string;
  /** Display string, e.g. "Ctrl+K". */
  shortcut?: string;
  /** Key binding: "Mod+Shift+F" (Mod = Ctrl, or Cmd on macOS). */
  keys?: string;
  keywords?: string;
  when?: () => boolean;
  run: () => void;
}

const hasNote = () => Boolean(activeNotePath());

export const COMMANDS: Command[] = [
  { id: "search", label: "Hledat a otevřít", icon: "search", keys: "Mod+K", shortcut: "Ctrl+K", keywords: "najít quick switcher", run: () => setState({ overlay: { type: "spotlight" } }) },
  { id: "search-o", label: "Rychle otevřít poznámku", icon: "search", keys: "Mod+O", shortcut: "Ctrl+O", run: () => setState({ overlay: { type: "spotlight" } }) },
  { id: "palette", label: "Paleta příkazů", icon: "command", keys: "Mod+P", shortcut: "Ctrl+P", run: () => setState({ overlay: { type: "commands" } }) },
  { id: "full-search", label: "Hledat v obsahu všech poznámek", icon: "search", keys: "Mod+Shift+F", shortcut: "Ctrl+Shift+F", run: () => openView("search", getState().selection || "") },
  { id: "new-note", label: "Nová poznámka", icon: "pen", keys: "Mod+N", shortcut: "Ctrl+N", run: () => void newNote() },
  { id: "new-from-template", label: "Nová poznámka ze šablony", icon: "template", keys: "Mod+Shift+N", shortcut: "Ctrl+Shift+N", keywords: "šablona template", run: () => setState({ overlay: { type: "template" } }) },
  { id: "new-folder", label: "Nová složka", icon: "folder-plus", run: () => void newFolder("") },
  { id: "daily", label: "Dnešní poznámka (deník)", icon: "calendar", keys: "Mod+D", shortcut: "Ctrl+D", keywords: "deník daily journal", run: () => void openDaily() },
  { id: "daily-yesterday", label: "Včerejší poznámka", icon: "calendar", run: () => void openDaily(-1) },
  { id: "daily-tomorrow", label: "Zítřejší poznámka", icon: "calendar", run: () => void openDaily(1) },
  { id: "today", label: "Přehled Dnes", icon: "today", keys: "Mod+Shift+T", shortcut: "Ctrl+Shift+T", run: () => openView("today") },
  { id: "calendar", label: "Kalendář", icon: "calendar", keys: "Mod+Shift+K", shortcut: "Ctrl+Shift+K", keywords: "calendar události schůzky", run: () => openView("calendar") },
  { id: "tasks", label: "Všechny úkoly", icon: "task", keys: "Mod+Shift+U", shortcut: "Ctrl+Shift+U", run: () => openView("tasks") },
  { id: "projects", label: "Projekty", icon: "project", run: () => openView("projects") },
  { id: "graph", label: "Graf souvislostí", icon: "graph", keys: "Mod+G", shortcut: "Ctrl+G", run: () => openView("graph") },
  { id: "local-graph", label: "Lokální graf aktuální poznámky", icon: "graph", when: hasNote, run: () => openView("graph", activeNotePath()) },
  { id: "toggle-mode", label: "Přepnout náhled / úpravy", icon: "book", keys: "Mod+E", shortcut: "Ctrl+E", when: hasNote, run: toggleMode },
  { id: "ai", label: "AI asistent", icon: "sparkle", keys: "Mod+J", shortcut: "Ctrl+J", keywords: "claude chat", run: () => toggleRight("ai") },
  { id: "ai-selection", label: "Zeptat se AI na označený text", icon: "bot", keys: "Mod+Shift+J", shortcut: "Ctrl+Shift+J", run: () => askAi(getState().selection ? "K označenému textu: " : "") },
  ...QUICK_ACTIONS.map((q) => ({
    id: `ai-${q.action}`,
    label: `AI: ${q.label}`,
    icon: q.icon,
    keywords: "claude",
    when: hasNote,
    run: () => void runQuick(q.action, q.label),
  })),
  { id: "links", label: "Panel odkazů", icon: "link", keys: "Mod+Shift+B", shortcut: "Ctrl+Shift+B", keywords: "backlinks zpětné", run: () => toggleRight("links") },
  { id: "outline", label: "Osnova poznámky", icon: "outline", keys: "Mod+Shift+O", shortcut: "Ctrl+Shift+O", run: () => toggleRight("outline") },
  { id: "info", label: "Informace o poznámce", icon: "info", run: () => toggleRight("info") },
  { id: "sidebar", label: "Skrýt / zobrazit levý panel", icon: "panel-left", keys: "Mod+\\", shortcut: "Ctrl+\\", run: () => setState((s) => ({ leftOpen: !s.leftOpen })) },
  { id: "close-tab", label: "Zavřít kartu", icon: "close", keys: "Mod+W", shortcut: "Ctrl+W", run: closeActiveTab },
  { id: "next-tab", label: "Další karta", icon: "arrow", keys: "Ctrl+Tab", shortcut: "Ctrl+Tab", run: () => cycleTab(1) },
  { id: "prev-tab", label: "Předchozí karta", icon: "arrow", keys: "Ctrl+Shift+Tab", shortcut: "Ctrl+Shift+Tab", run: () => cycleTab(-1) },
  { id: "rename", label: "Přejmenovat poznámku", icon: "rename", keys: "F2", shortcut: "F2", when: hasNote, run: () => void renamePath(activeNotePath()!) },
  { id: "bookmark", label: "Přidat / odebrat záložku", icon: "star", when: hasNote, run: () => toggleBookmark(activeNotePath()!) },
  { id: "trash", label: "Přesunout poznámku do koše", icon: "trash", when: hasNote, run: () => void trashPath(activeNotePath()!) },
  { id: "save", label: "Uložit", icon: "check", keys: "Mod+S", shortcut: "Ctrl+S", run: () => void flushAll() },
  { id: "settings", label: "Nastavení", icon: "settings", keys: "Mod+,", shortcut: "Ctrl+,", run: () => setState({ overlay: { type: "settings" } }) },
  { id: "ai-key", label: "Nastavit Claude API klíč", icon: "key", keywords: "api klíč anthropic", run: () => setState({ overlay: { type: "settings", tab: "ai" } }) },
  { id: "switch-vault", label: "Otevřít jiný trezor", icon: "folder-open", run: () => void switchVault() },
  {
    id: "theme",
    label: "Přepnout světlý / tmavý vzhled",
    icon: "moon",
    run: () => {
      const s = getState().settings;
      if (!s) return;
      const dark = s.theme === "dark" || (s.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      void window.vimmi.settings.set({ theme: dark ? "light" : "dark" }).then((settings) => setState({ settings: { ...s, ...settings } }));
    },
  },
];

function matches(binding: string, e: KeyboardEvent): boolean {
  const parts = binding.split("+");
  const key = parts.pop()!;
  const mac = window.vimmi.app.platform === "darwin";
  const want = {
    ctrl: parts.includes("Ctrl") || (!mac && parts.includes("Mod")),
    meta: mac && parts.includes("Mod"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
  if (e.ctrlKey !== want.ctrl || e.metaKey !== want.meta || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return k === key.toUpperCase() || (key === "\\" && e.code === "Backslash") || (key.length === 1 && e.code === `Key${key.toUpperCase()}`);
}

export function handleShortcut(e: KeyboardEvent): boolean {
  for (const c of COMMANDS) {
    if (c.keys && matches(c.keys, e) && (!c.when || c.when())) {
      e.preventDefault();
      c.run();
      return true;
    }
  }
  return false;
}
