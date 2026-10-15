// Read-only calendars from iCalendar (.ics) files: Google Calendar's private iCal address,
// school timetables, exported calendars. Supports time zones, all-day and multi-day events,
// the common repeat rules (RRULE), exceptions (EXDATE) and moved occurrences (RECURRENCE-ID).
import { addDays, isoDate } from "./markdown";

export interface IcsEvent {
  uid: string;
  title: string;
  location?: string;
  description?: string;
  /** Start as a UTC timestamp (timed events) or a local date (all-day). */
  start: number;
  /** Exclusive end. */
  end: number;
  allDay: boolean;
  rrule?: Record<string, string>;
  exdates: Set<number>;
  recurrenceId?: number;
  cancelled: boolean;
}

export interface IcsCalendar {
  name: string;
  color?: string;
  events: IcsEvent[];
}

/** One occurrence in local time, ready for the calendar views. */
export interface IcsOccurrence {
  uid: string;
  title: string;
  location?: string;
  description?: string;
  /** Local date YYYY-MM-DD of this day. */
  date: string;
  allDay: boolean;
  /** Minutes from local midnight (timed events; clipped to the day for events spanning days). */
  startMin?: number;
  endMin?: number;
  /** "HH:MM" of the real start and end, for display. */
  start?: string;
  end?: string;
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/** Lines with folded continuations joined. */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | null {
  // NAME;PARAM=a;PARAM2="b:c":value
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...rawParams] = head.split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

/** Offset (ms) of a time zone from UTC at a given instant. */
function tzOffset(tz: string, utc: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utc));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - Math.floor(utc / 1000) * 1000;
  } catch {
    return -new Date(utc).getTimezoneOffset() * 60_000;
  }
}

/** UTC instant of a wall-clock time in a time zone (or in local time when tz is missing). */
function zoned(y: number, mo: number, d: number, h: number, mi: number, s: number, tz?: string): number {
  if (!tz) return new Date(y, mo - 1, d, h, mi, s).getTime();
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffset(tz, guess);
  t = guess - tzOffset(tz, t); // second pass handles DST edges
  return t;
}

/** Parses DATE or DATE-TIME values. All-day dates become local midnight. */
function parseDate(prop: Prop): { t: number; allDay: boolean } | null {
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || prop.params.VALUE === "DATE") return { t: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)), allDay: false };
  return { t: zoned(+y, +mo, +d, +h, +mi, +(s ?? 0), prop.params.TZID), allDay: false };
}

