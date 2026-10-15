import { useEffect, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Range, RangeSetBuilder, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { vim } from "@replit/codemirror-vim";
import { basename } from "../../shared/markdown";
import { imagePreview, insertImages, pickImages } from "../lib/editor-images";
import { getState, openNote, openView, resolveLink, setState, toast } from "../lib/store";

// ---------- registry so other parts of the UI (AI actions) can reach the active editor ----------

let activeEditor: { view: EditorView; path: string } | null = null;
export function getActiveEditor() {
  return activeEditor;
}

// ---------- highlighting ----------

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.35em", fontWeight: "650" },
  { tag: t.heading3, fontSize: "1.17em", fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent-text)" },
  { tag: t.url, color: "var(--text-3)" },
  { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.92em", color: "var(--clay)" },
  { tag: t.quote, color: "var(--text-2)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--text-3)" },
  { tag: t.keyword, color: "var(--accent-text)" },
  { tag: [t.string, t.special(t.string)], color: "var(--sage)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--ochre)" },
  { tag: t.comment, color: "var(--text-3)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.propertyName], color: "var(--blue)" },
  { tag: t.typeName, color: "var(--clay)" },
]);

// ---------- wikilinks, tags and checkboxes ----------

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-check";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "Splněno" : "Nesplněno");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const text = view.state.doc.sliceString(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(text)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

const linkMark = Decoration.mark({ class: "cm-wikilink" });
const tagMark = Decoration.mark({ class: "cm-hashtag" });
const doneLine = Decoration.line({ class: "cm-task-done" });
const frontmatterLine = Decoration.line({ class: "cm-frontmatter" });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    let inFence = false;
    // Detect whether the first visible line starts inside a code fence.
    const before = view.state.doc.sliceString(0, from);
    inFence = (before.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 === 1;
    // Frontmatter ends at the second "---" line; no tags or tasks are drawn inside it.
    const fm = view.state.doc.sliceString(0, Math.min(view.state.doc.length, 4000)).match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    const fmEnd = fm ? fm[0].length : 0;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      if (line.to <= fmEnd) {
        builder.add(line.from, line.from, frontmatterLine);
      } else if (/^\s*(```|~~~)/.test(text)) inFence = !inFence;
      else if (!inFence) {
        const marks: { from: number; to: number; deco: Decoration }[] = [];
        const task = text.match(/^(\s*[-*+] )\[([ xX])\] /);
        if (task) {
          if (task[2] !== " ") builder.add(line.from, line.from, doneLine);
          const start = line.from + task[1].length;
          marks.push({ from: start, to: start + 3, deco: Decoration.replace({ widget: new CheckboxWidget(task[2] !== " ", start) }) });
        }
        // Blank out inline code so `[[` or `#` inside backticks is not decorated.
        const plain = text.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
        for (const m of plain.matchAll(/!?\[\[[^\]\n]+\]\]/g)) {
          marks.push({ from: line.from + m.index!, to: line.from + m.index! + m[0].length, deco: linkMark });
        }
        if (!/^#{1,6}\s/.test(text)) {
          for (const m of plain.matchAll(/(^|[\s(,])(#[\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gu)) {
            const start = line.from + m.index! + m[1].length;
            marks.push({ from: start, to: start + m[2].length, deco: tagMark });
          }
        }
        marks.sort((a, b) => a.from - b.from);
        let last = -1;
        for (const mk of marks) {
          if (mk.from < last) continue;
          builder.add(mk.from, mk.to, mk.deco);
          last = mk.to;
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------- live preview: hide Markdown syntax except on lines being edited ----------

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
}

class ChipWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string, readonly title: string) {
    super();
  }
  eq(other: ChipWidget) {
    return other.text === this.text && other.cls === this.cls;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.text;
    span.title = this.title;
    return span;
  }
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const quoteLine = Decoration.line({ class: "cm-quote-line" });
const mdLink = Decoration.mark({ class: "cm-md-link" });

function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) lines.add(i);
  }
  return lines;
}

function buildLivePreview(view: EditorView): DecorationSet {
  const { doc } = view.state;
  const active = activeLines(view);
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const out: Range<Decoration>[] = [];
  const hide = (from: number, to: number) => {
    if (to > from && !isActive(from)) out.push(hidden.range(from, to));
  };
  const nextIsSpace = (pos: number) => doc.sliceString(pos, pos + 1) === " ";

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        if (name === "FencedCode" || name === "CodeBlock" || name === "HTMLBlock" || name === "Table") return false;
        const parent = node.node.parent?.name;
        if (name === "HeaderMark" && parent?.startsWith("ATXHeading")) hide(node.from, node.to + (nextIsSpace(node.to) ? 1 : 0));
        else if (name === "EmphasisMark" || name === "StrikethroughMark") hide(node.from, node.to);
        else if (name === "CodeMark" && parent === "InlineCode") hide(node.from, node.to);
        else if (name === "QuoteMark") {
          if (!isActive(node.from)) out.push(quoteLine.range(doc.lineAt(node.from).from));
          hide(node.from, node.to + (nextIsSpace(node.to) ? 1 : 0));
        } else if (name === "Link") {
          // [[wikilinks]] are handled below; lezer may see their inner [..] as a link.
          if (doc.sliceString(node.from - 1, node.from) === "[" || doc.sliceString(node.from, node.from + 2) === "[[") return false;
          if (isActive(node.from)) return false;
          const marks = node.node.getChildren("LinkMark");
          if (marks.length >= 2) {
            out.push(mdLink.range(marks[0].to, marks[1].from));
            hide(marks[0].from, marks[0].to);
            hide(marks[1].from, node.to);
          }
          return false;
        } else if (name === "ListMark" && parent === "ListItem" && node.node.parent?.parent?.name === "BulletList") {
          if (isActive(node.from)) return;
          const after = doc.sliceString(node.to, node.to + 5);
          if (/^ \[[ xX]\] /.test(after)) out.push(hidden.range(node.from, node.to + 1));
          else out.push(bullet.range(node.from, node.to));
        }
      },
    });

    // Wikilinks: show only the label. Task metadata (@date, !priority, ✅ date) becomes small chips.
    const today = todayIso();
    const year = today.slice(0, 4);
    const fmEnd = frontmatterEnd(view.state);
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      if (!active.has(line.number) && /^\s*[-*+] \[[ xX]\] /.test(line.text)) {
        for (const m of line.text.matchAll(/(^|\s)(@(\d{4})-(\d{2})-(\d{2}))(?=\s|$)/g)) {
          const start = line.from + m.index! + m[1].length;
          const date = m[2].slice(1);
          const label = `${Number(m[5])}. ${Number(m[4])}.${m[3] === year ? "" : ` ${m[3]}`}`;
          const cls = `cm-due-chip${date < today ? " overdue" : date === today ? " today" : ""}`;
          out.push(Decoration.replace({ widget: new ChipWidget(date === today ? "dnes" : label, cls, date) }).range(start, start + m[2].length));
        }
        for (const m of line.text.matchAll(/(^|\s)(!([123]))(?=\s|$)/g)) {
          const start = line.from + m.index! + m[1].length;
          out.push(Decoration.replace({ widget: new ChipWidget("", `cm-prio p${m[3]}`, `Priorita ${m[3]}`) }).range(start, start + 2));
        }
        for (const m of line.text.matchAll(/✅ (\d{4}-\d{2}-\d{2})/gu)) {
          const start = line.from + m.index!;
          out.push(Decoration.replace({ widget: new ChipWidget("✓", "cm-done-chip", `Splněno ${m[1]}`) }).range(start, start + m[0].length));
        }
      }
      if (!active.has(line.number) && line.from > fmEnd) {
        const plain = line.text.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
        for (const m of plain.matchAll(/(!?)\[\[([^\]|\n]+?)(\|[^\]\n]*)?\]\]/g)) {
          if (m[1]) continue; // keep embeds visible
          const start = line.from + m.index!;
          const end = start + m[0].length;
          if (m[3]) out.push(hidden.range(start, start + 2 + m[2].length + 1));
          else out.push(hidden.range(start, start + 2));
          out.push(hidden.range(end - 2, end));
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

// Frontmatter shown as a tidy properties block (like Obsidian) until the cursor enters it.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function frontmatterEnd(state: EditorState): number {
  const m = state.doc.sliceString(0, Math.min(state.doc.length, 8000)).match(FRONTMATTER_RE);
  if (!m) return -1;
  return m[0].endsWith("\n") ? m[0].length - 1 : m[0].length;
}

function parseProperties(yaml: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const kv = line.match(/^([^\s:#][^:]*):\s*(.*)$/);
    if (kv) out.push([kv[1].trim(), kv[2].trim().replace(/^\[(.*)\]$/, "$1").replace(/^["']|["']$/g, "")]);
    else {
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item && out.length) out[out.length - 1][1] += `${out[out.length - 1][1] ? ", " : ""}${item[1].replace(/^["']|["']$/g, "")}`;
    }
  }
  return out;
}

class PropertiesWidget extends WidgetType {
  constructor(readonly entries: [string, string][]) {
    super();
  }
  eq(other: PropertiesWidget) {
    return JSON.stringify(other.entries) === JSON.stringify(this.entries);
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-properties";
    box.title = "Kliknutím upravíš vlastnosti";
    for (const [key, value] of this.entries) {
      const row = document.createElement("div");
      row.className = "cm-prop";
      const k = document.createElement("span");
      k.className = "cm-prop-key";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "cm-prop-value";
      const parts = key === "tags" || key === "tag" ? value.split(/,\s*/).filter(Boolean) : [value];
      for (const part of parts) {
        const chip = document.createElement("span");
        chip.className = key === "tags" || key === "tag" ? "cm-prop-tag" : key === "type" || key === "status" ? "cm-prop-pill" : "";
        chip.textContent = key === "tags" || key === "tag" ? `#${part.replace(/^#/, "")}` : part || "–";
        v.append(chip);
      }
      row.append(k, v);
      box.append(row);
    }
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: 4 } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

function frontmatterDecorations(state: EditorState): DecorationSet {
  const end = frontmatterEnd(state);
  if (end < 0) return Decoration.none;
  // Cursor inside the frontmatter: show the raw YAML for editing.
  if (state.selection.main.head <= end) return Decoration.none;
  const yaml = state.doc.sliceString(0, end).replace(/^---\r?\n/, "").replace(/\r?\n---[ \t]*$/, "");
  const entries = parseProperties(yaml);
  if (!entries.length) return Decoration.none;
  return Decoration.set([Decoration.replace({ widget: new PropertiesWidget(entries), block: true }).range(0, end)]);
}

const frontmatterField = StateField.define<DecorationSet>({
  create: frontmatterDecorations,
  update: (deco, tr) => (tr.docChanged || tr.selection ? frontmatterDecorations(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLivePreview(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildLivePreview(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Finds a [[link]], #tag or URL at a document position. */
function linkAt(view: EditorView, pos: number): { kind: "note" | "tag" | "url"; value: string } | null {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  const within = (re: RegExp, group = 0) => {
    for (const m of line.text.matchAll(re)) {
      const start = m.index! + (group ? m[0].indexOf(m[group]) : 0);
      const end = start + m[group].length;
      if (offset >= start && offset <= end) return m;
    }
    return null;
  };
  const wl = within(/!?\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g);
  if (wl) return { kind: "note", value: wl[1].trim() };
  const md = within(/\[[^\]\n]*\]\(([^)\s]+)\)/g);
  if (md) return /^https?:/i.test(md[1]) ? { kind: "url", value: md[1] } : { kind: "note", value: decodeURI(md[1]).replace(/\.md$/i, "") };
  const url = within(/https?:\/\/[^\s<>)\]]+/g);
  if (url) return { kind: "url", value: url[0] };
  const tag = within(/(?:^|[\s(,])(#[\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gu, 1);
  if (tag) return { kind: "tag", value: tag[1].slice(1).toLowerCase() };
  return null;
}

export async function followLink(target: string, from: string | undefined, newTab: boolean): Promise<void> {
  const resolved = resolveLink(target, from);
  if (resolved) {
    openNote(resolved, { newTab });
    return;
  }
  // Clicking a link to a missing note creates it, like Obsidian.
  const name = target.split("#")[0].trim();
  try {
    const path = await window.vimmi.vault.create(name, `# ${basename(name)}\n\n`);
    setState({ snapshot: await window.vimmi.vault.snapshot() });
    openNote(path, { newTab });
  } catch (err) {
    toast(String(err), "error");
  }
}

// ---------- autocompletion ----------

function completions(ctx: CompletionContext) {
  const snapshot = getState().snapshot;
  if (!snapshot) return null;
  const link = ctx.matchBefore(/\[\[[^\]\n]*$/);
  if (link) {
    const query = link.text.slice(2).toLowerCase();
    const closing = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "]]";
    return {
      from: link.from + 2,
      to: closing ? ctx.pos + 2 : ctx.pos,
      filter: false,
      options: snapshot.notes
        .filter((n) => !query || n.title.toLowerCase().includes(query) || n.path.toLowerCase().includes(query))
        .sort((a, b) => Number(b.title.toLowerCase().startsWith(query)) - Number(a.title.toLowerCase().startsWith(query)) || b.mtime - a.mtime)
        .slice(0, 50)
        .map((n) => ({
          label: n.title,
          detail: n.folder || undefined,
          apply: `${snapshot.notes.filter((o) => o.title === n.title).length > 1 ? n.path.replace(/\.md$/, "") : n.title}]]`,
          type: "text",
        })),
    };
  }
  const tag = ctx.matchBefore(/(?:^|[\s(,])#[\p{L}\p{N}_/-]*$/u);
  if (tag && (tag.text.length > 1 || ctx.explicit)) {
    const start = tag.from + tag.text.indexOf("#");
    const counts = new Map<string, number>();
    for (const n of snapshot.notes) for (const tg of n.tags) counts.set(tg, (counts.get(tg) ?? 0) + 1);
    return {
      from: start + 1,
      options: [...counts].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, detail: String(count), type: "keyword" })),
    };
  }
  return null;
}

// ---------- component ----------

interface Props {
  path: string;
  value: string;
  onChange: (value: string) => void;
  jumpLine?: number | null;
  active: boolean;
}

export default function Editor({ path, value, onChange, jumpLine, active }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pathRef = useRef(path);
  pathRef.current = path;
  const vimComp = useRef(new Compartment());
  const liveComp = useRef(new Compartment());
  const imagesExt = useRef(imagePreview(() => pathRef.current));
  const settings = getState().settings;

  useEffect(() => {
    const fm = value.match(FRONTMATTER_RE);
    const state = EditorState.create({
      doc: value,
      // Start below the frontmatter so it opens as a tidy properties block.
      selection: { anchor: fm ? fm[0].length : 0 },
      extensions: [
        vimComp.current.of(settings?.vimMode ? vim() : []),
        liveComp.current.of(settings?.livePreview === false ? [] : [livePreview, frontmatterField, imagesExt.current]),
        history(),
        drawSelection(),
        closeBrackets(),
        search({ top: true }),
        highlightSelectionMatches(),
        autocompletion({ override: [completions], icons: false }),
        yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) }),
        syntaxHighlighting(highlight),
        decorations,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: settings?.spellcheck ? "true" : "false", lang: "cs" }),
        placeholder("Začni psát… ([[ pro odkaz, # pro tag, - [ ] pro úkol)"),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap,
          {
            key: "Mod-Enter",
            run: (view) => {
              const link = linkAt(view, view.state.selection.main.head);
              if (link?.kind === "note") void followLink(link.value, pathRef.current, false);
              else if (link?.kind === "url") void window.vimmi.app.openExternal(link.value);
              else {
                // Toggle task on the current line.
                const line = view.state.doc.lineAt(view.state.selection.main.head);
                const m = line.text.match(/^(\s*[-*+] )\[([ xX])\]/);
                if (!m) return false;
                const at = line.from + m[1].length + 1;
                view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } });
              }
              return true;
            },
          },
          {
            key: "Mod-l",
            run: (view) => {
              // Turn the current line into a task, or toggle it.
              const line = view.state.doc.lineAt(view.state.selection.main.head);
              const m = line.text.match(/^(\s*)(?:([-*+]) )?(\[[ xX]\] )?(.*)$/)!;
              const insert = m[3] ? `${m[1]}${m[2]} ${m[4]}` : `${m[1]}- [ ] ${m[4]}`;
              view.dispatch({ changes: { from: line.from, to: line.to, insert } });
              return true;
            },
          },
          {
            key: "Mod-b",
            run: (view) => wrap(view, "**"),
          },
          {
            key: "Mod-i",
            run: (view) => wrap(view, "*"),
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.selectionSet || u.focusChanged) {
            const sel = u.state.selection.main;
            setState({ selection: sel.empty ? "" : u.state.sliceDoc(sel.from, sel.to) });
          }
          if (u.focusChanged && u.view.hasFocus) activeEditor = { view: u.view, path: pathRef.current };
        }),
        EditorView.domEventHandlers({
          mousedown: (e, view) => {
            if (e.button !== 0) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos === null) return false;
            const onRenderedLink =
              getState().settings?.livePreview !== false &&
              (e.target as HTMLElement).closest(".cm-wikilink, .cm-md-link") !== null &&
              !activeLines(view).has(view.state.doc.lineAt(pos).number);
            if (!(e.ctrlKey || e.metaKey) && !onRenderedLink) return false;
            const link = linkAt(view, pos);
            if (!link) return false;
            e.preventDefault();
            if (link.kind === "note") void followLink(link.value, pathRef.current, e.shiftKey);
            else if (link.kind === "url") void window.vimmi.app.openExternal(link.value);
            else openView("search", "#" + link.value);
            return true;
          },
          paste: (e, view) => {
            const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (!files.length) return false;
            e.preventDefault();
            void insertImages(view, files);
            return true;
          },
          drop: (e, view) => {
            const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (!files.length) return false;
            e.preventDefault();
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos !== null) view.dispatch({ selection: { anchor: pos } });
            void insertImages(view, files);
            return true;
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current! });
    viewRef.current = view;
    activeEditor = { view, path };
    return () => {
      if (activeEditor?.view === view) activeEditor = null;
      view.destroy();
    };
    // Recreate only when the note changes; external content updates are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Apply content changes that came from outside (disk, AI) without losing the cursor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    const head = Math.min(view.state.selection.main.head, value.length);
    view.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: head } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: vimComp.current.reconfigure(settings?.vimMode ? vim() : []) });
  }, [settings?.vimMode]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: liveComp.current.reconfigure(settings?.livePreview === false ? [] : [livePreview, frontmatterField, imagesExt.current]) });
  }, [settings?.livePreview]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || jumpLine === null || jumpLine === undefined) return;
    const line = view.state.doc.line(Math.min(Math.max(1, jumpLine + 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    view.focus();
  }, [jumpLine]);

  useEffect(() => {
    if (active && viewRef.current) activeEditor = { view: viewRef.current, path };
  }, [active, path]);

  return <div className="editor" ref={host} />;
}

