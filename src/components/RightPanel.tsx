import { useEffect, useState } from "react";
import { basename, isoDate } from "../../shared/markdown";
import { askAi } from "../lib/actions";
import { activeNotePath, openNote, openView, setState, useApp, type RightPanel as Panel } from "../lib/store";
import AiChat from "./AiChat";
import { Icon } from "./Icon";

const TABS: { id: Panel; icon: string; label: string }[] = [
  { id: "ai", icon: "sparkle", label: "AI asistent (Ctrl+J)" },
  { id: "links", icon: "link", label: "Odkazy" },
  { id: "outline", icon: "outline", label: "Osnova" },
  { id: "info", icon: "info", label: "Informace" },
];

export default function RightPanel() {
  const right = useApp((s) => s.right);
  const [aiMounted, setAiMounted] = useState(right === "ai");
  useEffect(() => {
    if (right === "ai") setAiMounted(true);
  }, [right]);
  if (!right && !aiMounted) return null;
  return (
    <aside className="right-panel" hidden={!right}>
      <div className="panel-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={right === t.id}
            className={`icon-btn${right === t.id ? " on" : ""}`}
            title={t.label}
            aria-label={t.label}
            onClick={() => setState({ right: t.id })}
          >
            <Icon name={t.icon} />
          </button>
        ))}
        <span className="grow" />
        <button className="icon-btn" onClick={() => setState({ right: null })} title="Zavřít panel" aria-label="Zavřít panel">
          <Icon name="close" />
        </button>
      </div>
      {/* The chat stays mounted so a running answer keeps streaming while other tabs are shown. */}
      {aiMounted && (
        <div className="panel-body" hidden={right !== "ai"}>
          <AiChat />
        </div>
      )}
      {right === "links" && <LinksPanel />}
      {right === "outline" && <OutlinePanel />}
      {right === "info" && <InfoPanel />}
    </aside>
  );
}

function useActiveMeta() {
  const path = useApp(() => activeNotePath());
  const meta = useApp((s) => (path ? s.snapshot?.notes.find((n) => n.path === path) : undefined));
  return { path, meta };
}

