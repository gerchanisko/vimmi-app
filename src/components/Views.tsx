// Today, Tasks, Projects and Search views.
import { useEffect, useMemo, useState } from "react";
import { addDays, basename, isoDate, taskDisplayText } from "../../shared/markdown";
import type { NoteMeta, Priority, SearchHit, Task } from "../../shared/types";
import { allOccurrences, eventsFromNotes } from "../../shared/calendar";
import { useExternalCalendars } from "../lib/calendar-actions";
import { COLOR_VAR } from "./Calendar";
import { askAi, openDaily, toggleTask } from "../lib/actions";
import { errorText, openNote, openView, prompt, refreshSnapshot, toast, useApp } from "../lib/store";
import { Icon } from "./Icon";

// ---------- shared task row ----------

function dueLabel(due: string, today: string): { text: string; cls: string } {
  if (due < today) return { text: `po termínu · ${formatDate(due)}`, cls: "overdue" };
  if (due === today) return { text: "dnes", cls: "today" };
  if (due === addDays(today, 1)) return { text: "zítra", cls: "" };
  return { text: formatDate(due), cls: "" };
}

export function formatDate(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("cs-CZ", { weekday: "short", day: "numeric", month: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function TaskRow({ task, showNote = true }: { task: Task; showNote?: boolean }) {
  const today = isoDate();
  const due = task.due ? dueLabel(task.due, today) : null;
  return (
    <div className={`task-row${task.done ? " done" : ""}`}>
      <input
        type="checkbox"
        checked={task.done}
        onChange={() => void toggleTask(task.path, task.line)}
        aria-label={task.done ? "Označit jako nesplněný" : "Označit jako splněný"}
      />
      <button className="task-text" onClick={() => openNote(task.path, { line: task.line })} title="Otevřít v poznámce">
        {task.priority && <span className={`prio p${task.priority}`} title={`Priorita ${task.priority}`} />}
        {taskDisplayText(task.text).replace(/✅ \d{4}-\d{2}-\d{2}/u, "") || "(prázdný úkol)"}
      </button>
      <span className="task-meta">
        {due && <span className={`due ${due.cls}`}>{due.text}</span>}
        {showNote && <span className="task-note">{task.project ?? basename(task.path)}</span>}
      </span>
    </div>
  );
}

function QuickAddTask({ defaultNote, defaultDue }: { defaultNote?: string; defaultDue?: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    let raw = text.trim();
    if (!raw) return;
    // Understand a few shortcuts in the text: "dnes", "zítra", "!1".
    let due = defaultDue;
    let priority: Priority | undefined;
    raw = raw.replace(/(^|\s)(dnes|zítra|zitra)(?=\s|$)/i, (_m, sp: string, word: string) => {
      due = word.toLowerCase() === "dnes" ? isoDate() : addDays(isoDate(), 1);
      return sp;
    });
    raw = raw.replace(/(^|\s)@(\d{4}-\d{2}-\d{2})(?=\s|$)/, (_m, sp: string, d: string) => {
      due = d;
      return sp;
    });
    raw = raw.replace(/(^|\s)!([123])(?=\s|$)/, (_m, sp: string, p: string) => {
      priority = Number(p) as Priority;
      return sp;
    });
    setBusy(true);
    try {
      await window.vimmi.vault.addTask(raw.trim(), { path: defaultNote, due, priority });
      setText("");
      await refreshSnapshot();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="quick-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Icon name="plus" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Přidat úkol… (dnes, zítra, @2026-12-24, !1)${defaultNote ? "" : " → Úkoly.md"}`}
        disabled={busy}
        aria-label="Nový úkol"
      />
    </form>
  );
}

// ---------- Today ----------

export function TodayView() {
  const notes = useApp((s) => s.snapshot?.notes ?? []);
  const today = isoDate();
  const tasks = useMemo(() => notes.flatMap((n) => n.tasks), [notes]);
  const overdue = tasks.filter((t) => !t.done && t.due && t.due < today);
  const dueToday = tasks.filter((t) => !t.done && t.due === today);
  const doneToday = tasks.filter((t) => t.done && /✅ (\d{4}-\d{2}-\d{2})/u.exec(t.text)?.[1] === today);
  const upcoming = tasks
    .filter((t) => !t.done && t.due && t.due > today && t.due <= addDays(today, 7))
    .sort((a, b) => a.due!.localeCompare(b.due!));
  const important = tasks.filter((t) => !t.done && !t.due && t.priority === 1);
  const templates = useApp((s) => s.settings?.templatesFolder ?? "");
  const recent = [...notes]
    .filter((n) => !templates || !n.path.startsWith(templates + "/"))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 6);
  const sortP = (a: Task, b: Task) => (a.priority ?? 4) - (b.priority ?? 4);
  const hour = new Date().getHours();
  const greeting = hour < 10 ? "Dobré ráno" : hour < 18 ? "Dobrý den" : "Dobrý večer";
  const longDate = new Date().toLocaleDateString("cs-CZ", { weekday: "long", day: "numeric", month: "long" });
  const totalToday = overdue.length + dueToday.length;
  const external = useExternalCalendars();
  const agenda = useMemo(() => allOccurrences(eventsFromNotes(notes), external, today, addDays(today, 1)), [notes, external, today]);

  return (
    <div className="view today-view">
      <header className="view-head">
        <p className="eyebrow">{longDate}</p>
        <h1>{greeting}.</h1>
        <p className="muted">
          {totalToday === 0
            ? "Na dnešek nemáš nic naplánovaného. Klid."
            : `Na dnes ${totalToday === 1 ? "máš 1 úkol" : totalToday < 5 ? `máš ${totalToday} úkoly` : `máš ${totalToday} úkolů`}${doneToday.length ? `, ${doneToday.length} hotovo` : ""}.`}
        </p>
        <div className="view-actions">
          <button className="btn" onClick={() => void openDaily()}>
            <Icon name="calendar" /> Dnešní poznámka
          </button>
          <button className="btn" onClick={() => askAi("Podívej se na moje úkoly a poznámky a navrhni, na co se dnes zaměřit. Buď stručný.")}>
            <Icon name="sparkle" /> Naplánovat den s AI
          </button>
        </div>
      </header>

      <QuickAddTask defaultDue={today} />

      {agenda.length > 0 && (
        <section className="task-group today-events">
          <h2>V kalendáři</h2>
          {agenda.map((o, i) => (
            <button key={i} className="cal-agenda-item" style={{ "--ev": COLOR_VAR[o.event.color] } as React.CSSProperties} onClick={() => openView("calendar")}>
              <span className="cal-agenda-time">
                {o.date === today ? "Dnes" : "Zítra"} {o.startMin === undefined ? "celý den" : `${o.event.start}–${o.event.end}`}
              </span>
              <span className="cal-agenda-title">
                {o.event.title}
                {o.event.location && <span className="muted"> · {o.event.location}</span>}
              </span>
            </button>
          ))}
        </section>
      )}
      {overdue.length > 0 && (
        <section className="task-group">
          <h2>Po termínu</h2>
          {overdue.sort((a, b) => a.due!.localeCompare(b.due!)).map((t) => <TaskRow key={`${t.path}:${t.line}`} task={t} />)}
        </section>
      )}
      <section className="task-group">
        <h2>Dnes</h2>
        {dueToday.length ? dueToday.sort(sortP).map((t) => <TaskRow key={`${t.path}:${t.line}`} task={t} />) : <p className="muted">Žádné úkoly s dnešním termínem.</p>}
        {doneToday.map((t) => <TaskRow key={`${t.path}:${t.line}`} task={t} />)}
      </section>
      {important.length > 0 && (
        <section className="task-group">
          <h2>Důležité bez termínu</h2>
          {important.map((t) => <TaskRow key={`${t.path}:${t.line}`} task={t} />)}
        </section>
      )}
      {upcoming.length > 0 && (
        <section className="task-group">
          <h2>Příštích 7 dní</h2>
          {upcoming.map((t) => <TaskRow key={`${t.path}:${t.line}`} task={t} />)}
        </section>
      )}
      <section className="task-group">
        <h2>Naposledy upravené</h2>
        <div className="card-grid">
          {recent.map((n) => (
            <button key={n.path} className="note-card" onClick={() => openNote(n.path)}>
              <strong>{n.title}</strong>
              <span className="muted">{n.excerpt || "Prázdná poznámka"}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------- Tasks ----------

type TaskFilter = "open" | "upcoming" | "nodate" | "done" | "all";

export function TasksView() {
  const notes = useApp((s) => s.snapshot?.notes ?? []);
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [group, setGroup] = useState<"note" | "due" | "priority">("note");
  const [query, setQuery] = useState("");
  const today = isoDate();
  const tasks = useMemo(() => {
    let list = notes.flatMap((n) => n.tasks);
    if (filter === "open") list = list.filter((t) => !t.done);
    if (filter === "upcoming") list = list.filter((t) => !t.done && t.due);
    if (filter === "nodate") list = list.filter((t) => !t.done && !t.due);
    if (filter === "done") list = list.filter((t) => t.done);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((t) => t.text.toLowerCase().includes(q) || t.path.toLowerCase().includes(q));
    }
    return list;
  }, [notes, filter, query]);

  const groups = useMemo(() => {
    const map = new Map<string, Task[]>();
    const key = (t: Task) =>
      group === "note"
        ? (t.project ?? basename(t.path))
        : group === "priority"
          ? t.priority
            ? `Priorita ${t.priority}`
            : "Bez priority"
          : !t.due
            ? "Bez termínu"
            : t.due < today
              ? "Po termínu"
              : t.due === today
                ? "Dnes"
                : t.due <= addDays(today, 7)
                  ? "Tento týden"
                  : "Později";
    for (const t of tasks) {
      const k = key(t);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(t);
    }
    const order = ["Po termínu", "Dnes", "Tento týden", "Později", "Bez termínu", "Priorita 1", "Priorita 2", "Priorita 3", "Bez priority"];
    return [...map].sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return ia !== -1 || ib !== -1 ? (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) : a[0].localeCompare(b[0], "cs");
    });
  }, [tasks, group, today]);

  const counts = {
    open: notes.reduce((n, m) => n + m.tasks.filter((t) => !t.done).length, 0),
    done: notes.reduce((n, m) => n + m.tasks.filter((t) => t.done).length, 0),
  };

  return (
    <div className="view">
      <header className="view-head">
        <h1>Úkoly</h1>
        <p className="muted">
          {counts.open} otevřených · {counts.done} hotových. Úkol je řádek <code>- [ ] text</code> v jakékoliv poznámce.
        </p>
      </header>
      <QuickAddTask />
      <div className="toolbar">
        <div className="segmented" role="tablist">
          {(
            [
              ["open", "Otevřené"],
              ["upcoming", "S termínem"],
              ["nodate", "Bez termínu"],
              ["done", "Hotové"],
              ["all", "Vše"],
            ] as [TaskFilter, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <select value={group} onChange={(e) => setGroup(e.target.value as typeof group)} aria-label="Seskupit">
          <option value="note">Podle poznámky</option>
          <option value="due">Podle termínu</option>
          <option value="priority">Podle priority</option>
        </select>
        <input className="filter-input" placeholder="Filtrovat…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {groups.length === 0 && <p className="muted pad">Nic tu není.</p>}
      {groups.map(([name, list]) => (
        <section key={name} className="task-group">
          <h2>
            {name} <span className="muted">{list.length}</span>
          </h2>
          {list
            .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? 4) - (b.priority ?? 4))
            .map((t) => (
              <TaskRow key={`${t.path}:${t.line}`} task={t} showNote={group !== "note"} />
            ))}
        </section>
      ))}
    </div>
  );
}

// ---------- Projects ----------

export function ProjectsView() {
  const notes = useApp((s) => s.snapshot?.notes ?? []);
  const projects = notes.filter((n) => n.type === "project" || n.type === "projekt");

  const createProject = async () => {
    const name = await prompt("Název projektu", "", "Vytvořit");
    if (!name) return;
    try {
      const path = await window.vimmi.vault.create(
        `Projekty/${name}`,
        `---\ntype: project\nstatus: aktivní\n---\n# ${name}\n\n## Cíl\n\n\n## Úkoly\n- [ ] \n\n## Poznámky\n`,
      );
      await refreshSnapshot();
      openNote(path, { newTab: true });
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  return (
    <div className="view">
      <header className="view-head">
        <h1>Projekty</h1>
        <p className="muted">
          Projekt je poznámka s <code>type: project</code>. Ostatní poznámky k němu připojíš řádkem <code>project: Název</code> ve frontmatter.
        </p>
        <div className="view-actions">
          <button className="btn primary" onClick={() => void createProject()}>
            <Icon name="plus" /> Nový projekt
          </button>
        </div>
      </header>
      {projects.length === 0 ? (
        <div className="empty-card">
          <Icon name="project" size={28} />
          <p>Zatím žádné projekty.</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard key={p.path} project={p} notes={notes} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project, notes }: { project: NoteMeta; notes: NoteMeta[] }) {
  const tasks = notes.flatMap((n) => n.tasks).filter((t) => t.project === project.title);
  const done = tasks.filter((t) => t.done).length;
  const linked = notes.filter((n) => n.path !== project.path && (n.project === project.title || n.links.some((l) => l.resolved === project.path)));
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const next = tasks.filter((t) => !t.done).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? 4) - (b.priority ?? 4)).slice(0, 3);
  const status = String(project.frontmatter.status ?? "aktivní");
  return (
    <article className="project-card">
      <button className="project-title" onClick={() => openNote(project.path)}>
        <Icon name="project" />
        <strong>{project.title}</strong>
        <span className="pill">{status}</span>
      </button>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="muted small">
        {done}/{tasks.length} úkolů · {linked.length} propojených poznámek
      </p>
      {next.length > 0 && (
        <div className="project-next">
          {next.map((t) => (
            <TaskRow key={`${t.path}:${t.line}`} task={t} showNote={false} />
          ))}
        </div>
      )}
      {linked.length > 0 && (
        <div className="project-links">
          {linked.slice(0, 6).map((n) => (
            <button key={n.path} className="link-chip" onClick={() => openNote(n.path)}>
              {n.title}
            </button>
          ))}
        </div>
      )}
      <button className="btn small" onClick={() => void newProjectNote(project.title)}>
        <Icon name="plus" /> Poznámka
      </button>
    </article>
  );
}

async function newProjectNote(project: string) {
  const name = await prompt(`Nová poznámka k projektu ${project}`, "", "Vytvořit");
  if (!name) return;
  try {
    const path = await window.vimmi.vault.create(`Projekty/${name}`, `---\nproject: ${project}\n---\n# ${name}\n\n`);
    await refreshSnapshot();
    openNote(path, { newTab: true });
  } catch (err) {
    toast(errorText(err), "error");
  }
}

// ---------- Search ----------

export function SearchView({ initial }: { initial?: string }) {
  const [query, setQuery] = useState(initial ?? "");
  const [kind, setKind] = useState<"all" | "note" | "task" | "project">("all");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const version = useApp((s) => s.snapshot);

  useEffect(() => setQuery(initial ?? ""), [initial]);
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      window.vimmi.vault.search(query, { kind, limit: 200 }).then((h) => alive && setHits(h));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, kind, version]);

  return (
    <div className="view">
      <header className="view-head">
        <h1>Hledat</h1>
        <p className="muted">
          Hledá v obsahu i názvech, bez ohledu na diakritiku. Filtry: <code>#tag</code>, <code>path:složka</code>.
        </p>
      </header>
      <div className="toolbar">
        <input autoFocus className="search-big" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Co hledáš?" />
        <div className="segmented">
          {(
            [
              ["all", "Vše"],
              ["note", "Poznámky"],
              ["task", "Úkoly"],
              ["project", "Projekty"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {query && <p className="muted small pad">{hits.length} výsledků</p>}
      <div className="search-results">
        {hits.map((h, i) =>
          h.kind === "task" && h.task ? (
            <TaskRow key={i} task={h.task} />
          ) : (
            <button key={i} className="search-hit" onClick={() => openNote(h.path, { line: h.snippets[0]?.line })}>
              <strong>
                <Icon name={h.kind === "project" ? "project" : "note"} size={14} /> {h.title}
              </strong>
              <span className="muted small">{h.path}</span>
              {h.snippets.map((s) => (
                <span key={s.line} className="snippet">
                  <Highlight text={s.text} query={query} />
                </span>
              ))}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query
    .replace(/(?:^|\s)(#|path:)\S+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());
  // Fold character by character so indexes in the folded text match the original.
  const chars = [...text];
  const folded = chars.map((c) => c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());
  if (!terms.length || folded.some((c) => c.length !== 1)) return <>{text}</>;
  const lower = folded.join("");
  const marks: [number, number][] = [];
  for (const t of terms) {
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let pos = 0;
  marks.forEach(([a, b], k) => {
    if (a < pos) return;
    out.push(chars.slice(pos, a).join(""));
    out.push(<mark key={k}>{chars.slice(a, b).join("")}</mark>);
    pos = b;
  });
  out.push(chars.slice(pos).join(""));
  return <>{out}</>;
}
