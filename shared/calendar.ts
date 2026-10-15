// Calendar events stored as Markdown notes with frontmatter, e.g. Kalendář/2026-10-15 Doktor.md:
//   ---
//   type: event
//   title: Doktor
//   date: 2026-10-15
//   start: "10:00"
//   end: "11:00"
//   location: Poliklinika
//   repeat: weekly        (daily | weekly | monthly | yearly)
//   until: 2026-12-31
//   remind: 15            (minutes before, for timed events)
//   color: blue
//   ---
// Events sync and work in Obsidian like any other note.
import { icsOccurrences, parseIcs, type IcsCalendar } from "./ics";
import { addDays, basename, isoDate, joinPath, safeFileName } from "./markdown";
import type { NoteMeta } from "./types";

export type Repeat = "daily" | "weekly" | "monthly" | "yearly";
export const EVENT_COLORS = ["accent", "blue", "sage", "ochre", "clay", "gray"] as const;
export type EventColor = (typeof EVENT_COLORS)[number];

export interface CalendarEvent {
  path: string;
  title: string;
  /** First day (YYYY-MM-DD). */
  date: string;
  /** Last day for multi-day all-day events (inclusive). */
  endDate?: string;
  /** "HH:MM"; missing = all-day event. */
  start?: string;
  end?: string;
  allDay: boolean;
  location?: string;
  repeat?: Repeat;
  until?: string;
  remind?: number;
  color: EventColor;
  description: string;
  /** Read-only event from a subscribed or imported .ics calendar. */
  external?: { calendar: string; file: string };
}

export interface EventInput {
  title: string;
  date: string;
  endDate?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  repeat?: Repeat;
  until?: string;
  remind?: number;
  color?: EventColor;
  description?: string;
}

