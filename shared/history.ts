// Version history of notes, kept privately on the device (.vimmi/history on desktop, IndexedDB
// in the web app), so even AI edits, sync overwrites and deletions can be undone offline.
// A version is the note's content *before* a change. With sync on, GitHub keeps the long-term history.
import type { VaultStorage } from "./vault";

export type VersionSource = "edit" | "ai" | "sync" | "disk" | "trash" | "restore";

export interface NoteVersion {
  id: string;
  /** When the version was replaced (ms). */
  at: number;
  source: VersionSource | "github";
  /** Device name for GitHub versions (from the commit message). */
  device?: string;
  size?: number;
}

/** At most this many local versions per note. */
const KEEP = 60;
/** While typing, keep at most one version per this interval. */
const EDIT_INTERVAL_MS = 10 * 60_000;

/** Stable short folder name for a note path (paths can be too long or odd for file names). */
export function historyKey(path: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

const dir = (path: string) => `history/${historyKey(path)}`;

function parseId(id: string): NoteVersion | null {
  const m = id.match(/^(\d+)-([a-z]+)\.md$/);
  return m ? { id, at: Number(m[1]), source: m[2] as VersionSource } : null;
}

export class NoteHistory {
  /** Last captured time and content per note (avoids listing storage on every keystroke). */
  private last = new Map<string, { at: number; content: string }>();

  constructor(private storage: VaultStorage) {}

  async list(path: string): Promise<NoteVersion[]> {
    const names = await this.storage.listPrivate(dir(path));
    return names
      .map(parseId)
      .filter((v): v is NoteVersion => v !== null)
      .sort((a, b) => b.at - a.at);
  }

  async read(path: string, id: string): Promise<string | null> {
    if (!/^\d+-[a-z]+\.md$/.test(id)) return null;
    return this.storage.readPrivate(`${dir(path)}/${id}`);
  }

  /**
   * Saves `previous` (the content about to be replaced). Ordinary edits are throttled; AI edits,
   * sync, deletions and restores are always kept, so they can be undone.
   */
  async capture(path: string, previous: string, source: VersionSource): Promise<void> {
    if (!previous.trim()) return;
    const now = Date.now();
    let last = this.last.get(path);
    if (!last) {
      const newest = (await this.list(path))[0];
      if (newest) last = { at: newest.at, content: (await this.read(path, newest.id)) ?? "" };
    }
    if (last && last.content === previous) return;
    if (source === "edit" || source === "disk") {
      if (last && now - last.at < EDIT_INTERVAL_MS) return;
    }
    const at = last && now <= last.at ? last.at + 1 : now;
    await this.storage.writePrivate(`${dir(path)}/${at}-${source}.md`, previous);
    this.last.set(path, { at, content: previous });
    const versions = await this.list(path);
    for (const old of versions.slice(KEEP)) await this.storage.deletePrivate(`${dir(path)}/${old.id}`);
  }

  /** Keeps the history when a note is renamed or moved. */
  async move(from: string, to: string): Promise<void> {
    for (const v of await this.list(from)) {
      const content = await this.read(from, v.id);
      if (content !== null) await this.storage.writePrivate(`${dir(to)}/${v.id}`, content);
      await this.storage.deletePrivate(`${dir(from)}/${v.id}`);
    }
    const last = this.last.get(from);
    if (last) this.last.set(to, last);
    this.last.delete(from);
  }
}
