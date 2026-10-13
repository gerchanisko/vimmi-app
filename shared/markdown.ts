// Pure Markdown parsing helpers: wikilinks, tags, tasks, headings.
// No Node or DOM APIs here, so the renderer, the main process and tests can all use it.
import type { Heading, LinkRef, NoteMeta, Priority, Task } from "./types";

export const WIKILINK_RE = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
const MD_LINK_RE = /\[[^\]\n]*\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g;
export const TAG_RE = /(^|[\s(,])#([\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gu;
export const TASK_RE = /^(\s*)[-*+] \[([ xX])\] (.*)$/;
const DUE_RE = /(?:📅\s*|(?:^|\s)@)(\d{4}-\d{2}-\d{2})\b/u;
const PRIO_RE = /(?:^|\s)!([123])(?=\s|$)/;
const EMOJI_PRIO: Record<string, Priority> = { "⏫": 1, "🔺": 1, "🔼": 2, "🔽": 3 };

export function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

/** Removes characters that are invalid in file names on common systems. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "Bez názvu";
}

export function isoDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** Splits text into lines and marks which lines are inside fenced code blocks. */
function codeMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) {
        mask.push(true);
        fence = null;
        continue;
      }
      mask.push(true);
      continue;
    }
    mask.push(fence !== null);
  }
  return mask;
}

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) tags.add(m[2].toLowerCase());
  return [...tags];
}

export function parseTaskLine(line: string): Omit<Task, "path" | "line" | "project"> | null {
  const m = line.match(TASK_RE);
  if (!m) return null;
  const body = m[3];
  const due = body.match(DUE_RE)?.[1];
  let priority = body.match(PRIO_RE)?.[1] ? (Number(body.match(PRIO_RE)![1]) as Priority) : undefined;
  if (!priority) {
    for (const [emoji, p] of Object.entries(EMOJI_PRIO)) if (body.includes(emoji)) priority = p;
  }
  return { text: body.trim(), done: m[2] !== " ", due, priority, tags: extractTags(body) };
}

/** Task text without the metadata markers, for display. */
/** Removes task metadata markers (dates, priorities, completion stamps). */
function stripTaskMeta(text: string): string {
  return text
    .replace(/✅\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/(^|\s)@\d{4}-\d{2}-\d{2}\b/g, "$1")
    .replace(/(^|\s)![123](?=\s|$)/g, "$1")
    .replace(/[⏫🔺🔼🔽]/gu, "");
}

/** Task text for display: no metadata markers, [[links]] shown as their label. */
export function taskDisplayText(text: string): string {
  return stripTaskMeta(text)
    .replace(WIKILINK_RE, (_m, target: string, _h, alias?: string) => alias || target)
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function toggleTaskInLine(line: string, done?: boolean): string {
  const m = line.match(TASK_RE);
  if (!m) return line;
  const next = done ?? m[2] === " ";
  return line.replace(/\[([ xX])\]/, next ? "[x]" : "[ ]");
}

/** Builds a task line in Vimmi's syntax: "- [ ] text @2026-10-14 !1". */
export function formatTask(text: string, opts: { due?: string; priority?: Priority; indent?: string } = {}): string {
  let line = `${opts.indent ?? ""}- [ ] ${text.trim()}`;
  if (opts.due) line += ` @${opts.due}`;
  if (opts.priority) line += ` !${opts.priority}`;
  return line;
}

export function wordCount(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

export function tagsFromFrontmatter(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  return list
    .map((t) => String(t).replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean);
}

function projectFromFrontmatter(fm: Record<string, unknown>): string | undefined {
  const raw = fm.project ?? fm.projekt;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return raw.replace(/^\[\[|\]\]$/g, "").trim();
}

/**
 * Parses a note body (without frontmatter) into metadata.
 * Links are returned unresolved; call resolveLinks() once all notes are known.
 */
export function parseNote(
  path: string,
  body: string,
  frontmatter: Record<string, unknown>,
  stat: { mtime: number; ctime: number },
  bodyLineOffset = 0,
): NoteMeta {
  const lines = body.split("\n");
  const mask = codeMask(lines);
  const tags = new Set(tagsFromFrontmatter(frontmatter));
  const links: LinkRef[] = [];
  const headings: Heading[] = [];
  const tasks: Task[] = [];
  const type = typeof frontmatter.type === "string" ? frontmatter.type.toLowerCase() : undefined;
  const title = basename(path);
  const project = type === "project" || type === "projekt" ? title : projectFromFrontmatter(frontmatter);

  lines.forEach((rawLine, i) => {
    if (mask[i]) return;
    const line = stripInlineCode(rawLine);
    const lineNo = i + bodyLineOffset;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) headings.push({ level: h[1].length, text: h[2], line: lineNo });
    else for (const t of extractTags(line)) tags.add(t);
    for (const m of line.matchAll(WIKILINK_RE)) links.push({ target: m[1].trim(), line: lineNo });
    for (const m of line.matchAll(MD_LINK_RE)) {
      if (/^[a-z]+:/i.test(m[1])) continue;
      links.push({ target: decodeURI(m[1]).replace(/\.md$/i, ""), line: lineNo });
    }
    const task = parseTaskLine(line);
    if (task && task.text) tasks.push({ ...task, text: rawLine.match(TASK_RE)![3].trim(), path, line: lineNo, project });
  });

  const plain = stripTaskMeta(
    body
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^\s*#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
      .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
      .replace(WIKILINK_RE, (_m, target: string, _h, alias?: string) => alias || target)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/(^|\s)[*_](\S)/g, "$1$2")
      .replace(/(\S)[*_](?=\s|$)/g, "$1"),
  )
    .replace(/\s+/g, " ")
    .trim();

  return {
    path,
    title,
    folder: dirname(path),
    tags: [...tags].sort(),
    links,
    headings,
    tasks,
    frontmatter,
    type,
    project,
    mtime: stat.mtime,
    ctime: stat.ctime,
    words: wordCount(body),
    excerpt: plain.slice(0, 200),
  };
}