function wrap(view: EditorView, mark: string): boolean {
  const changes = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    const wrapped = text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2;
    const insert = wrapped ? text.slice(mark.length, -mark.length) : `${mark}${text}${mark}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: range.empty
        ? EditorSelection.cursor(range.from + mark.length)
        : EditorSelection.range(range.from, range.from + insert.length),
    };
  });
  view.dispatch(changes);
  return true;
}

/** Lets the user pick images (gallery or camera on phones) and inserts them into the active editor. */
export async function insertPickedImages(path?: string): Promise<void> {
  const ed = activeEditor;
  if (!ed || (path && ed.path !== path)) {
    toast("Nejdřív otevři poznámku v režimu úprav.", "error");
    return;
  }
  const files = await pickImages();
  if (files.length) await insertImages(ed.view, files);
}

/** Inserts or replaces text in the active editor (used by AI actions). */
export function insertIntoEditor(text: string, mode: "replace" | "below" | "cursor"): boolean {
  const ed = activeEditor;
  if (!ed) return false;
  const { view } = ed;
  const sel = view.state.selection.main;
  if (mode === "replace" && !sel.empty) {
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } });
  } else if (mode === "below") {
    const line = view.state.doc.lineAt(sel.empty ? view.state.doc.length : sel.to);
    const insert = `\n\n${text}\n`;
    view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length } });
  } else {
    view.dispatch(view.state.replaceSelection(text));
  }
  view.focus();
  return true;
}
