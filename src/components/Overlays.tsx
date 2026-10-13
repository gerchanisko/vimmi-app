// Spotlight search (Ctrl+K), command palette (Ctrl+P), dialogs, toasts, template picker.
import { useEffect, useMemo, useRef, useState } from "react";
import { basename, fold, taskDisplayText, WIKILINK_RE } from "../../shared/markdown";
import type { SearchHit } from "../../shared/types";
import { askAi, newFromTemplate, newNote, toggleTask } from "../lib/actions";
import { openNote, openView, setState, useApp } from "../lib/store";
import { COMMANDS } from "../lib/commands";
import { Icon } from "./Icon";
import { Highlight } from "./Views";

function useListKeys(count: number, onEnter: (i: number, e: React.KeyboardEvent) => void, onClose: () => void) {
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [count]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(count - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (count) onEnter(sel, e);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };
  // Results re-render under a resting cursor and fire mousemove; only real movement should select.
  const lastMouse = useRef({ x: -1, y: -1 });
  const hover = (i: number) => (e: React.MouseEvent) => {
    if (e.clientX === lastMouse.current.x && e.clientY === lastMouse.current.y) return;
    const first = lastMouse.current.x === -1;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    if (!first) setSel(i);
  };
  return { sel, setSel, onKeyDown, hover };
}

function scrollIntoViewIfNeeded(container: HTMLElement | null, index: number) {
  const el = container?.querySelectorAll<HTMLElement>("[data-item]")[index];
  el?.scrollIntoView({ block: "nearest" });
}

// ---------- Spotlight ----------

type Item =
  | { kind: "note"; path: string; title: string; sub?: string; line?: number; query?: string; snippet?: string; project?: boolean }
  | { kind: "task"; hit: SearchHit }
  | { kind: "create"; title: string }
  | { kind: "ask"; text: string }
  | { kind: "search"; text: string };

