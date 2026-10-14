// Calendar view (month / week / day / list), like Google Calendar, on top of event notes.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  eventsFromNotes,
  fromMinutes,
  occurrences,
  REPEAT_LABELS,
  type CalendarEvent,
  type EventColor,
  type EventInput,
  type Occurrence,
  type Repeat,
  EVENT_COLORS,
} from "../../shared/calendar";
import { addDays, isoDate, taskDisplayText } from "../../shared/markdown";
import type { Task } from "../../shared/types";
import { openDaily, toggleTask } from "../lib/actions";
import { deleteEvent, eventToInput, saveEvent } from "../lib/calendar-actions";
import { useMobile } from "../lib/mobile";
import { confirm, openNote, useApp } from "../lib/store";
import { Icon } from "./Icon";

type CalView = "month" | "week" | "day" | "list";
const HOUR_PX = 48;
const SNAP_MIN = 15;
const WEEKDAYS = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

export const COLOR_VAR: Record<EventColor, string> = {
  accent: "var(--accent)",
  blue: "var(--blue)",
  sage: "var(--sage)",
  ochre: "var(--ochre)",
  clay: "var(--clay)",
  gray: "var(--text-3)",
};

const COLOR_LABEL: Record<EventColor, string> = { accent: "Fialová", blue: "Modrá", sage: "Zelená", ochre: "Žlutá", clay: "Červená", gray: "Šedá" };

function d(date: string): Date {
  return new Date(`${date}T12:00:00`);
}

function mondayOf(date: string): string {
  const wd = (d(date).getDay() + 6) % 7;
  return addDays(date, -wd);
}

