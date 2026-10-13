// User actions shared by shortcuts, menus and the command palette.
import { basename, dirname, isoDate, joinPath } from "../../shared/markdown";
import { flushAll, forgetPrefix } from "./docs";
import {
  activeNotePath,
  activeTab,
  closeTab,
  confirm,
  errorText,
  getState,
  openNote,
  openView,
  prompt,
  refreshSnapshot,
  renamePathInTabs,
  setState,
  toast,
} from "./store";

const api = () => window.vimmi;

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    toast(errorText(err), "error");
    return undefined;
  }
}

export async function newNote(folder?: string, title?: string): Promise<void> {
  const name = title ?? (await prompt("Název nové poznámky", "", "Vytvořit"));
  if (!name) return;
  const dir = folder ?? dirname(activeNotePath() ?? "");
  const path = await attempt(() => api().vault.create(joinPath(dir, name), `# ${name}\n\n`));
  if (!path) return;
  await refreshSnapshot();
  openNote(path, { newTab: true, line: 2 });
}

export async function newFolder(parent = ""): Promise<void> {
  const name = await prompt("Název nové složky", "", "Vytvořit");
  if (!name) return;
  await attempt(() => api().vault.mkdir(joinPath(parent, name)));
  await refreshSnapshot();
}

export async function openDaily(offsetDays = 0): Promise<void> {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const path = await attempt(() => api().vault.daily(isoDate(d)));
  if (!path) return;
  await refreshSnapshot();
  openNote(path);
}

export async function renamePath(path: string, isFolder = false, suggestion?: string): Promise<void> {
  const current = basename(path);
  const name = await prompt(isFolder ? "Přejmenovat složku" : "Přejmenovat poznámku", suggestion ?? current, "Přejmenovat");
  if (!name || name === current) return;
  const target = joinPath(dirname(path), isFolder ? name : `${name}.md`);
  await flushAll();
  const result = await attempt(() => api().vault.rename(path, target));
  if (!result) return;
  forgetPrefix(path);
  renamePathInTabs(path, result);
  await refreshSnapshot();
}

export async function movePath(path: string, folder: string): Promise<void> {
  const name = path.split("/").pop()!;
  const target = joinPath(folder, name);
  if (target === path) return;
  await flushAll();
  const result = await attempt(() => api().vault.rename(path, target));
  if (!result) return;
  forgetPrefix(path);
  renamePathInTabs(path, result);
  await refreshSnapshot();
}

export async function trashPath(path: string, isFolder = false): Promise<void> {
  const ok = await confirm(
    isFolder ? `Přesunout složku „${basename(path)}“ do koše?` : `Přesunout „${basename(path)}“ do koše?`,
    "Soubory najdeš ve složce .trash uvnitř trezoru.",
    "Do koše",
    true,
  );
  if (!ok) return;
  await attempt(() => api().vault.trash(path));
  forgetPrefix(path);
  setState((s) => ({
    tabs: s.tabs.filter((t) => !(t.kind === "note" && (t.path === path || t.path.startsWith(path + "/")))),
  }));
  setState((s) => ({ active: s.tabs.some((t) => t.id === s.active) ? s.active : (s.tabs.at(-1)?.id ?? null) }));
  await refreshSnapshot();
}

export function toggleBookmark(path: string): void {
  setState((s) => ({ bookmarks: s.bookmarks.includes(path) ? s.bookmarks.filter((b) => b !== path) : [...s.bookmarks, path] }));
}

export async function toggleTask(path: string, line: number, done?: boolean): Promise<void> {
  await flushAll();
  await attempt(() => api().vault.toggleTask(path, line, done));
  await refreshSnapshot();
}

export function toggleRight(panel: "ai" | "links" | "outline" | "info"): void {
  setState((s) => ({ right: s.right === panel ? null : panel }));
}

export function toggleMode(): void {
  const tab = activeTab();
  if (tab?.kind !== "note") return;
  setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tab.id && t.kind === "note" ? { ...t, mode: t.mode === "edit" ? "read" : "edit" } : t)),
  }));
}

export function closeActiveTab(): void {
  const id = getState().active;
  if (id) closeTab(id);
}

export function cycleTab(dir: 1 | -1): void {
  const { tabs, active } = getState();
  if (!tabs.length) return;
  const idx = tabs.findIndex((t) => t.id === active);
  setState({ active: tabs[(idx + dir + tabs.length) % tabs.length].id });
}

export function askAi(text?: string): void {
  setState({ right: "ai", aiDraft: text ?? null });
}

export async function newFromTemplate(template: string): Promise<void> {
  const name = await prompt("Název nové poznámky", basename(template) === "Schůzka" ? `Schůzka ${isoDate()}` : "", "Vytvořit");
  if (!name) return;
  const path = await attempt(() => api().vault.fromTemplate(template, name, dirname(activeNotePath() ?? "")));
  if (!path) return;
  await refreshSnapshot();
  openNote(path, { newTab: true });
}

export async function switchVault(): Promise<void> {
  await api().vault.close();
  setState({ snapshot: null, tabs: [], active: null });
}

export { openView };