export function Spotlight({ initial }: { initial?: string }) {
  const notes = useApp((s) => s.snapshot?.notes ?? []);
  const [query, setQuery] = useState(initial ?? "");
  const [filter, setFilter] = useState<"all" | "note" | "task" | "project">("all");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setState({ overlay: null });

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => void window.vimmi.vault.search(query, { kind: filter, limit: 30 }).then((h) => alive && setHits(h)), 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, filter]);

  const items = useMemo<Item[]>(() => {
    const q = fold(query.trim());
    if (!q) {
      return [...notes]
        .filter((n) => filter === "all" || filter === "note" || (filter === "project" && n.type === "project"))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 12)
        .map((n) => ({ kind: "note", path: n.path, title: n.title, sub: n.folder, project: n.type === "project" }));
    }
    const out: Item[] = [];
    const seen = new Set<string>();
    if (filter !== "task") {
      // Title matches first (fast, client-side).
      const titleHits = notes
        .map((n) => {
          const t = fold(n.title);
          const score = t === q ? 100 : t.startsWith(q) ? 50 : t.includes(q) ? 20 : q.split(/\s+/).every((w) => t.includes(w)) ? 10 : 0;
          return { n, score };
        })
        .filter((x) => x.score > 0 && (filter !== "project" || x.n.type === "project"))
        .sort((a, b) => b.score - a.score || b.n.mtime - a.n.mtime)
        .slice(0, 8);
      for (const { n } of titleHits) {
        seen.add(n.path);
        out.push({ kind: "note", path: n.path, title: n.title, sub: n.folder, project: n.type === "project" });
      }
    }
    for (const h of hits) {
      if (h.kind === "task") out.push({ kind: "task", hit: h });
      else if (!seen.has(h.path)) {
        seen.add(h.path);
        const snippet = h.snippets[0]?.text.replace(WIKILINK_RE, (_m, target: string, _h, alias?: string) => alias || target);
        out.push({ kind: "note", path: h.path, title: h.title, sub: h.path, line: h.snippets[0]?.line, snippet, project: h.kind === "project" });
      }
    }
    const exact = notes.some((n) => fold(n.title) === q);
    if (!exact && !query.startsWith("#")) out.push({ kind: "create", title: query.trim() });
    out.push({ kind: "search", text: query.trim() });
    out.push({ kind: "ask", text: query.trim() });
    return out;
  }, [query, hits, notes, filter]);

  const activate = (i: number, e: { ctrlKey: boolean; metaKey: boolean }) => {
    const it = items[i];
    if (!it) return;
    close();
    const newTab = e.ctrlKey || e.metaKey;
    if (it.kind === "note") openNote(it.path, { newTab, line: it.line });
    else if (it.kind === "task") openNote(it.hit.path, { newTab, line: it.hit.task?.line });
    else if (it.kind === "create") void newNote("", it.title);
    else if (it.kind === "search") openView("search", it.text);
    else askAi(it.text);
  };
  const keys = useListKeys(items.length, activate, close);
  useEffect(() => scrollIntoViewIfNeeded(listRef.current, keys.sel), [keys.sel]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Hledat">
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={keys.onKeyDown}
            placeholder="Hledat poznámky, úkoly a projekty…"
            aria-label="Hledat"
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-filters">
          {(
            [
              ["all", "Vše"],
              ["note", "Poznámky"],
              ["task", "Úkoly"],
              ["project", "Projekty"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="palette-list" ref={listRef}>
          {!query && <div className="palette-heading">Naposledy upravené</div>}
          {items.map((it, i) => (
            <button
              key={i}
              data-item
              className={`palette-item${i === keys.sel ? " sel" : ""}`}
              onMouseMove={keys.hover(i)}
              onClick={(e) => activate(i, e)}
            >
              {it.kind === "note" ? (
                <>
                  <Icon name={it.project ? "project" : "note"} />
                  <span className="pi-main">
                    <span className="pi-title">
                      <Highlight text={it.title} query={query} />
                    </span>
                    {it.snippet ? (
                      <span className="pi-sub">
                        <Highlight text={it.snippet} query={query} />
                      </span>
                    ) : (
                      it.sub && <span className="pi-sub">{it.sub}</span>
                    )}
                  </span>
                </>
              ) : it.kind === "task" ? (
                <>
                  <input
                    type="checkbox"
                    checked={it.hit.task?.done ?? false}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => it.hit.task && void toggleTask(it.hit.path, it.hit.task.line).then(() => setQuery((q) => q + ""))}
                  />
                  <span className="pi-main">
                    <span className="pi-title">{taskDisplayText(it.hit.title)}</span>
                    <span className="pi-sub">{basename(it.hit.path)}</span>
                  </span>
                </>
              ) : it.kind === "create" ? (
                <>
                  <Icon name="plus" />
                  <span className="pi-main">
                    <span className="pi-title">
                      Vytvořit poznámku „<strong>{it.title}</strong>“
                    </span>
                  </span>
                </>
              ) : it.kind === "search" ? (
                <>
                  <Icon name="search" />
                  <span className="pi-main">
                    <span className="pi-title">Hledat „{it.text}“ ve všech poznámkách</span>
                  </span>
                </>
              ) : (
                <>
                  <Icon name="sparkle" />
                  <span className="pi-main">
                    <span className="pi-title">Zeptat se AI: „{it.text}“</span>
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑↓</kbd> pohyb
          </span>
          <span>
            <kbd>↵</kbd> otevřít
          </span>
          <span>
            <kbd>Ctrl ↵</kbd> v nové kartě
          </span>
          <span>
            <kbd>esc</kbd> zavřít
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------- Command palette ----------

/** Substring matches score highest; otherwise every query letter must appear in order. */
export function fuzzyScore(query: string, text: string): number {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.every((w) => text.includes(w))) return 100 - text.indexOf(words[0]) / 10;
  let pos = 0;
  let gaps = 0;
  for (const ch of query.replace(/\s+/g, "")) {
    const found = text.indexOf(ch, pos);
    if (found === -1) return 0;
    gaps += found - pos;
    pos = found + 1;
  }
  return Math.max(1, 50 - gaps);
}

export function CommandPalette() {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setState({ overlay: null });
  const items = useMemo(() => {
    const q = fold(query.trim());
    const available = COMMANDS.filter((c) => !c.when || c.when());
    if (!q) return available;
    return available
      .map((c) => ({ c, score: fuzzyScore(q, fold(`${c.label} ${c.keywords ?? ""}`)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }, [query]);
  const run = (i: number) => {
    const c = items[i];
    if (!c) return;
    close();
    setTimeout(() => c.run(), 0);
  };
  const keys = useListKeys(items.length, run, close);
  useEffect(() => scrollIntoViewIfNeeded(listRef.current, keys.sel), [keys.sel]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Příkazy">
        <div className="palette-input">
          <Icon name="command" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={keys.onKeyDown} placeholder="Napiš příkaz…" aria-label="Příkaz" />
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <p className="muted pad">Žádný příkaz neodpovídá.</p>}
          {items.map((c, i) => (
            <button key={c.id} data-item className={`palette-item${i === keys.sel ? " sel" : ""}`} onMouseMove={keys.hover(i)} onClick={() => run(i)}>
              <Icon name={c.icon ?? "command"} />
              <span className="pi-main">
                <span className="pi-title">{c.label}</span>
              </span>
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Template picker ----------

export function TemplatePicker() {
  const [templates, setTemplates] = useState<string[] | null>(null);
  const folder = useApp((s) => s.settings?.templatesFolder);
  const close = () => setState({ overlay: null });
  useEffect(() => {
    void window.vimmi.vault.templates().then(setTemplates);
  }, []);
  const keys = useListKeys(templates?.length ?? 0, (i) => {
    close();
    void newFromTemplate(templates![i]);
  }, close);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Šablony">
        <div className="palette-input">
          <Icon name="template" />
          <input autoFocus readOnly placeholder="Vyber šablonu…" onKeyDown={keys.onKeyDown} />
        </div>
        <div className="palette-list">
          {templates?.length === 0 && (
            <p className="muted pad">
              Ve složce „{folder}“ nejsou žádné šablony. Vytvoř v ní poznámku – můžeš použít {"{{date}}"}, {"{{time}}"} a {"{{title}}"}.
            </p>
          )}
          {templates?.map((t, i) => (
            <button
              key={t}
              className={`palette-item${i === keys.sel ? " sel" : ""}`}
              onMouseMove={keys.hover(i)}
              onClick={() => {
                close();
                void newFromTemplate(t);
              }}
            >
              <Icon name="template" />
              <span className="pi-main">{basename(t)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Dialogs & toasts ----------

export function DialogHost() {
  const dialog = useApp((s) => s.dialog);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!dialog) return;
    setValue(dialog.value ?? "");
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [dialog]);
  if (!dialog) return null;
  const finish = (v: string | null) => {
    setState({ dialog: null });
    dialog.resolve(v);
  };
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-label={dialog.title}
        onSubmit={(e) => {
          e.preventDefault();
          finish(dialog.kind === "prompt" ? value.trim() || null : "ok");
        }}
        onKeyDown={(e) => e.key === "Escape" && finish(null)}
      >
        <h3>{dialog.title}</h3>
        {dialog.message && <p className="muted">{dialog.message}</p>}
        {dialog.kind === "prompt" && <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} />}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => finish(null)}>
            Zrušit
          </button>
          <button type="submit" className={`btn ${dialog.danger ? "danger" : "primary"}`} autoFocus={dialog.kind === "confirm"}>
            {dialog.okLabel ?? "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? ""}`}>
          {t.kind === "error" && <Icon name="alert" size={15} />}
          {t.kind === "ok" && <Icon name="ok" size={15} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function useOverlayOpen() {
  return useApp((s) => s.overlay !== null || s.dialog !== null);
}


