import { useEffect, useMemo, useRef, useState } from "react";
import { basename, dirname, isoDate } from "../../shared/markdown";
import { askAi, renamePath, toggleBookmark, toggleMode, trashPath } from "../lib/actions";
import { loadDoc, saveDoc, subscribeDoc, updateDoc } from "../lib/docs";
import { renderNote } from "../lib/render";
import { errorText, getState, openView, resolveLink, setState, toast, useApp } from "../lib/store";
import { QUICK_ACTIONS, runQuick } from "./AiQuick";
import Editor, { followLink, insertPickedImages } from "./Editor";
import { openLightbox } from "../lib/editor-images";
import { Icon } from "./Icon";
import { openMenu, type MenuItem } from "./Menu";

interface Props {
  tabId: string;
  path: string;
  mode: "edit" | "read";
  active: boolean;
}

export default function NoteView({ tabId, path, mode, active }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const meta = useApp((s) => s.snapshot?.notes.find((n) => n.path === path));
  const files = useApp((s) => s.snapshot?.files);
  const jump = useApp((s) => (s.jump?.path === path ? s.jump.line : null));
  const bookmarked = useApp((s) => s.bookmarks.includes(path));
  const settings = useApp((s) => s.settings);
  const readRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    loadDoc(path)
      .then((c) => alive && setContent(c))
      .catch((err) => alive && setError(errorText(err)));
    const unsub = subscribeDoc(path, (c) => setContent(c));
    return () => {
      alive = false;
      unsub();
      void saveDoc(path);
    };
  }, [path]);

  useEffect(() => {
    if (jump !== null && active) setState({ jump: null });
  }, [jump, active]);

  const onChange = (value: string) => {
    setContent(value);
    updateDoc(path, value);
  };

  const rendered = useMemo(() => {
    if (mode !== "read" || content === null) return null;
    return renderNote(content, { resolve: (t) => resolveLink(t, path), notePath: path, files });
  }, [mode, content, path, files]);

  // Scroll the reading view to a line.
  useEffect(() => {
    if (mode !== "read" || jump === null || !readRef.current) return;
    const els = [...readRef.current.querySelectorAll<HTMLElement>("[data-line]")];
    const target = els.filter((el) => Number(el.dataset.line) <= jump).at(-1);
    target?.scrollIntoView({ block: "center" });
  }, [mode, jump, rendered]);

  const onReadClick = async (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    const link = el.closest<HTMLAnchorElement>("a");
    if (el instanceof HTMLInputElement && el.classList.contains("task-check")) {
      e.preventDefault();
      const line = Number(el.dataset.line);
      const lines = (content ?? "").split("\n");
      const m = lines[line]?.match(/^(\s*[-*+] )\[([ xX])\]/);
      if (!m) return;
      lines[line] = lines[line].replace(/\[([ xX])\]/, m[2] === " " ? "[x]" : "[ ]");
      onChange(lines.join("\n"));
      return;
    }
    if (el instanceof HTMLImageElement && !link) {
      openLightbox(el.src, el.alt);
      return;
    }
    if (!link) return;
    e.preventDefault();
    if (link.classList.contains("wikilink")) await followLink(link.dataset.target!, path, e.ctrlKey || e.metaKey);
    else if (link.classList.contains("tag")) openView("search", "#" + link.dataset.tag);
    else if (link.href && /^https?:/.test(link.href)) void window.vimmi.app.openExternal(link.href);
  };

  const aiMenu = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const hasSel = Boolean(getState().selection) && mode === "edit";
    const items: MenuItem[] = [
      { heading: hasSel ? "AI · označený text" : "AI · celá poznámka" },
      ...QUICK_ACTIONS.map((q) => ({ label: q.label, icon: q.icon, action: () => void runQuick(q.action, q.label) })),
      { separator: true },
      {
        label: "Zeptat se v chatu…",
        icon: "bot",
        shortcut: "Ctrl+J",
        action: () => askAi(hasSel ? "K označenému textu: " : `K poznámce [[${basename(path)}]]: `),
      },
      {
        label: "Najít související poznámky",
        icon: "link",
        action: () =>
          askAi(`Najdi poznámky, které souvisejí s [[${basename(path)}]], i když na ni neodkazují, a navrhni, jak je propojit.`),
      },
    ];
    openMenu(rect, items);
  };

  const moreMenu = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(rect, [
      { label: bookmarked ? "Odebrat ze záložek" : "Přidat do záložek", icon: "star", action: () => toggleBookmark(path) },
      { label: "Přejmenovat…", icon: "rename", action: () => void renamePath(path) },
      { label: "Historie verzí…", icon: "history", action: () => setState({ overlay: { type: "history", path } }) },
      { label: "Exportovat do PDF…", icon: "pdf", action: () => void exportPdf(path, content ?? "") },
      { label: "Kopírovat jako Markdown", icon: "copy", action: () => void navigator.clipboard.writeText(content ?? "").then(() => toast("Zkopírováno.", "ok")) },
      { label: "Kopírovat odkaz [[…]]", icon: "link", action: () => void navigator.clipboard.writeText(`[[${basename(path)}]]`).then(() => toast("Odkaz zkopírován.", "ok")) },
      { label: "Ukázat ve složce", icon: "folder-open", action: () => void window.vimmi.vault.reveal(path) },
      { separator: true },
      { label: "Přesunout do koše", icon: "trash", danger: true, action: () => void trashPath(path) },
    ]);
  };

  const crumbs = dirname(path) ? dirname(path).split("/") : [];
  const isProject = meta?.type === "project" || meta?.type === "projekt";
  const tasks = meta?.tasks ?? [];
  const openTasks = tasks.filter((t) => !t.done).length;

  return (
    <div className={`note-view${settings?.readableWidth ? " readable" : ""}`} data-tab={tabId}>
      <header className="note-head">
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i} className="crumb">
              {c}
              <Icon name="chevron-right" size={12} />
            </span>
          ))}
          <button className="crumb-title" onClick={() => void renamePath(path)} title="Přejmenovat">
            {basename(path)}
          </button>
          {isProject && <span className="pill accent">Projekt</span>}
          {tasks.length > 0 && (
            <span className="pill" title={`${openTasks} otevřených z ${tasks.length}`}>
              <Icon name="task" size={12} /> {tasks.length - openTasks}/{tasks.length} hotovo
            </span>
          )}
        </div>
        <div className="note-actions">
          <button className="icon-btn" onClick={() => toggleBookmark(path)} title={bookmarked ? "Odebrat ze záložek" : "Přidat do záložek"} aria-pressed={bookmarked}>
            <Icon name="star" className={bookmarked ? "filled" : ""} />
          </button>
          <button className="icon-btn" onClick={toggleMode} title={mode === "edit" ? "Náhled (Ctrl+E)" : "Upravit (Ctrl+E)"}>
            <Icon name={mode === "edit" ? "book" : "pen"} />
          </button>
          {mode === "edit" && (
            <button className="icon-btn" onClick={() => void insertPickedImages(path)} title="Vložit obrázek" aria-label="Vložit obrázek">
              <Icon name="image" />
            </button>
          )}
          <button className="btn ai-btn" onClick={aiMenu} title="AI akce">
            <Icon name="sparkle" /> AI
          </button>
          <button className="icon-btn" onClick={moreMenu} title="Další akce" aria-label="Další akce">
            <Icon name="more" />
          </button>
        </div>
      </header>

      {error ? (
        <div className="empty">
          <p>{error}</p>
        </div>
      ) : content === null ? (
        <div className="empty muted">Načítám…</div>
      ) : mode === "edit" ? (
        <div className="note-scroll" style={{ fontSize: settings?.fontSize }}>
          <Editor path={path} value={content} onChange={onChange} jumpLine={jump} active={active} />
        </div>
      ) : (
        <div className="note-scroll" style={{ fontSize: settings?.fontSize }}>
          {rendered?.frontmatter && <Properties yaml={rendered.frontmatter} />}
          <article
            ref={readRef}
            className="markdown reading"
            onClick={(e) => void onReadClick(e)}
            dangerouslySetInnerHTML={{ __html: rendered?.html || '<p class="muted">Prázdná poznámka. Přepni na úpravy (Ctrl+E).</p>' }}
          />
        </div>
      )}
      <footer className="note-foot">
        <span>{meta?.words ?? 0} slov</span>
        {meta && <span>Upraveno {new Date(meta.mtime).toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" })}</span>}
        <span className="grow" />
        {mode === "edit" && <span className="muted">Ctrl+klik otevře odkaz · Ctrl+L udělá z řádku úkol</span>}
      </footer>
    </div>
  );
}

