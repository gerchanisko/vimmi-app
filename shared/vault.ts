// The vault core: Markdown notes kept in memory, independent of where they are stored.
// Desktop stores files on disk (electron/node-storage.ts), the web app in IndexedDB (src/web/idb-storage.ts).
import { load as loadYaml } from "js-yaml";
import { Emitter } from "./emitter";
import {
  backlinksOf,
  basename,
  dirname,
  fold,
  formatTask,
  isoDate,
  joinPath,
  parseNote,
  relatedNotes,
  resolveLinks,
  rewriteLinks,
  safeFileName,
  taskDisplayText,
  toggleTaskInLine,
} from "./markdown";
import type { NoteMeta, Priority, SearchHit, Task, VaultSnapshot } from "./types";
import { NoteHistory, type VersionSource } from "./history";

export interface FileStat {
  mtime: number;
  ctime: number;
  /** True for folders (only returned by stat()). */
  dir?: boolean;
}

/** Where vault files live. All paths are vault-relative with "/" separators; hidden files are not listed. */
export interface VaultStorage {
  readonly root: string;
  readonly name: string;
  list(): Promise<{ folders: string[]; files: (FileStat & { path: string })[] }>;
  readText(rel: string): Promise<string>;
  readBytes(rel: string): Promise<Uint8Array>;
  writeText(rel: string, content: string): Promise<FileStat>;
  writeBytes(rel: string, data: Uint8Array): Promise<FileStat>;
  stat(rel: string): Promise<FileStat | null>;
  mkdir(rel: string): Promise<void>;
  /** Renames a file or folder (creating parent folders). */
  rename(from: string, to: string): Promise<void>;
  /** Moves a file or folder out of the vault into its trash. */
  trash(rel: string): Promise<void>;
  /** Called with vault-relative paths that changed outside the app (optional). */
  watch?(onChange: (rel: string) => void): () => void;
  /** Small private key-value data for the vault (sync state). */
  readPrivate(name: string): Promise<string | null>;
  writePrivate(name: string, content: string): Promise<void>;
  deletePrivate(name: string): Promise<void>;
  /** Names (without the folder) of private entries in a folder, e.g. listPrivate("chats"). */
  listPrivate(dir: string): Promise<string[]>;
}

const IGNORED = new Set([".git", ".obsidian", ".vimmi", ".trash", "node_modules"]);
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** True for paths the vault ignores: hidden files/folders and tool folders. */
export function isIgnoredPath(rel: string): boolean {
  return rel.split("/").some((part) => part.startsWith(".") || IGNORED.has(part));
}

export function isNotePath(rel: string): boolean {
  return /\.md$/i.test(rel);
}

interface Entry {
  content: string;
  meta: NoteMeta;
}

export class VaultError extends Error {}