function parseDuration(v: string): number {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = (((+(w ?? 0) * 7 + +(d ?? 0)) * 24 + +(h ?? 0)) * 60 + +(mi ?? 0)) * 60_000 + +(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

export function parseIcs(text: string): IcsCalendar {
  const cal: IcsCalendar = { name: "", events: [] };
  let ev: (Partial<IcsEvent> & { exdates: Set<number>; duration?: number }) | null = null;
  let depth = 0; // nested components (VALARM) inside an event are skipped
  for (const line of unfold(text)) {
    if (!line) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      if (p.value === "VEVENT" && !ev) ev = { exdates: new Set(), cancelled: false };
      else if (ev) depth++;
      continue;
    }
    if (p.name === "END") {
      if (ev && depth > 0) depth--;
      else if (p.value === "VEVENT" && ev) {
        if (ev.start !== undefined) {
          const allDay = Boolean(ev.allDay);
          let end = ev.end;
          if (end === undefined) end = ev.duration !== undefined ? ev.start + ev.duration : allDay ? addDayMs(ev.start, 1) : ev.start;
          cal.events.push({
            uid: ev.uid ?? `${ev.start}-${ev.title}`,
            title: ev.title || "(bez názvu)",
            location: ev.location,
            description: ev.description,
            start: ev.start,
            end: Math.max(end, ev.start),
            allDay,
            rrule: ev.rrule,
            exdates: ev.exdates,
            recurrenceId: ev.recurrenceId,
            cancelled: Boolean(ev.cancelled),
          });
        }
        ev = null;
      }
      continue;
    }
    if (!ev) {
      if (p.name === "X-WR-CALNAME") cal.name = unescapeText(p.value);
      if (p.name === "X-VIMMI-COLOR") cal.color = p.value.trim();
      continue;
    }
    if (depth > 0) continue;
    switch (p.name) {
      case "UID":
        ev.uid = p.value;
        break;
      case "SUMMARY":
        ev.title = unescapeText(p.value);
        break;
      case "LOCATION":
        ev.location = unescapeText(p.value) || undefined;
        break;
      case "DESCRIPTION":
        ev.description = unescapeText(p.value) || undefined;
        break;
      case "STATUS":
        ev.cancelled = p.value.toUpperCase() === "CANCELLED";
        break;
      case "DTSTART": {
        const d = parseDate(p);
        if (d) {
          ev.start = d.t;
          ev.allDay = d.allDay;
        }
        break;
      }
      case "DTEND": {
        const d = parseDate(p);
        if (d) ev.end = d.t;
        break;
      }
      case "DURATION":
        ev.duration = parseDuration(p.value);
        break;
      case "RRULE":
        ev.rrule = Object.fromEntries(p.value.split(";").map((kv) => kv.split("=") as [string, string]).map(([k, v]) => [k.toUpperCase(), v]));
        break;
      case "EXDATE":
        for (const v of p.value.split(",")) {
          const d = parseDate({ ...p, value: v });
          if (d) ev.exdates.add(d.t);
        }
        break;
      case "RECURRENCE-ID": {
        const d = parseDate(p);
        if (d) ev.recurrenceId = d.t;
        break;
      }
    }
  }
  return cal;
}

function addDayMs(t: number, days: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Start times of a repeating event (as UTC instants), up to `until`. Keeps local wall-clock time across DST. */
function repeatStarts(e: IcsEvent, rangeEnd: number): number[] {
  const r = e.rrule!;
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const untilProp = r.UNTIL ? parseDate({ name: "UNTIL", params: {}, value: r.UNTIL }) : null;
  const until = Math.min(rangeEnd, untilProp ? (untilProp.allDay ? addDayMs(untilProp.t, 1) - 1 : untilProp.t) : Infinity);
  const base = new Date(e.start);
  const byDay = r.BYDAY ? r.BYDAY.split(",") : [];
  const byMonthDay = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : [];
  const out: number[] = [];
  let produced = 0;
  const at = (y: number, mo: number, d: number) => new Date(y, mo, d, base.getHours(), base.getMinutes(), base.getSeconds()).getTime();
  const push = (t: number) => {
    if (t < e.start || produced >= count) return false;
    if (t > until) return false;
    produced++;
    out.push(t);
    return true;
  };

  for (let i = 0; i < 5000 && produced < count; i++) {
    let candidates: number[] = [];
    if (freq === "DAILY") {
      candidates = [at(base.getFullYear(), base.getMonth(), base.getDate() + i * interval)];
    } else if (freq === "WEEKLY") {
      const weekStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() - ((base.getDay() + 6) % 7) + i * 7 * interval);
      const days = byDay.length ? byDay.map((d) => WEEKDAYS.indexOf(d.slice(-2))) : [base.getDay()];
      candidates = days
        .filter((d) => d >= 0)
        .map((d) => at(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + ((d + 6) % 7)))
        .sort((a, b) => a - b);
    } else if (freq === "MONTHLY") {
      const y = base.getFullYear();
      const mo = base.getMonth() + i * interval;
      if (byDay.length) {
        // e.g. 2MO = second Monday, -1FR = last Friday
        for (const spec of byDay) {
          const m = spec.match(/^([+-]?\d)?(\w\w)$/);
          if (!m) continue;
          const wd = WEEKDAYS.indexOf(m[2]);
          const nth = m[1] ? Number(m[1]) : 1;
          const days: number[] = [];
          const last = new Date(y, mo + 1, 0).getDate();
          for (let d = 1; d <= last; d++) if (new Date(y, mo, d).getDay() === wd) days.push(d);
          const day = nth > 0 ? days[nth - 1] : days[days.length + nth];
          if (day) candidates.push(at(y, mo, day));
        }
      } else {
        for (const d of byMonthDay.length ? byMonthDay : [base.getDate()]) {
          const last = new Date(y, mo + 1, 0).getDate();
          const day = d < 0 ? last + d + 1 : d;
          if (day >= 1 && day <= last) candidates.push(at(y, mo, day));
        }
      }
      candidates.sort((a, b) => a - b);
    } else if (freq === "YEARLY") {
      const y = base.getFullYear() + i * interval;
      const d = new Date(y, base.getMonth(), base.getDate());
      if (d.getMonth() === base.getMonth()) candidates = [at(y, base.getMonth(), base.getDate())];
    } else {
      return [e.start];
    }
    if (candidates.length && candidates[0] > until) break;
    for (const t of candidates) push(t);
  }
  return out;
}

function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Occurrences between two local dates (inclusive), one per day an event touches. */
export function icsOccurrences(cal: IcsCalendar, from: string, to: string): IcsOccurrence[] {
  const rangeStart = new Date(`${from}T00:00:00`).getTime();
  const rangeEnd = new Date(`${to}T23:59:59`).getTime();
  // Moved or cancelled single occurrences of repeating events.
  const overrides = new Map<string, Set<number>>();
  for (const e of cal.events) {
    if (e.recurrenceId === undefined) continue;
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Set());
    overrides.get(e.uid)!.add(e.recurrenceId);
  }
  const out: IcsOccurrence[] = [];
  for (const e of cal.events) {
    if (e.cancelled) continue;
    const length = e.end - e.start;
    const starts = e.rrule && e.recurrenceId === undefined ? repeatStarts(e, rangeEnd) : [e.start];
    const skip = overrides.get(e.uid);
    for (const s of starts) {
      if (e.rrule && (e.exdates.has(s) || (e.recurrenceId === undefined && skip?.has(s)))) continue;
      const end = e.allDay ? s + Math.max(length, 1) : s + length;
      if (end < rangeStart || s > rangeEnd) continue;
      // One entry per day the event touches.
      const lastMoment = e.allDay ? end - 1 : Math.max(s, end - 1);
      for (let day = isoDate(new Date(s)); day <= isoDate(new Date(lastMoment)) && day <= to; day = addDays(day, 1)) {
        if (day < from) continue;
        const dayStart = new Date(`${day}T00:00:00`).getTime();
        const occ: IcsOccurrence = { uid: e.uid, title: e.title, location: e.location, description: e.description, date: day, allDay: e.allDay };
        if (!e.allDay) {
          occ.startMin = Math.max(0, Math.round((s - dayStart) / 60_000));
          occ.endMin = Math.min(24 * 60 - 1, Math.max(occ.startMin + 15, Math.round((end - dayStart) / 60_000)));
          occ.start = hhmm(s);
          occ.end = hhmm(end);
        }
        out.push(occ);
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.startMin ?? -1) - (b.startMin ?? -1));
}

/** Adds the calendar's name and color to a downloaded .ics file (so other devices show it the same). */
export function labelIcs(text: string, name: string, color: string): string {
  const cleaned = text.replace(/^(X-VIMMI-COLOR|X-WR-CALNAME)[:;].*\r?\n/gm, "");
  return cleaned.replace(/BEGIN:VCALENDAR\r?\n/, (m) => `${m}X-VIMMI-COLOR:${color}\r\nX-WR-CALNAME:${name.replace(/[\r\n]/g, " ")}\r\n`);
}