function Properties({ yaml }: { yaml: string }) {
  const rows = yaml
    .split("\n")
    .map((l) => l.match(/^([\wÀ-ɏ-]+):\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m));
  if (!rows.length) return null;
  return (
    <dl className="properties">
      {rows.map((m) => (
        <div key={m[1]}>
          <dt>{m[1]}</dt>
          <dd>{m[2].replace(/^\[|\]$/g, "") || "–"}</dd>
        </div>
      ))}
    </dl>
  );
}

async function exportPdf(path: string, content: string) {
  const { html } = renderNote(content, { resolve: (t) => resolveLink(t, path) });
  const page = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>${basename(path)}</title>
<style>
body{font:15px/1.65 Inter,system-ui,sans-serif;color:#171717;max-width:720px;margin:0 auto;padding:24px}
h1,h2,h3{line-height:1.25;margin:1.4em 0 .5em} h1{font-size:1.9em;margin-top:0}
code{background:#f1f1ee;padding:.1em .3em;border-radius:4px;font-size:.9em} pre{background:#f7f7f5;padding:12px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0} blockquote{border-left:3px solid #6d63ff;margin:0;padding-left:14px;color:#555}
table{border-collapse:collapse} td,th{border:1px solid #ddd;padding:6px 10px} a{color:#5b52eb;text-decoration:none}
li.task{list-style:none;margin-left:-1.3em} li.task.done{color:#888;text-decoration:line-through} img{max-width:100%}
footer{margin-top:40px;color:#999;font-size:12px}
</style></head><body>${html}<footer>Exportováno z Vimmi · ${isoDate()}</footer></body></html>`;
  try {
    const out = await window.vimmi.app.exportPdf(page, path);
    if (out) toast(`PDF uloženo: ${out}`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  }
}