function LinksPanel() {
  const { path, meta } = useActiveMeta();
  const snapshot = useApp((s) => s.snapshot);
  const [back, setBack] = useState<{ path: string; title: string; lines: number[] }[]>([]);
  const [related, setRelated] = useState<{ path: string; title: string; score: number }[]>([]);
  useEffect(() => {
    if (!path) return;
    void window.vimmi.vault.backlinks(path).then(setBack);
    void window.vimmi.vault.related(path).then(setRelated);
  }, [path, snapshot]);

  // Notes that mention this note's title as plain text but don't link to it.
  const [mentions, setMentions] = useState<{ path: string; line: number; text: string }[]>([]);
  useEffect(() => {
    if (!path || !meta || meta.title.length < 3) {
      setMentions([]);
      return;
    }
    const linked = new Set(back.map((b) => b.path));
    void window.vimmi.vault.search(`"${meta.title}"`.replace(/"/g, ""), { kind: "note", limit: 30 }).then((hits) =>
      setMentions(
        hits
          .filter((h) => h.path !== path && !linked.has(h.path))
          .flatMap((h) => h.snippets.filter((s) => s.text.toLowerCase().includes(meta.title.toLowerCase())).map((s) => ({ path: h.path, line: s.line, text: s.text })))
          .slice(0, 12),
      ),
    );
  }, [path, meta, back]);

  if (!path || !meta) return <p className="muted pad">Otevři poznámku a uvidíš její souvislosti.</p>;
  const outgoing = [...new Map(meta.links.map((l) => [l.resolved ?? l.target, l])).values()];

  return (
    <div className="panel-body scroll">
      <h4>Odkazují sem <span className="muted">{back.length}</span></h4>
      {back.length === 0 && <p className="muted small">Žádná poznámka sem zatím neodkazuje.</p>}
      {back.map((b) => (
        <button key={b.path} className="link-row" onClick={() => openNote(b.path, { line: b.lines[0] })}>
          <Icon name="note" size={14} /> {b.title}
        </button>
      ))}

      <h4>Odkazuje na <span className="muted">{outgoing.length}</span></h4>
      {outgoing.length === 0 && <p className="muted small">Napiš [[ a vyber poznámku.</p>}
      {outgoing.map((l) => (
        <button key={l.resolved ?? l.target} className={`link-row${l.resolved ? "" : " missing"}`} onClick={() => l.resolved && openNote(l.resolved)} title={l.resolved ? l.resolved : "Poznámka zatím neexistuje"}>
          <Icon name={l.resolved ? "note" : "plus"} size={14} /> {l.resolved ? basename(l.resolved) : l.target}
        </button>
      ))}

      {mentions.length > 0 && (
        <>
          <h4>Nepropojené zmínky</h4>
          {mentions.map((m, i) => (
            <button key={i} className="link-row mention" onClick={() => openNote(m.path, { line: m.line })}>
              <strong>{basename(m.path)}</strong>
              <span className="muted small">{m.text}</span>
            </button>
          ))}
        </>
      )}

      <h4>Související</h4>
      {related.length === 0 && <p className="muted small">Podle tagů a odkazů nic nenalezeno.</p>}
      {related.map((r) => (
        <button key={r.path} className="link-row" onClick={() => openNote(r.path)}>
          <Icon name="note" size={14} /> {r.title}
        </button>
      ))}
      <button className="btn small block" onClick={() => askAi(`Najdi poznámky, které obsahově souvisejí s [[${meta.title}]], a navrhni, kam přidat odkazy.`)}>
        <Icon name="sparkle" size={14} /> Najít souvislosti s AI
      </button>
      <button className="btn small block" onClick={() => openView("graph", path)}>
        <Icon name="graph" size={14} /> Lokální graf
      </button>
    </div>
  );
}

function OutlinePanel() {
  const { path, meta } = useActiveMeta();
  if (!path || !meta) return <p className="muted pad">Otevři poznámku.</p>;
  if (!meta.headings.length) return <p className="muted pad">Poznámka nemá nadpisy. Začni řádek znakem # .</p>;
  const min = Math.min(...meta.headings.map((h) => h.level));
  return (
    <div className="panel-body scroll">
      {meta.headings.map((h, i) => (
        <button key={i} className="outline-row" style={{ paddingLeft: 8 + (h.level - min) * 14 }} onClick={() => openNote(path, { line: h.line })}>
          {h.text}
        </button>
      ))}
    </div>
  );
}

function InfoPanel() {
  const { path, meta } = useActiveMeta();
  if (!path || !meta) return <p className="muted pad">Otevři poznámku.</p>;
  const open = meta.tasks.filter((t) => !t.done).length;
  const fm = Object.entries(meta.frontmatter);
  return (
    <div className="panel-body scroll">
      <dl className="info-list">
        <dt>Cesta</dt>
        <dd>{meta.path}</dd>
        <dt>Slov</dt>
        <dd>{meta.words}</dd>
        <dt>Doba čtení</dt>
        <dd>{Math.max(1, Math.round(meta.words / 200))} min</dd>
        <dt>Úkoly</dt>
        <dd>
          {open} otevřených z {meta.tasks.length}
        </dd>
        <dt>Vytvořeno</dt>
        <dd>{meta.ctime ? new Date(meta.ctime).toLocaleString("cs-CZ") : "–"}</dd>
        <dt>Upraveno</dt>
        <dd>{new Date(meta.mtime).toLocaleString("cs-CZ")}</dd>
        {meta.project && (
          <>
            <dt>Projekt</dt>
            <dd>{meta.project}</dd>
          </>
        )}
      </dl>
      {meta.tags.length > 0 && (
        <>
          <h4>Tagy</h4>
          <div className="tag-cloud">
            {meta.tags.map((t) => (
              <button key={t} className="tag-chip" onClick={() => openView("search", "#" + t)}>
                #{t}
              </button>
            ))}
          </div>
        </>
      )}
      {fm.length > 0 && (
        <>
          <h4>Vlastnosti</h4>
          <dl className="info-list">
            {fm.map(([k, v]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd>{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p className="muted small pad">Dnes je {isoDate()}.</p>
    </div>
  );
}