export function splitFrontmatter(content: string): { data: Record<string, unknown>; body: string; offset: number } {
  const m = content.match(FM_RE);
  if (!m) return { data: {}, body: content, offset: 0 };
  let data: Record<string, unknown> = {};
  try {
    const parsed = loadYaml(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  for (const [k, v] of Object.entries(data)) if (v instanceof Date) data[k] = v.toISOString().slice(0, 10);
  return { data, body: content.slice(m[0].length), offset: m[0].split("\n").length - 1 };
}

/** Normalizes a vault-relative path and refuses anything that could escape the vault. */
export function cleanPath(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..") || /^[a-zA-Z]:$/.test(parts[0] ?? "")) throw new VaultError(`Cesta je mimo trezor: ${rel}`);
  return parts.join("/");
}

export class Vault extends Emitter {
  readonly storage: VaultStorage;
  private notes = new Map<string, Entry>();
  private folders = new Set<string>();
  private files = new Set<string>();
  private emitTimer?: ReturnType<typeof setTimeout>;
  private unwatch?: () => void;
  /** Folder whose notes are templates: their checkboxes are not real tasks. */
  templatesFolder = "";
  readonly history: NoteHistory;
  /** Who is changing notes right now (the AI marks its edits so they are always kept in history). */
  private actor: VersionSource = "edit";

  constructor(storage: VaultStorage) {
    super();
    this.storage = storage;
    this.history = new NoteHistory(storage);
  }

  /** Runs `fn` with its note changes recorded as made by `source` (e.g. "ai"). */
  async as<T>(source: VersionSource, fn: () => Promise<T> | T): Promise<T> {
    const before = this.actor;
    this.actor = source;
    try {
      return await fn();
    } finally {
      this.actor = before;
    }
  }

  /** Keeps the previous content in the history. Never blocks or fails the change itself. */
  private async keepVersion(rel: string, previous: string | undefined, next: string | null, source: VersionSource): Promise<void> {
    if (previous === undefined || previous === next) return;
    try {
      await this.history.capture(rel, previous, source);
    } catch {
      /* history is best effort */
    }
  }

  get root(): string {
    return this.storage.root;
  }

  get name(): string {
    return this.storage.name;
  }

  // ---------- paths ----------

  isTemplate(rel: string): boolean {
    return Boolean(this.templatesFolder) && rel.startsWith(this.templatesFolder + "/");
  }

  /** Accepts "Name", "Folder/Name" or "Folder/Name.md" and returns a normalized note path. */
  notePath(input: string): string {
    let p = cleanPath(input.trim());
    if (!isNotePath(p)) p += ".md";
    return p;
  }

  /** Finds an existing note by path or by title. */
  find(input: string): string | undefined {
    const p = this.notePath(input);
    if (this.notes.has(p)) return p;
    const lower = basename(p).toLowerCase();
    const hits = [...this.notes.keys()].filter((k) => basename(k).toLowerCase() === lower);
    return hits.sort((a, b) => a.length - b.length)[0];
  }

  has(rel: string): boolean {
    return this.notes.has(rel);
  }

  /** True when a note, attachment or folder already uses this path (case-insensitive, like most file systems). */
  private taken(rel: string): boolean {
    const lower = rel.toLowerCase();
    for (const set of [this.notes.keys(), this.files, this.folders]) for (const p of set) if (p.toLowerCase() === lower) return true;
    return false;
  }

  // ---------- loading ----------

  async load(): Promise<void> {
    this.notes.clear();
    this.folders.clear();
    this.files.clear();
    const { folders, files } = await this.storage.list();
    for (const f of folders) if (!isIgnoredPath(f)) this.folders.add(f);
    await Promise.all(
      files.map(async (f) => {
        if (isIgnoredPath(f.path)) return;
        this.ensureFolders(f.path);
        if (isNotePath(f.path)) {
          try {
            this.index(f.path, await this.storage.readText(f.path), f);
          } catch {
            /* unreadable file */
          }
        } else this.files.add(f.path);
      }),
    );
    resolveLinks(this.metas());
    this.unwatch?.();
    this.unwatch = this.storage.watch?.((rel) => void this.reloadPath(rel));
  }

  private index(rel: string, content: string, stat: FileStat): void {
    const { data, body, offset } = splitFrontmatter(content);
    const meta = parseNote(rel, body, data, stat, offset);
    if (this.isTemplate(rel)) meta.tasks = [];
    this.notes.set(rel, { content, meta });
  }

  /** Re-reads one path after it changed outside the app (disk edits, sync). */
  async reloadPath(rel: string): Promise<void> {
    if (isIgnoredPath(rel)) return;
    const stat = await this.storage.stat(rel);
    if (!stat) {
      let removed = this.notes.delete(rel) || this.files.delete(rel);
      for (const f of [...this.folders]) {
        if (f === rel || f.startsWith(rel + "/")) {
          this.folders.delete(f);
          removed = true;
        }
      }
      for (const n of [...this.notes.keys()]) if (n.startsWith(rel + "/")) this.notes.delete(n);
      for (const n of [...this.files]) if (n.startsWith(rel + "/")) this.files.delete(n);
      if (removed) this.changed([rel], true);
      return;
    }
    if (stat.dir || !isNotePath(rel)) {
      if (stat.dir) {
        if (!this.folders.has(rel)) {
          await this.load();
          this.changed([rel], true);
        }
      } else if (!this.files.has(rel)) {
        this.files.add(rel);
        this.ensureFolders(rel);
        this.changed([rel], true);
      }
      return;
    }
    const content = await this.storage.readText(rel).catch(() => null);
    if (content === null || this.notes.get(rel)?.content === content) return;
    await this.keepVersion(rel, this.notes.get(rel)?.content, content, "disk");
    this.index(rel, content, stat);
    this.ensureFolders(rel);
    this.changed([rel], true);
  }

  private ensureFolders(rel: string): void {
    let d = dirname(rel);
    while (d) {
      this.folders.add(d);
      d = dirname(d);
    }
  }

  /** Batches change notifications. `external` marks edits made outside the editor (disk, sync, AI). */
  private changed(paths: string[], external = false): void {
    resolveLinks(this.metas());
    for (const p of paths) this.emit("note-changed", { path: p, external });
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.emit("changed"), 60);
  }

  close(): void {
    this.unwatch?.();
  }

  // ---------- reading ----------

  metas(): NoteMeta[] {
    return [...this.notes.values()].map((e) => e.meta);
  }

  meta(rel: string): NoteMeta | undefined {
    return this.notes.get(rel)?.meta;
  }

  /** All vault files (notes and attachments), for sync. */
  allFiles(): { path: string; note: boolean }[] {
    return [...[...this.notes.keys()].map((path) => ({ path, note: true })), ...[...this.files].map((path) => ({ path, note: false }))];
  }

  snapshot(): VaultSnapshot {
    return {
      root: this.root,
      name: this.name,
      notes: this.metas(),
      folders: [...this.folders].sort((a, b) => a.localeCompare(b, "cs")),
      files: [...this.files].sort(),
    };
  }

  read(rel: string): string {
    const e = this.notes.get(rel);
    if (!e) throw new VaultError(`Poznámka neexistuje: ${rel}`);
    return e.content;
  }

  allTasks(): Task[] {
    return this.metas().flatMap((m) => m.tasks);
  }

  backlinks(rel: string) {
    return backlinksOf(rel, this.metas());
  }

  related(rel: string, limit?: number) {
    return relatedNotes(rel, this.metas(), limit);
  }

  tagCounts(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const m of this.metas()) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  search(query: string, opts: { limit?: number; kind?: "all" | "note" | "task" | "project" } = {}): SearchHit[] {
    const limit = opts.limit ?? 50;
    const kind = opts.kind ?? "all";
    const tagFilter = [...query.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((m) => m[1].toLowerCase());
    const pathFilter = query.match(/(?:^|\s)path:(\S+)/)?.[1];
    const terms = fold(query.replace(/(?:^|\s)#[\p{L}\p{N}_/-]+/gu, " ").replace(/(?:^|\s)path:\S+/, " "))
      .split(/\s+/)
      .filter(Boolean);
    const hits: SearchHit[] = [];

    for (const { content, meta } of this.notes.values()) {
      if (tagFilter.length && !tagFilter.every((t) => meta.tags.some((mt) => mt === t || mt.startsWith(t + "/")))) continue;
      if (pathFilter && !fold(meta.path).includes(fold(pathFilter))) continue;
      const isProject = meta.type === "project" || meta.type === "projekt";

      if (kind === "all" || kind === "note" || (kind === "project" && isProject)) {
        const title = fold(meta.title);
        const lines = content.split("\n");
        const foldedLines = lines.map(fold);
        const whole = foldedLines.join("\n");
        if (terms.every((t) => whole.includes(t) || title.includes(t))) {
          let score = 0;
          for (const t of terms) {
            if (title === t) score += 30;
            else if (title.startsWith(t)) score += 15;
            else if (title.includes(t)) score += 8;
            score += Math.min(whole.split(t).length - 1, 10);
          }
          if (!terms.length) score = 1;
          if (isProject) score += 2;
          // Newer notes win ties.
          score += Math.min(5, (meta.mtime / 1e12) % 1);
          const snippets: { line: number; text: string }[] = [];
          if (terms.length) {
            foldedLines.forEach((l, i) => {
              if (snippets.length < 3 && terms.some((t) => l.includes(t))) snippets.push({ line: i, text: lines[i].trim().slice(0, 200) });
            });
          }
          hits.push({ path: meta.path, title: meta.title, score, snippets, kind: isProject ? "project" : "note" });
        }
      }

      if ((kind === "all" || kind === "task") && terms.length) {
        for (const task of meta.tasks) {
          const t = fold(task.text);
          if (terms.every((term) => t.includes(term))) {
            hits.push({
              path: meta.path,
              title: taskDisplayText(task.text),
              score: 5 + (task.done ? 0 : 3),
              snippets: [{ line: task.line, text: task.text }],
              kind: "task",
              task,
            });
          }
        }
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---------- writing ----------

  private async writeNote(rel: string, content: string, source: VersionSource = this.actor): Promise<void> {
    await this.keepVersion(rel, this.notes.get(rel)?.content, content, source);
    const stat = await this.storage.writeText(rel, content);
    this.index(rel, content, stat);
    this.ensureFolders(rel);
  }

  async write(rel: string, content: string): Promise<NoteMeta> {
    rel = this.notePath(rel);
    if (this.notes.get(rel)?.content === content) return this.notes.get(rel)!.meta;
    await this.writeNote(rel, content);
    this.changed([rel]);
    return this.notes.get(rel)!.meta;
  }

  /** Writes any file, used by sync. Notes are re-indexed, other files become attachments. */
  async writeSynced(rel: string, data: Uint8Array): Promise<void> {
    rel = cleanPath(rel);
    if (isNotePath(rel)) {
      const content = new TextDecoder().decode(data);
      await this.writeNote(rel, content, "sync");
    } else {
      await this.storage.writeBytes(rel, data);
      this.files.add(rel);
      this.ensureFolders(rel);
    }
    this.changed([rel], true);
  }

  /** Bytes of a note or attachment, used by sync. */
  async readBytes(rel: string): Promise<Uint8Array> {
    const note = this.notes.get(rel);
    if (note) return new TextEncoder().encode(note.content);
    return this.storage.readBytes(rel);
  }

  /** Returns a free note path, adding " 1", " 2"... when the name is taken. */
  uniquePath(rel: string): string {
    rel = this.notePath(rel);
    if (!this.taken(rel)) return rel;
    const base = rel.replace(/\.md$/i, "");
    for (let i = 1; ; i++) {
      const candidate = `${base} ${i}.md`;
      if (!this.taken(candidate)) return candidate;
    }
  }

  async create(rel: string, content = ""): Promise<string> {
    const dir = dirname(cleanPath(rel));
    const name = safeFileName(basename(rel));
    const target = this.uniquePath(joinPath(dir, name));
    await this.writeNote(target, content);
    this.changed([target]);
    return target;
  }

  async mkdir(rel: string): Promise<void> {
    rel = cleanPath(rel);
    await this.storage.mkdir(rel);
    this.folders.add(rel);
    this.ensureFolders(rel + "/x");
    this.changed([rel]);
  }

  /** Renames a note or folder and rewrites [[links]] that point to moved notes. Returns the new path. */
  async rename(from: string, to: string): Promise<string> {
    const isFolder = this.folders.has(from);
    if (!isFolder) {
      from = this.notePath(from);
      if (!this.notes.has(from)) throw new VaultError(`Poznámka neexistuje: ${from}`);
      to = this.notePath(joinPath(dirname(cleanPath(to)), safeFileName(basename(to))));
    } else {
      to = cleanPath(to);
    }
    if (from === to) return to;
    if (this.taken(to) && from.toLowerCase() !== to.toLowerCase()) throw new VaultError(`Cíl už existuje: ${to}`);
    const moves: [string, string][] = isFolder
      ? [...this.notes.keys()].filter((p) => p.startsWith(from + "/")).map((p) => [p, to + p.slice(from.length)])
      : [[from, to]];

    await this.storage.rename(from, to);
    for (const [a, b] of moves) await this.history.move(a, b).catch(() => {});

    const before = new Map(moves);
    const entries = moves.map(([a]) => this.notes.get(a)!);
    for (const [a] of moves) this.notes.delete(a);
    moves.forEach(([, b], i) => {
      const e = entries[i];
      this.notes.set(b, { content: e.content, meta: { ...e.meta, path: b, title: basename(b), folder: dirname(b) } });
    });
    if (isFolder) {
      for (const f of [...this.folders]) {
        if (f === from || f.startsWith(from + "/")) {
          this.folders.delete(f);
          this.folders.add(to + f.slice(from.length));
        }
      }
      for (const f of [...this.files]) {
        if (f.startsWith(from + "/")) {
          this.files.delete(f);
          this.files.add(to + f.slice(from.length));
        }
      }
    }
    this.ensureFolders(to + (isFolder ? "/x" : ""));

    // Rewrite links in every note that pointed to a moved note.
    const allPaths = [...this.notes.keys()];
    const touched: string[] = [];
    for (const [notePath, entry] of [...this.notes]) {
      let text = entry.content;
      for (const [oldP, newP] of before) {
        if (entry.meta.links.some((l) => l.resolved === oldP)) text = rewriteLinks(text, oldP, newP, allPaths, notePath);
      }
      if (text !== entry.content) {
        await this.writeNote(notePath, text);
        touched.push(notePath);
      }
    }
    for (const [, b] of moves) {
      const e = this.notes.get(b)!;
      this.index(b, e.content, (await this.storage.stat(b)) ?? { mtime: Date.now(), ctime: Date.now() });
    }
    this.changed([from, to, ...touched]);
    return to;
  }

  /** Moves a note, folder or file into the vault's trash instead of deleting it. */
  async trash(rel: string): Promise<void> {
    rel = cleanPath(rel);
    for (const [p, e] of this.notes) if (p === rel || p.startsWith(rel + "/")) await this.keepVersion(p, e.content, null, "trash");
    await this.storage.trash(rel);
    this.notes.delete(rel);
    this.files.delete(rel);
    for (const n of [...this.notes.keys()]) if (n.startsWith(rel + "/")) this.notes.delete(n);
    for (const n of [...this.files]) if (n.startsWith(rel + "/")) this.files.delete(n);
    for (const f of [...this.folders]) if (f === rel || f.startsWith(rel + "/")) this.folders.delete(f);
    this.changed([rel]);
  }

  async toggleTask(rel: string, line: number, done?: boolean): Promise<void> {
    const content = this.read(rel);
    const lines = content.split("\n");
    if (line < 0 || line >= lines.length) throw new VaultError("Řádek s úkolem neexistuje.");
    const next = toggleTaskInLine(lines[line], done);
    if (next === lines[line]) throw new VaultError("Na tomto řádku není úkol.");
    // Record the completion date like Obsidian Tasks does.
    lines[line] =
      next.includes("[x]") && !/✅ \d{4}-\d{2}-\d{2}/u.test(next) ? `${next} ✅ ${isoDate()}` : next.replace(/\s*✅ \d{4}-\d{2}-\d{2}/u, "");
    await this.write(rel, lines.join("\n"));
  }

  /** Appends a task to a note (creating it if needed). Returns the note path. */
  async addTask(text: string, opts: { path?: string; due?: string; priority?: Priority; heading?: string } = {}): Promise<string> {
    const rel = opts.path ? (this.find(opts.path) ?? this.notePath(opts.path)) : this.notePath("Úkoly");
    const line = formatTask(text, { due: opts.due, priority: opts.priority });
    const current = this.notes.has(rel) ? this.read(rel) : `# ${basename(rel)}\n`;
    await this.write(rel, insertUnderHeading(current, line, opts.heading));
    return rel;
  }

  async append(rel: string, text: string, heading?: string): Promise<void> {
    const current = this.notes.has(rel) ? this.read(rel) : "";
    await this.write(rel, insertUnderHeading(current, text, heading));
  }

  async saveAttachment(name: string, data: Uint8Array, folder: string): Promise<string> {
    const m = name.match(/(\.[a-z0-9]+)$/i);
    const ext = m ? m[1] : ".png";
    const base = safeFileName(basename(name).replace(/\.[a-z0-9]+$/i, "")) || "obrazek";
    let rel = joinPath(cleanPath(folder), base + ext);
    for (let i = 1; this.taken(rel); i++) rel = joinPath(cleanPath(folder), `${base} ${i}${ext}`);
    await this.storage.writeBytes(rel, data);
    this.files.add(rel);
    this.ensureFolders(rel);
    this.changed([rel]);
    return rel;
  }
}

/** Inserts text at the end of the section under `heading`, or at the end of the note. */
export function insertUnderHeading(content: string, text: string, heading?: string): string {
  const lines = content.split("\n");
  if (heading) {
    const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
    const idx = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === want);
    if (idx !== -1) {
      const level = lines[idx].match(/^#+/)![0].length;
      let end = lines.length;
      for (let i = idx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#+)\s/);
        if (m && m[1].length <= level) {
          end = i;
          break;
        }
      }
      while (end > idx + 1 && lines[end - 1].trim() === "") end--;
      lines.splice(end, 0, text);
      return lines.join("\n");
    }
    const trimmed = content.replace(/\s+$/, "");
    return `${trimmed}${trimmed ? "\n\n" : ""}## ${heading.replace(/^#+\s*/, "")}\n${text}\n`;
  }
  const trimmed = content.replace(/\s+$/, "");
  return `${trimmed}${trimmed ? "\n" : ""}${text}\n`;
}