function monthTitle(date: string): string {
  const t = d(date).toLocaleDateString("cs-CZ", { month: "long", year: "numeric" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function rangeTitle(view: CalView, cursor: string): string {
  if (view === "month" || view === "list") return monthTitle(cursor);
  if (view === "day") {
    const t = d(cursor).toLocaleDateString("cs-CZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  const start = mondayOf(cursor);
  const end = addDays(start, 6);
  const a = d(start);
  const b = d(end);
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}.–${b.getDate()}. ${b.toLocaleDateString("cs-CZ", { month: "long", year: "numeric" })}`
    : `${a.toLocaleDateString("cs-CZ", { day: "numeric", month: "short" })} – ${b.toLocaleDateString("cs-CZ", { day: "numeric", month: "short", year: "numeric" })}`;
}

function loadView(mobile: boolean): CalView {
  try {
    const v = localStorage.getItem("vimmi:calendar-view") as CalView | null;
    if (v && ["month", "week", "day", "list"].includes(v)) return v;
  } catch {
    /* ignore */
  }
  return mobile ? "list" : "week";
}

interface Draft {
  event?: CalendarEvent;
  input: EventInput;
}

export default function CalendarView() {
  const notes = useApp((s) => s.snapshot?.notes ?? []);
  const mobile = useMobile();
  const [view, setViewState] = useState<CalView>(() => loadView(mobile));
  const [cursor, setCursor] = useState(isoDate());
  const [draft, setDraft] = useState<Draft | null>(null);
  const today = isoDate();

  const setView = (v: CalView) => {
    setViewState(v);
    try {
      localStorage.setItem("vimmi:calendar-view", v);
    } catch {
      /* ignore */
    }
  };

  const events = useMemo(() => eventsFromNotes(notes), [notes]);
  const tasks = useMemo(() => notes.flatMap((n) => n.tasks).filter((t) => t.due), [notes]);
  const dailyDays = useMemo(() => new Set(notes.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.title)).map((n) => n.title)), [notes]);

  const move = (dir: 1 | -1) => {
    if (view === "day") setCursor(addDays(cursor, dir));
    else if (view === "week") setCursor(addDays(cursor, dir * 7));
    else {
      const x = d(cursor);
      x.setDate(1);
      x.setMonth(x.getMonth() + dir);
      setCursor(isoDate(x));
    }
  };

  const newEvent = (date: string, start?: number) =>
    setDraft({
      input:
        start === undefined
          ? { title: "", date, allDay: true }
          : { title: "", date, allDay: false, start: fromMinutes(start), end: fromMinutes(Math.min(start + 60, 24 * 60 - 1)), remind: 15 },
    });
  const openEvent = (e: CalendarEvent) => setDraft({ event: e, input: { ...eventToInput(e), description: e.description } });
  const openDay = (date: string) => {
    setCursor(date);
    setView("day");
  };

  // Keyboard: arrows move, T = today.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draft || (e.target as HTMLElement).closest("input, textarea, .cm-editor, [contenteditable]")) return;
      if (!(e.target as HTMLElement).closest(".calendar") && document.activeElement !== document.body) return;
      if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "ArrowRight") move(1);
      else if (e.key.toLowerCase() === "t") setCursor(isoDate());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="view calendar">
      <div className="cal-toolbar">
        <button className="btn small" onClick={() => setCursor(isoDate())}>
          Dnes
        </button>
        <div className="cal-nav">
          <button className="icon-btn" onClick={() => move(-1)} aria-label="Předchozí">
            <Icon name="chevron-right" className="flip" />
          </button>
          <button className="icon-btn" onClick={() => move(1)} aria-label="Další">
            <Icon name="chevron-right" />
          </button>
        </div>
        <h1 className="cal-title">{rangeTitle(view, cursor)}</h1>
        <span className="grow" />
        <div className="segmented" role="tablist" aria-label="Zobrazení">
          {(
            [
              ["month", "Měsíc"],
              ["week", "Týden"],
              ["day", "Den"],
              ["list", "Seznam"],
            ] as [CalView, string][]
          ).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn primary small" onClick={() => newEvent(view === "month" || view === "list" ? (cursor.slice(0, 7) === today.slice(0, 7) ? today : cursor) : cursor, 9 * 60)}>
          <Icon name="plus" size={14} /> Událost
        </button>
      </div>

      {view === "month" && (
        <MonthGrid cursor={cursor} today={today} events={events} tasks={tasks} dailyDays={dailyDays} onDay={openDay} onNew={(date) => newEvent(date)} onEvent={openEvent} />
      )}
      {(view === "week" || view === "day") && (
        <TimeGrid
          days={view === "day" ? [cursor] : Array.from({ length: 7 }, (_, i) => addDays(mondayOf(cursor), i))}
          today={today}
          events={events}
          tasks={tasks}
          dailyDays={dailyDays}
          onDay={openDay}
          onNew={newEvent}
          onEvent={openEvent}
        />
      )}
      {view === "list" && <AgendaList from={cursor < today && cursor.slice(0, 7) === today.slice(0, 7) ? today : cursor} events={events} tasks={tasks} onEvent={openEvent} onNew={(date) => newEvent(date, 9 * 60)} />}

      {draft && <EventDialog draft={draft} onClose={() => setDraft(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- chips

function EventChip({ o, onClick, compact }: { o: Occurrence; onClick: (e: CalendarEvent) => void; compact?: boolean }) {
  const color = COLOR_VAR[o.event.color];
  const allDay = o.startMin === undefined;
  return (
    <button
      className={`cal-chip${allDay ? " all-day" : ""}${compact ? " compact" : ""}`}
      style={{ "--ev": color } as React.CSSProperties}
      onClick={(e) => {
        e.stopPropagation();
        onClick(o.event);
      }}
      title={`${allDay ? "Celý den" : `${o.event.start}–${o.event.end}`} · ${o.event.title}${o.event.location ? ` · ${o.event.location}` : ""}`}
    >
      {!allDay && <span className="cal-chip-time">{o.event.start}</span>}
      <span className="cal-chip-title">{o.event.title}</span>
    </button>
  );
}

function TaskChip({ task }: { task: Task }) {
  return (
    <div className={`cal-task${task.done ? " done" : ""}`} onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={task.done} onChange={() => void toggleTask(task.path, task.line)} aria-label="Splněno" />
      <button onClick={() => openNote(task.path, { line: task.line })} title={taskDisplayText(task.text)}>
        {taskDisplayText(task.text).replace(/✅.*$/u, "")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- month

function MonthGrid({
  cursor,
  today,
  events,
  tasks,
  dailyDays,
  onDay,
  onNew,
  onEvent,
}: {
  cursor: string;
  today: string;
  events: CalendarEvent[];
  tasks: Task[];
  dailyDays: Set<string>;
  onDay: (date: string) => void;
  onNew: (date: string) => void;
  onEvent: (e: CalendarEvent) => void;
}) {
  const first = cursor.slice(0, 8) + "01";
  const start = mondayOf(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const occ = useMemo(() => occurrences(events, days[0], days[41]), [events, days[0]]);
  const month = cursor.slice(0, 7);
  return (
    <div className="cal-month" role="grid" aria-label={monthTitle(cursor)}>
      {WEEKDAYS.map((w) => (
        <div key={w} className="cal-weekday" role="columnheader">
          {w}
        </div>
      ))}
      {days.map((day) => {
        const dayOcc = occ.filter((o) => o.date === day);
        const dayTasks = tasks.filter((t) => t.due === day && !t.done);
        const items = dayOcc.length + dayTasks.length;
        const shown = dayOcc.slice(0, 3);
        return (
          <div
            key={day}
            role="gridcell"
            className={`cal-cell${day.slice(0, 7) !== month ? " other" : ""}${day === today ? " today" : ""}`}
            onClick={() => onNew(day)}
          >
            <button
              className="cal-daynum"
              onClick={(e) => {
                e.stopPropagation();
                onDay(day);
              }}
              aria-label={d(day).toLocaleDateString("cs-CZ", { weekday: "long", day: "numeric", month: "long" })}
            >
              {Number(day.slice(8))}
              {dailyDays.has(day) && <span className="cal-journal-dot" title="Denní poznámka" />}
            </button>
            <div className="cal-cell-items">
              {shown.map((o, i) => (
                <EventChip key={i} o={o} onClick={onEvent} compact />
              ))}
              {shown.length < 3 && dayTasks.slice(0, 3 - shown.length).map((t) => <TaskChip key={`${t.path}:${t.line}`} task={t} />)}
              {items > 3 && (
                <button
                  className="cal-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDay(day);
                  }}
                >
                  +{items - 3} další
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- week / day

interface Placed {
  o: Occurrence;
  col: number;
  cols: number;
}

/** Puts overlapping timed events side by side, like Google Calendar. */
function layoutDay(list: Occurrence[]): Placed[] {
  const sorted = [...list].sort((a, b) => a.startMin! - b.startMin! || b.endMin! - a.endMin!);
  const placed: Placed[] = [];
  let group: Placed[] = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...group.map((p) => p.col + 1));
    for (const p of group) p.cols = cols;
    placed.push(...group);
    group = [];
  };
  for (const o of sorted) {
    if (o.startMin! >= groupEnd && group.length) flush();
    const used = new Set(group.filter((p) => p.o.endMin! > o.startMin!).map((p) => p.col));
    let col = 0;
    while (used.has(col)) col++;
    group.push({ o, col, cols: 1 });
    groupEnd = Math.max(groupEnd, o.endMin!);
  }
  if (group.length) flush();
  return placed;
}

interface DragState {
  event: CalendarEvent;
  mode: "move" | "resize";
  /** Day the occurrence was on, and its original minutes. */
  fromDate: string;
  startMin: number;
  endMin: number;
  pointerY: number;
  moved: boolean;
  /** Current preview. */
  date: string;
  newStart: number;
  newEnd: number;
}

function TimeGrid({
  days,
  today,
  events,
  tasks,
  dailyDays,
  onDay,
  onNew,
  onEvent,
}: {
  days: string[];
  today: string;
  events: CalendarEvent[];
  tasks: Task[];
  dailyDays: Set<string>;
  onDay: (date: string) => void;
  onNew: (date: string, startMin?: number) => void;
  onEvent: (e: CalendarEvent) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const occ = useMemo(() => occurrences(events, days[0], days[days.length - 1]), [events, days[0], days.length]);

  // Start the day around 7:00 (or just before now).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Like Google Calendar: show the current time, but never scroll past the first event.
    const first = Math.min(...occ.filter((o) => o.startMin !== undefined).map((o) => Math.floor(o.startMin! / 60)));
    const hour = Math.max(0, Math.min(days.includes(today) ? now.getHours() - 2 : 7, first - 1));
    el.scrollTop = hour * HOUR_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0], days.length]);

  const minutesAt = (clientY: number) => {
    const rect = cols.current!.getBoundingClientRect();
    return Math.max(0, Math.min(24 * 60, ((clientY - rect.top) / HOUR_PX) * 60));
  };
  const dayAt = (clientX: number) => {
    const rect = cols.current!.getBoundingClientRect();
    const i = Math.floor(((clientX - rect.left) / rect.width) * days.length);
    return days[Math.max(0, Math.min(days.length - 1, i))];
  };
  const snap = (m: number) => Math.round(m / SNAP_MIN) * SNAP_MIN;

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const cur = dragRef.current!;
      const dy = e.clientY - cur.pointerY;
      if (!cur.moved && Math.abs(dy) < 4 && dayAt(e.clientX) === cur.fromDate) return;
      const deltaMin = snap((dy / HOUR_PX) * 60);
      if (cur.mode === "move") {
        const len = cur.endMin - cur.startMin;
        const start = Math.max(0, Math.min(24 * 60 - len, cur.startMin + deltaMin));
        setDrag({ ...cur, moved: true, date: dayAt(e.clientX), newStart: start, newEnd: start + len });
      } else {
        setDrag({ ...cur, moved: true, newEnd: Math.max(cur.startMin + SNAP_MIN, Math.min(24 * 60 - 1, cur.endMin + deltaMin)) });
      }
    };
    const onUp = () => {
      const cur = dragRef.current!;
      setDrag(null);
      if (!cur.moved) {
        onEvent(cur.event);
        return;
      }
      const shift = Math.round((d(cur.date).getTime() - d(cur.fromDate).getTime()) / 86_400_000);
      const input = eventToInput(cur.event);
      void saveEvent({
        ...input,
        date: addDays(cur.event.date, shift),
        endDate: input.endDate ? addDays(input.endDate, shift) : undefined,
        start: fromMinutes(cur.newStart),
        end: fromMinutes(cur.newEnd),
      }, cur.event);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const startDrag = (e: React.PointerEvent, o: Occurrence, mode: "move" | "resize") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setDrag({
      event: o.event,
      mode,
      fromDate: o.date,
      startMin: o.startMin!,
      endMin: o.endMin!,
      pointerY: e.clientY,
      moved: false,
      date: o.date,
      newStart: o.startMin!,
      newEnd: o.endMin!,
    });
  };

  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <div className={`cal-time${days.length === 1 ? " single" : ""}`}>
      <div className="cal-time-head" style={{ "--days": days.length } as React.CSSProperties}>
        <div className="cal-gutter" />
        {days.map((day) => (
          <button key={day} className={`cal-dayhead${day === today ? " today" : ""}`} onClick={() => onDay(day)}>
            <span>{WEEKDAYS[(d(day).getDay() + 6) % 7]}</span>
            <strong>{Number(day.slice(8))}</strong>
          </button>
        ))}
      </div>
      <div className="cal-allday" style={{ "--days": days.length } as React.CSSProperties}>
        <div className="cal-gutter">celý den</div>
        {days.map((day) => (
          <div key={day} className="cal-allday-cell" onClick={() => onNew(day)}>
            {occ
              .filter((o) => o.date === day && o.startMin === undefined)
              .map((o, i) => (
                <EventChip key={i} o={o} onClick={onEvent} />
              ))}
            {tasks
              .filter((t) => t.due === day)
              .map((t) => (
                <TaskChip key={`${t.path}:${t.line}`} task={t} />
              ))}
            {days.length === 1 && (
              <button
                className="cal-journal-link"
                onClick={(e) => {
                  e.stopPropagation();
                  void openDaily(Math.round((d(day).getTime() - d(today).getTime()) / 86_400_000));
                }}
              >
                <Icon name="calendar" size={13} /> {dailyDays.has(day) ? "Denní poznámka" : "Napsat denní poznámku"}
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="cal-scroll" ref={scroller}>
        <div className="cal-grid" style={{ "--days": days.length, height: 24 * HOUR_PX } as React.CSSProperties}>
          <div className="cal-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="cal-hour" style={{ top: h * HOUR_PX }}>
                {h ? `${h}:00` : ""}
              </div>
            ))}
          </div>
          <div className="cal-cols" ref={cols}>
            {days.map((day) => {
              const timed = occ.filter((o) => o.date === day && o.startMin !== undefined && !(drag?.moved && drag.event === o.event && o.date === drag.fromDate));
              const placed = layoutDay(timed);
              const preview = drag?.moved && drag.date === day ? drag : null;
              return (
                <div
                  key={day}
                  className={`cal-col${day === today ? " today" : ""}`}
                  onClick={(e) => {
                    if (drag) return;
                    const min = Math.floor(minutesAt(e.clientY) / 30) * 30;
                    onNew(day, min);
                  }}
                >
                  {placed.map(({ o, col, cols: n }, i) => {
                    const top = (o.startMin! / 60) * HOUR_PX;
                    const height = Math.max(20, ((o.endMin! - o.startMin!) / 60) * HOUR_PX - 2);
                    return (
                      <div
                        key={i}
                        className={`cal-event${height < 36 ? " short" : ""}`}
                        style={{ top, height, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)`, "--ev": COLOR_VAR[o.event.color] } as React.CSSProperties}
                        onPointerDown={(e) => startDrag(e, o, "move")}
                        onClick={(e) => e.stopPropagation()}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && onEvent(o.event)}
                        title={`${o.event.start}–${o.event.end} ${o.event.title}`}
                      >
                        <strong>{o.event.title}</strong>
                        <span>
                          {o.event.start}–{o.event.end}
                          {o.event.location ? ` · ${o.event.location}` : ""}
                        </span>
                        {o.event.repeat && <Icon name="sync" size={11} className="cal-repeat" />}
                        <div className="cal-resize" onPointerDown={(e) => startDrag(e, o, "resize")} />
                      </div>
                    );
                  })}
                  {preview && (
                    <div
                      className="cal-event dragging"
                      style={{
                        top: (preview.newStart / 60) * HOUR_PX,
                        height: Math.max(20, ((preview.newEnd - preview.newStart) / 60) * HOUR_PX - 2),
                        left: 2,
                        right: 2,
                        "--ev": COLOR_VAR[preview.event.color],
                      } as React.CSSProperties}
                    >
                      <strong>{preview.event.title}</strong>
                      <span>
                        {fromMinutes(preview.newStart)}–{fromMinutes(preview.newEnd)}
                      </span>
                    </div>
                  )}
                  {day === today && <div className="cal-now" style={{ top: (nowMin / 60) * HOUR_PX }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- list

function AgendaList({
  from,
  events,
  tasks,
  onEvent,
  onNew,
}: {
  from: string;
  events: CalendarEvent[];
  tasks: Task[];
  onEvent: (e: CalendarEvent) => void;
  onNew: (date: string) => void;
}) {
  const to = addDays(from, 60);
  const occ = useMemo(() => occurrences(events, from, to), [events, from, to]);
  const dueTasks = tasks.filter((t) => !t.done && t.due! >= from && t.due! <= to);
  const days = [...new Set([...occ.map((o) => o.date), ...dueTasks.map((t) => t.due!)])].sort();
  const today = isoDate();
  if (!days.length) {
    return (
      <div className="empty-card">
        <Icon name="calendar" size={28} />
        <p>Na příštích 60 dní nemáš nic naplánovaného.</p>
        <button className="btn" onClick={() => onNew(from)}>
          <Icon name="plus" size={14} /> Přidat událost
        </button>
      </div>
    );
  }
  return (
    <div className="cal-agenda">
      {days.map((day) => (
        <section key={day} className="cal-agenda-day">
          <h2 className={day === today ? "today" : ""}>
            <span className="cal-agenda-num">{Number(day.slice(8))}</span>
            <span>
              {capitalize(d(day).toLocaleDateString("cs-CZ", { weekday: "long" }))}
              <span className="muted"> · {d(day).toLocaleDateString("cs-CZ", { month: "long" })}</span>
            </span>
          </h2>
          {occ
            .filter((o) => o.date === day)
            .map((o, i) => (
              <button key={i} className="cal-agenda-item" style={{ "--ev": COLOR_VAR[o.event.color] } as React.CSSProperties} onClick={() => onEvent(o.event)}>
                <span className="cal-agenda-time">{o.startMin === undefined ? "celý den" : `${o.event.start}–${o.event.end}`}</span>
                <span className="cal-agenda-title">
                  {o.event.title}
                  {o.event.location && <span className="muted"> · {o.event.location}</span>}
                </span>
              </button>
            ))}
          {dueTasks
            .filter((t) => t.due === day)
            .map((t) => (
              <TaskChip key={`${t.path}:${t.line}`} task={t} />
            ))}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- dialog

const REMIND_OPTIONS: [number | "", string][] = [
  ["", "Bez připomenutí"],
  [0, "V čase začátku"],
  [5, "5 minut předem"],
  [10, "10 minut předem"],
  [15, "15 minut předem"],
  [30, "30 minut předem"],
  [60, "1 hodinu předem"],
  [120, "2 hodiny předem"],
  [1440, "1 den předem"],
];

function EventDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [v, setV] = useState<EventInput>(draft.input);
  const [busy, setBusy] = useState(false);
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => title.current?.focus(), []);
  const set = (patch: Partial<EventInput>) => setV((cur) => ({ ...cur, ...patch }));

  const save = async () => {
    if (!v.title.trim()) {
      title.current?.focus();
      return;
    }
    setBusy(true);
    const input: EventInput = {
      ...v,
      title: v.title.trim(),
      start: v.allDay ? undefined : v.start || "09:00",
      end: v.allDay ? undefined : v.end && v.start && v.end > v.start ? v.end : fromMinutes(Math.min(24 * 60 - 1, toMin(v.start || "09:00") + 60)),
      endDate: v.allDay && v.endDate && v.endDate > v.date ? v.endDate : undefined,
    };
    const ok = await saveEvent(input, draft.event);
    setBusy(false);
    if (ok) onClose();
  };

  const remove = async () => {
    if (!draft.event) return;
    if (!(await confirm(`Smazat událost „${draft.event.title}“?`, draft.event.repeat ? "Smaže se celá opakovaná řada." : undefined, "Smazat", true))) return;
    await deleteEvent(draft.event);
    onClose();
  };

  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog event-dialog"
        role="dialog"
        aria-label={draft.event ? "Upravit událost" : "Nová událost"}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <input ref={title} className="event-title-input" placeholder="Název události" value={v.title} onChange={(e) => set({ title: e.target.value })} />
        <div className="event-row">
          <Icon name="clock" />
          <input type="date" value={v.date} onChange={(e) => set({ date: e.target.value })} required aria-label="Datum" />
          {!v.allDay && (
            <>
              <input type="time" value={v.start ?? ""} onChange={(e) => set({ start: e.target.value })} aria-label="Začátek" step={300} />
              <span className="muted">–</span>
              <input type="time" value={v.end ?? ""} onChange={(e) => set({ end: e.target.value })} aria-label="Konec" step={300} />
            </>
          )}
          {v.allDay && (
            <>
              <span className="muted">do</span>
              <input type="date" value={v.endDate ?? v.date} min={v.date} onChange={(e) => set({ endDate: e.target.value })} aria-label="Konec" />
            </>
          )}
        </div>
        <div className="event-row">
          <span className="icon-space" />
          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(v.allDay)}
              onChange={(e) => set(e.target.checked ? { allDay: true } : { allDay: false, start: v.start ?? "09:00", end: v.end ?? "10:00", remind: v.remind ?? 15 })}
            />{" "}
            Celý den
          </label>
          <select value={v.repeat ?? ""} onChange={(e) => set({ repeat: (e.target.value || undefined) as Repeat | undefined })} aria-label="Opakování">
            <option value="">Neopakuje se</option>
            {(Object.keys(REPEAT_LABELS) as Repeat[]).map((r) => (
              <option key={r} value={r}>
                {REPEAT_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="event-row">
          <Icon name="map-pin" />
          <input className="grow-input" placeholder="Místo" value={v.location ?? ""} onChange={(e) => set({ location: e.target.value })} />
        </div>
        {!v.allDay && (
          <div className="event-row">
            <Icon name="bell" />
            <select value={v.remind ?? ""} onChange={(e) => set({ remind: e.target.value === "" ? undefined : Number(e.target.value) })} aria-label="Připomenutí">
              {REMIND_OPTIONS.map(([val, label]) => (
                <option key={label} value={val}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="event-row">
          <Icon name="note" />
          <textarea className="grow-input" rows={3} placeholder="Popis" value={v.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div className="event-row event-colors" role="radiogroup" aria-label="Barva">
          <span className="icon-space" />
          {EVENT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={(v.color ?? "accent") === c}
              aria-label={COLOR_LABEL[c]}
              title={COLOR_LABEL[c]}
              className={`color-dot${(v.color ?? "accent") === c ? " on" : ""}`}
              style={{ background: COLOR_VAR[c] }}
              onClick={() => set({ color: c })}
            />
          ))}
        </div>
        <div className="dialog-actions">
          {draft.event && (
            <>
              <button type="button" className="btn ghost danger-text" onClick={() => void remove()}>
                <Icon name="trash" size={14} /> Smazat
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  onClose();
                  openNote(draft.event!.path);
                }}
              >
                Otevřít jako poznámku
              </button>
            </>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Zrušit
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Uložit
          </button>
        </div>
      </form>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
