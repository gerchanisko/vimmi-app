import { describe, expect, it } from "vitest";
import { dueReminders, eventFromMeta, eventMarkdown, eventsFromNotes, occurrences, type CalendarEvent } from "../shared/calendar";
import { parseNote } from "../shared/markdown";
import { splitFrontmatter } from "../shared/vault";

function noteFrom(path: string, content: string) {
  const { data, body, offset } = splitFrontmatter(content);
  return parseNote(path, body, data, { mtime: 0, ctime: 0 }, offset);
}

describe("calendar events", () => {
  it("round-trips an event through Markdown", () => {
    const md = eventMarkdown({ title: "Doktor", date: "2026-10-15", start: "10:00", end: "10:45", location: "Poliklinika: 2. patro", remind: 30 });
    const e = eventFromMeta(noteFrom("Kalendář/2026-10-15 Doktor.md", md))!;
    expect(e).toMatchObject({ title: "Doktor", date: "2026-10-15", start: "10:00", end: "10:45", allDay: false, location: "Poliklinika: 2. patro", remind: 30 });
  });

  it("reads all-day and multi-day events and fixes a missing end time", () => {
    const allDay = eventFromMeta(noteFrom("a.md", "---\ntype: event\ndate: 2026-10-20\nend_date: 2026-10-22\ntitle: Dovolená\n---\n"))!;
    expect(allDay).toMatchObject({ allDay: true, endDate: "2026-10-22" });
    const noEnd = eventFromMeta(noteFrom("b.md", "---\ntype: event\ndate: 2026-10-20\nstart: 9:30\n---\n"))!;
    expect(noEnd).toMatchObject({ start: "09:30", end: "10:30", title: "b" });
    expect(eventFromMeta(noteFrom("c.md", "# jen poznámka"))).toBeNull();
  });

  it("expands repeating and multi-day events into occurrences", () => {
    const base = { path: "x", color: "accent", description: "", allDay: false, start: "08:00", end: "09:00" } as const;
    const events: CalendarEvent[] = [
      { ...base, title: "Trénink", date: "2026-10-01", repeat: "weekly" },
      { ...base, title: "Výplata", date: "2026-01-31", repeat: "monthly", allDay: true, start: undefined, end: undefined },
      { ...base, title: "Hory", date: "2026-10-30", endDate: "2026-11-02", allDay: true, start: undefined, end: undefined },
      { ...base, title: "Kurz", date: "2026-10-05", repeat: "daily", until: "2026-10-07" },
    ];
    const oct = occurrences(events, "2026-10-01", "2026-10-31");
    expect(oct.filter((o) => o.event.title === "Trénink").map((o) => o.date)).toEqual(["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]);
    // The 31st only exists in some months.
    expect(oct.filter((o) => o.event.title === "Výplata").map((o) => o.date)).toEqual(["2026-10-31"]);
    expect(occurrences(events, "2026-11-01", "2026-11-30").filter((o) => o.event.title === "Výplata")).toEqual([]);
    expect(oct.filter((o) => o.event.title === "Kurz").map((o) => o.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(occurrences(events, "2026-11-01", "2026-11-05").filter((o) => o.event.title === "Hory").map((o) => o.date)).toEqual(["2026-11-01", "2026-11-02"]);
  });

  it("finds reminders that became due", () => {
    const notes = [noteFrom("Kalendář/d.md", eventMarkdown({ title: "Doktor", date: "2026-10-15", start: "10:00", end: "11:00", remind: 15 }))];
    const events = eventsFromNotes(notes);
    const at = (t: string) => new Date(`2026-10-15T${t}:00`).getTime();
    expect(dueReminders(events, at("09:40"), at("09:46")).map((o) => o.event.title)).toEqual(["Doktor"]);
    expect(dueReminders(events, at("09:46"), at("09:50"))).toEqual([]);
  });
});
