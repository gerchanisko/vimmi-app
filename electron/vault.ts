// The vault: a folder of Markdown files kept fully in memory and in sync with the disk.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
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
} from "../shared/markdown";
import type { NoteMeta, Priority, SearchHit, Task, VaultSnapshot } from "../shared/types";

const IGNORED_DIRS = new Set([".git", ".obsidian", ".vimmi", ".trash", "node_modules"]);
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

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
    // Pass a copy of the string: gray-matter caches parse results by string identity.
    const parsed = matter(m[0] + "\n", {});
    if (parsed.data && typeof parsed.data === "object") data = parsed.data as Record<string, unknown>;
  } catch {
    data = {};
  }
  // gray-matter turns YAML dates into Date objects; keep them as ISO date strings.
  for (const [k, v] of Object.entries(data)) if (v instanceof Date) data[k] = v.toISOString().slice(0, 10);
  return { data, body: content.slice(m[0].length), offset: m[0].split("\n").length - 1 };
}

export class Vault extends EventEmitter {
  readonly root: string;
  private notes = new Map<string, Entry>();
  private folders = new Set<string>();
  private files = new Set<string>();
  private watcher?: fs.FSWatcher;
  private pending = new Map<string, NodeJS.Timeout>();
  /** Content we wrote ourselves, so the watcher can ignore the echo. */
  private ownWrites = new Map<string, string>();
  private emitTimer?: NodeJS.Timeout;
  /** Folder whose notes are templates: their checkboxes are not real tasks. */
  templatesFolder = "";

  constructor(root: string) {
    super();
    this.root = path.resolve(root);
  }

  // ---------- paths ----------