/** Finds the note a wikilink target points to. Matches full path first, then file name (case-insensitive). */
export function resolveLinkTarget(target: string, paths: string[], fromPath?: string): string | undefined {
  const clean = target.split("#")[0].trim().replace(/\.md$/i, "");
  if (!clean) return fromPath;
  const lower = clean.toLowerCase();
  const exact = paths.find((p) => p.replace(/\.md$/i, "").toLowerCase() === lower);
  if (exact) return exact;
  if (fromPath) {
    const rel = joinPath(dirname(fromPath), clean).toLowerCase();
    const relHit = paths.find((p) => p.replace(/\.md$/i, "").toLowerCase() === rel);
    if (relHit) return relHit;
  }
  const byName = paths.filter((p) => basename(p).toLowerCase() === basename(lower));
  if (byName.length <= 1) return byName[0];
  // Prefer the shortest path, like Obsidian.
  return byName.sort((a, b) => a.length - b.length)[0];
}

export function resolveLinks(notes: NoteMeta[]): void {
  const paths = notes.map((n) => n.path);
  for (const note of notes) {
    for (const link of note.links) link.resolved = resolveLinkTarget(link.target, paths, note.path);
  }
}

export interface Backlink {
  path: string;
  title: string;
  lines: number[];
}

export function backlinksOf(path: string, notes: NoteMeta[]): Backlink[] {
  const out: Backlink[] = [];
  for (const n of notes) {
    if (n.path === path) continue;
    const lines = n.links.filter((l) => l.resolved === path).map((l) => l.line);
    if (lines.length) out.push({ path: n.path, title: n.title, lines });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, "cs"));
}

/** Rewrites [[Old]] links to [[New]] after a rename, keeping headings and aliases. */
export function rewriteLinks(text: string, oldPath: string, newPath: string, allPaths: string[], fromPath: string): string {
  const newName = allPaths.filter((p) => basename(p).toLowerCase() === basename(newPath).toLowerCase()).length > 1
    ? newPath.replace(/\.md$/i, "")
    : basename(newPath);
  return text.replace(WIKILINK_RE, (full, target: string, heading = "", alias?: string) => {
    const resolved = resolveLinkTarget(target, [...allPaths.filter((p) => p !== newPath), oldPath], fromPath);
    if (resolved !== oldPath) return full;
    return `[[${newName}${heading}${alias !== undefined ? `|${alias}` : ""}]]`;
  });
}

/** Very small related-notes score: shared tags, shared links and direct links. */
export function relatedNotes(path: string, notes: NoteMeta[], limit = 8): { path: string; title: string; score: number }[] {
  const me = notes.find((n) => n.path === path);
  if (!me) return [];
  const myLinks = new Set(me.links.map((l) => l.resolved).filter(Boolean));
  const myTags = new Set(me.tags);
  const scored = notes
    .filter((n) => n.path !== path)
    .map((n) => {
      let score = 0;
      for (const t of n.tags) if (myTags.has(t)) score += 2;
      if (myLinks.has(n.path)) score += 3;
      if (n.links.some((l) => l.resolved === path)) score += 3;
      for (const l of n.links) if (l.resolved && myLinks.has(l.resolved)) score += 1;
      if (me.project && n.project === me.project) score += 2;
      return { path: n.path, title: n.title, score };
    })
    .filter((s) => s.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Normalizes text for accent-insensitive search ("úkol" matches "ukol"). */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