/** One concrete occurrence of an event on a day (repeating events have many). */
export interface Occurrence {
  event: CalendarEvent;
  date: string;
  /** Minutes from midnight; undefined for all-day. */
  startMin?: number;
  endMin?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function isEventNote(meta: Pick<NoteMeta, "type">): boolean {
  return meta.type === "event" || meta.type === "udalost" || meta.type === "událost";
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") {
    // YAML reads 10:30 unquoted as a sexagesimal number (630); turn it back into a time.
    return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  return s || undefined;
}

export function normalizeTime(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = s.replace(".", ":").match(TIME_RE);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(min: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/** Reads an event from a note's metadata (and, optionally, its body for the description). */
export function eventFromMeta(meta: NoteMeta): CalendarEvent | null {
  if (!isEventNote(meta)) return null;
  const fm = meta.frontmatter;
  const date = str(fm.date);
  if (!date || !DATE_RE.test(date)) return null;
  const start = normalizeTime(fm.start ?? fm.time);
  let end = normalizeTime(fm.end);
  if (start && (!end || toMinutes(end) <= toMinutes(start))) end = fromMinutes(toMinutes(start) + 60);
  const endDate = str(fm.end_date ?? fm.endDate);
  const repeat = str(fm.repeat) as Repeat | undefined;
  const color = str(fm.color) as EventColor | undefined;
  const remind = Number(fm.remind);
  return {
    path: meta.path,
    title: str(fm.title) ?? meta.title.replace(/^\d{4}-\d{2}-\d{2}\s+/, ""),
    date,
    endDate: endDate && DATE_RE.test(endDate) && endDate > date ? endDate : undefined,
    start,
    end: start ? end : undefined,
    allDay: !start,
    location: str(fm.location ?? fm.misto),
    repeat: repeat && ["daily", "weekly", "monthly", "yearly"].includes(repeat) ? repeat : undefined,
    until: str(fm.until),
    remind: Number.isFinite(remind) && remind >= 0 ? remind : undefined,
    color: color && (EVENT_COLORS as readonly string[]).includes(color) ? color : "accent",
    description: meta.excerpt,
  };
}

export function eventsFromNotes(notes: NoteMeta[]): CalendarEvent[] {
  return notes.map(eventFromMeta).filter((e): e is CalendarEvent => e !== null);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000);
}

function addMonths(date: string, months: number): string | null {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(y, m - 1 + months, d, 12);
  // Skip months without this day (e.g. the 31st).
  if (target.getDate() !== d) return null;
  return isoDate(target);
}

/** Start dates of an event that fall in [from, to] (inclusive). */
function startsInRange(e: CalendarEvent, from: string, to: string): string[] {
  const span = e.endDate ? daysBetween(e.date, e.endDate) : 0;
  const lastAllowed = e.until && e.until < to ? e.until : to;
  if (!e.repeat) return e.date <= to && addDays(e.date, span) >= from ? [e.date] : [];
  const out: string[] = [];
  const windowStart = addDays(from, -span);
  if (e.repeat === "daily" || e.repeat === "weekly") {
    const step = e.repeat === "daily" ? 1 : 7;
    const skip = e.date < windowStart ? Math.floor(daysBetween(e.date, windowStart) / step) : 0;
    for (let d = addDays(e.date, skip * step); d <= lastAllowed; d = addDays(d, step)) if (d >= windowStart) out.push(d);
  } else {
    const step = e.repeat === "monthly" ? 1 : 12;
    for (let i = 0; i < 2400; i++) {
      const d = addMonths(e.date, i * step);
      if (d === null) continue;
      if (d > lastAllowed) break;
      if (d >= windowStart) out.push(d);
    }
  }
  return out;
}

/** All occurrences between two dates, sorted by day and time. Multi-day events produce one per day. */
export function occurrences(events: CalendarEvent[], from: string, to: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const e of events) {
    const span = e.endDate ? daysBetween(e.date, e.endDate) : 0;
    for (const start of startsInRange(e, from, to)) {
      for (let i = 0; i <= span; i++) {
        const day = addDays(start, i);
        if (day < from || day > to) continue;
        out.push({ event: e, date: day, startMin: e.start ? toMinutes(e.start) : undefined, endMin: e.end ? toMinutes(e.end) : undefined });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.startMin ?? -1) - (b.startMin ?? -1) || a.event.title.localeCompare(b.event.title, "cs"));
}

function yamlString(s: string): string {
  return /^[\p{L}\p{N} _.,!?()–-]*$/u.test(s) && !/^\d/.test(s) && !/^(true|false|null|yes|no)$/i.test(s) ? s : JSON.stringify(s);
}

/** Builds the Markdown file for an event. `body` is kept below the frontmatter (the description). */
export function eventMarkdown(input: EventInput, body?: string): string {
  const lines = ["---", "type: event", `title: ${yamlString(input.title.trim() || "Událost")}`, `date: ${input.date}`];
  if (input.endDate && input.endDate > input.date) lines.push(`end_date: ${input.endDate}`);
  if (!input.allDay && input.start) {
    lines.push(`start: "${input.start}"`);
    if (input.end) lines.push(`end: "${input.end}"`);
  }
  if (input.location?.trim()) lines.push(`location: ${yamlString(input.location.trim())}`);
  if (input.repeat) lines.push(`repeat: ${input.repeat}`);
  if (input.repeat && input.until) lines.push(`until: ${input.until}`);
  if (input.remind !== undefined && !input.allDay && input.start) lines.push(`remind: ${input.remind}`);
  if (input.color && input.color !== "accent") lines.push(`color: ${input.color}`);
  lines.push("---");
  const text = body ?? (input.description?.trim() ? `\n${input.description.trim()}\n` : "\n");
  return `${lines.join("\n")}\n${text.startsWith("\n") ? text : `\n${text}`}`;
}

/** Description part of an event file (everything after the frontmatter). */
export function eventBody(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  return m ? content.slice(m[0].length) : content;
}

export function eventFilePath(folder: string, input: Pick<EventInput, "title" | "date">): string {
  return joinPath(folder, `${input.date} ${safeFileName(input.title || "Událost")}.md`);
}

/** Occurrences whose reminder time falls in (since, now]. */
export function dueReminders(events: CalendarEvent[], since: number, now: number): Occurrence[] {
  const from = isoDate(new Date(since - 86_400_000));
  const to = isoDate(new Date(now + 86_400_000 * 2));
  return occurrences(
    events.filter((e) => e.remind !== undefined && !e.allDay),
    from,
    to,
  ).filter((o) => {
    const at = new Date(`${o.date}T${fromMinutes(o.startMin!)}:00`).getTime() - (o.event.remind ?? 0) * 60_000;
    return at > since && at <= now;
  });
}

export const REPEAT_LABELS: Record<Repeat, string> = {
  daily: "Každý den",
  weekly: "Každý týden",
  monthly: "Každý měsíc",
  yearly: "Každý rok",
};

// ---------- read-only calendars (.ics files in the vault) ----------

export interface ExternalCalendar {
  /** Vault path of the .ics file. */
  file: string;
  calendar: IcsCalendar;
}

export function isCalendarFile(path: string): boolean {
  return /\.ics$/i.test(path);
}

export function readExternalCalendar(file: string, text: string): ExternalCalendar {
  const calendar = parseIcs(text);
  if (!calendar.name) calendar.name = basename(file).replace(/\.ics$/i, "");
  return { file, calendar };
}

/** Occurrences of .ics events, shaped like Vimmi events (marked as external, read-only). */
export function externalOccurrences(calendars: ExternalCalendar[], from: string, to: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const { file, calendar } of calendars) {
    const color = (EVENT_COLORS as readonly string[]).includes(calendar.color ?? "") ? (calendar.color as EventColor) : "blue";
    for (const o of icsOccurrences(calendar, from, to)) {
      out.push({
        date: o.date,
        startMin: o.startMin,
        endMin: o.endMin,
        event: {
          path: `${file}#${o.uid}`,
          title: o.title,
          date: o.date,
          start: o.start,
          end: o.end,
          allDay: o.allDay,
          location: o.location,
          color,
          description: o.description ?? "",
          external: { calendar: calendar.name, file },
        },
      });
    }
  }
  return out;
}

/** Vimmi's own events and the read-only calendars together, sorted. */
export function allOccurrences(events: CalendarEvent[], calendars: ExternalCalendar[], from: string, to: string): Occurrence[] {
  return [...occurrences(events, from, to), ...externalOccurrences(calendars, from, to)].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.startMin ?? -1) - (b.startMin ?? -1) || a.event.title.localeCompare(b.event.title, "cs"),
  );
}