  /** Converts a vault-relative path to an absolute one, refusing anything outside the vault. */
  abs(rel: string): string {
    const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    const full = path.resolve(this.root, clean);
    const relative = path.relative(this.root, full);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new VaultError(`Cesta je mimo trezor: ${rel}`);
    }
    return full;
  }

  isTemplate(rel: string): boolean {
    return Boolean(this.templatesFolder) && (rel.startsWith(this.templatesFolder + "/"));
  }

  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  /** Accepts "Name", "Folder/Name" or "Folder/Name.md" and returns a normalized note path. */
  notePath(input: string): string {
    let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!/\.md$/i.test(p)) p += ".md";
    this.abs(p);
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

  // ---------- loading ----------

  async load(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
    this.notes.clear();
    this.folders.clear();
    this.files.clear();
    await this.scan(this.root);
    resolveLinks(this.metas());
    this.startWatching();
  }

  private async scan(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".")) return;
          this.folders.add(this.rel(full));
          await this.scan(full);
        } else if (e.isFile()) {
          if (e.name.startsWith(".")) return;
          if (/\.md$/i.test(e.name)) await this.readIntoIndex(full);
          else this.files.add(this.rel(full));
        }
      }),
    );
  }

  private async readIntoIndex(full: string): Promise<boolean> {
    const rel = this.rel(full);
    try {
      const [content, stat] = await Promise.all([fsp.readFile(full, "utf8"), fsp.stat(full)]);
      this.index(rel, content, stat);
      return true;
    } catch {
      return false;
    }
  }

  private index(rel: string, content: string, stat: { mtimeMs: number; birthtimeMs: number; ctimeMs: number }): void {
    const { data, body, offset } = splitFrontmatter(content);
    const meta = parseNote(rel, body, data, { mtime: stat.mtimeMs, ctime: stat.birthtimeMs || stat.ctimeMs }, offset);
    if (this.isTemplate(rel)) meta.tasks = [];
    this.notes.set(rel, { content, meta });
  }

  private startWatching(): void {
    this.watcher?.close();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join("/");
        if (rel.split("/").some((part) => part.startsWith(".") || IGNORED_DIRS.has(part))) return;
        clearTimeout(this.pending.get(rel));
        this.pending.set(rel, setTimeout(() => void this.onDiskChange(rel), 120));
      });
    } catch {
      // Recursive watching is not available everywhere; the app still works, it just won't see outside edits live.
    }
  }

  private async onDiskChange(rel: string): Promise<void> {
    this.pending.delete(rel);
    const full = path.join(this.root, rel);
    let stat: fs.Stats | undefined;
    try {
      stat = await fsp.stat(full);
    } catch {
      stat = undefined;
    }
    if (!stat) {
      const removed = this.notes.delete(rel) || this.files.delete(rel);
      let removedFolder = false;
      for (const f of [...this.folders]) {
        if (f === rel || f.startsWith(rel + "/")) {
          this.folders.delete(f);
          removedFolder = true;
        }
      }
      for (const n of [...this.notes.keys()]) if (n.startsWith(rel + "/")) this.notes.delete(n);
      if (removed || removedFolder) this.changed([rel]);
      return;
    }
    if (stat.isDirectory()) {
      if (!this.folders.has(rel)) {
        this.folders.add(rel);
        await this.scan(full);
        this.changed([rel]);
      }
      return;
    }
    if (!/\.md$/i.test(rel)) {
      if (!this.files.has(rel)) {
        this.files.add(rel);
        this.changed([rel]);
      }
      return;
    }
    const content = await fsp.readFile(full, "utf8").catch(() => null);
    if (content === null) return;
    if (this.ownWrites.get(rel) === content) {
      this.ownWrites.delete(rel);
      return;
    }
    if (this.notes.get(rel)?.content === content) return;
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

  /** Batches change notifications to the renderer. `external` marks edits made outside Vimmi. */
  private changed(paths: string[], external = false): void {
    resolveLinks(this.metas());
    for (const p of paths) this.emit("note-changed", { path: p, external });
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.emit("changed"), 60);
  }

  close(): void {
    this.watcher?.close();
    for (const t of this.pending.values()) clearTimeout(t);
  }

  // ---------- reading ----------

  metas(): NoteMeta[] {
    return [...this.notes.values()].map((e) => e.meta);
  }

  meta(rel: string): NoteMeta | undefined {
    return this.notes.get(rel)?.meta;
  }

  snapshot(): VaultSnapshot {
    return {
      root: this.root,
      name: path.basename(this.root),
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

  private async writeFile(rel: string, content: string): Promise<void> {
    const full = this.abs(rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.tmp`);
    this.ownWrites.set(rel, content);
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, full);
    const stat = await fsp.stat(full);
    this.index(rel, content, stat);
    this.ensureFolders(rel);
  }

  async write(rel: string, content: string): Promise<NoteMeta> {
    rel = this.notePath(rel);
    if (this.notes.get(rel)?.content === content) return this.notes.get(rel)!.meta;
    await this.writeFile(rel, content);
    this.changed([rel]);
    return this.notes.get(rel)!.meta;
  }

  /** Returns a free note path, adding " 1", " 2"... when the name is taken. */
  uniquePath(rel: string): string {
    rel = this.notePath(rel);
    if (!this.notes.has(rel) && !fs.existsSync(this.abs(rel))) return rel;
    const base = rel.replace(/\.md$/i, "");
    for (let i = 1; ; i++) {
      const candidate = `${base} ${i}.md`;
      if (!this.notes.has(candidate) && !fs.existsSync(this.abs(candidate))) return candidate;
    }
  }

  async create(rel: string, content = ""): Promise<string> {
    const dir = dirname(rel);
    const name = safeFileName(basename(rel));
    const target = this.uniquePath(joinPath(dir, name));
    await this.writeFile(target, content);
    this.changed([target]);
    return target;
  }

  async mkdir(rel: string): Promise<void> {
    const full = this.abs(rel);
    await fsp.mkdir(full, { recursive: true });
    this.folders.add(this.rel(full));
    this.ensureFolders(this.rel(full) + "/x");
    this.changed([rel]);
  }

  /** Renames a note or folder and rewrites [[links]] that point to moved notes. Returns the new path. */
  async rename(from: string, to: string): Promise<string> {
    const isFolder = this.folders.has(from);
    if (!isFolder) {
      from = this.notePath(from);
      if (!this.notes.has(from)) throw new VaultError(`Poznámka neexistuje: ${from}`);
      to = this.notePath(joinPath(dirname(to), safeFileName(basename(to))));
    }
    if (from === to) return to;
    if (fs.existsSync(this.abs(to)) && from.toLowerCase() !== to.toLowerCase()) {
      throw new VaultError(`Cíl už existuje: ${to}`);
    }
    const moves: [string, string][] = isFolder
      ? [...this.notes.keys()].filter((p) => p.startsWith(from + "/")).map((p) => [p, to + p.slice(from.length)])
      : [[from, to]];

    await fsp.mkdir(path.dirname(this.abs(to)), { recursive: true });
    await fsp.rename(this.abs(from), this.abs(to));

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
    }
    this.ensureFolders(to + (isFolder ? "/x" : ""));

    // Rewrite links in every note that pointed to a moved note.
    const allPaths = [...this.notes.keys()];
    const touched: string[] = [];
    for (const [notePath, entry] of [...this.notes]) {
      let text = entry.content;
      for (const [oldP, newP] of before) {
        if (entry.meta.links.some((l) => l.resolved === oldP)) {
          text = rewriteLinks(text, oldP, newP, allPaths, notePath);
        }
      }
      if (text !== entry.content) {
        await this.writeFile(notePath, text);
        touched.push(notePath);
      }
    }
    for (const [, b] of moves) {
      const e = this.notes.get(b)!;
      this.index(b, e.content, await fsp.stat(this.abs(b)));
    }
    this.changed([from, to, ...touched]);
    return to;
  }

  /** Moves a note, folder or file into the vault's .trash folder instead of deleting it. */
  async trash(rel: string): Promise<void> {
    const full = this.abs(rel);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(this.root, ".trash", `${stamp} ${path.basename(full)}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(full, dest);
    this.notes.delete(rel);
    this.files.delete(rel);
    for (const n of [...this.notes.keys()]) if (n.startsWith(rel + "/")) this.notes.delete(n);
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
    const completed = next.includes("[x]") && !/✅ \d{4}-\d{2}-\d{2}/u.test(next) ? `${next} ✅ ${isoDate()}` : next.replace(/\s*✅ \d{4}-\d{2}-\d{2}/u, "");
    lines[line] = completed;
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
    const ext = path.extname(name) || ".png";
    const base = safeFileName(path.basename(name, ext)) || "obrazek";
    let rel = joinPath(folder, base + ext);
    for (let i = 1; fs.existsSync(this.abs(rel)); i++) rel = joinPath(folder, `${base} ${i}${ext}`);
    await fsp.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fsp.writeFile(this.abs(rel), data);
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
