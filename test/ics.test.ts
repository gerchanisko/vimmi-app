// iCalendar parsing: time zones, repeats, exceptions, all-day and multi-day events.
process.env.TZ = "Europe/Prague";
import { describe, expect, it } from "vitest";
import { icsOccurrences, labelIcs, parseIcs } from "../shared/ics";

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Práce\r\nX-WR-TIMEZONE:Europe/Prague\r\n${body}END:VCALENDAR\r\n`;
const ev = (lines: string) => `BEGIN:VEVENT\r\n${lines.trim().split("\n").map((l) => l.trim()).join("\r\n")}\r\nEND:VEVENT\r\n`;

describe("ics", () => {
  it("reads a timed event in another time zone and UTC", () => {
    const cal = parseIcs(
      ics(
        ev(`UID:1
        SUMMARY:Porada\\, tým
        DTSTART;TZID=Europe/London:20261020T090000
        DTEND;TZID=Europe/London:20261020T100000
        LOCATION:Zasedačka
        BEGIN:VALARM
        TRIGGER:-PT10M
        SUMMARY:alarm
        END:VALARM`) +
          ev(`UID:2
        SUMMARY:Hovor
        DTSTART:20261020T150000Z
        DURATION:PT30M`),
      ),
    );
    expect(cal.name).toBe("Práce");
    const occ = icsOccurrences(cal, "2026-10-20", "2026-10-20");
    expect(occ.map((o) => [o.title, o.start, o.end, o.location])).toEqual([
      ["Porada, tým", "10:00", "11:00", "Zasedačka"],
      ["Hovor", "17:00", "17:30", undefined],
    ]);
  });

  it("all-day and multi-day events", () => {
    const cal = parseIcs(
      ics(
        ev(`UID:a
        SUMMARY:Státní svátek
        DTSTART;VALUE=DATE:20261028
        DTEND;VALUE=DATE:20261029`) +
          ev(`UID:b
        SUMMARY:Hory
        DTSTART;VALUE=DATE:20261030
        DTEND;VALUE=DATE:20261102`),
      ),
    );
    const occ = icsOccurrences(cal, "2026-10-27", "2026-11-05");
    expect(occ.filter((o) => o.title === "Státní svátek").map((o) => o.date)).toEqual(["2026-10-28"]);
    expect(occ.filter((o) => o.title === "Hory").map((o) => o.date)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(occ.every((o) => o.allDay)).toBe(true);
  });

  it("weekly repeats keep the local time across the DST change, with exceptions and a moved occurrence", () => {
    const cal = parseIcs(
      ics(
        ev(`UID:w
        SUMMARY:Trénink
        DTSTART;TZID=Europe/Prague:20261019T180000
        DTEND;TZID=Europe/Prague:20261019T193000
        RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=6
        EXDATE;TZID=Europe/Prague:20261022T180000`) +
          ev(`UID:w
        SUMMARY:Trénink (přesunutý)
        RECURRENCE-ID;TZID=Europe/Prague:20261026T180000
        DTSTART;TZID=Europe/Prague:20261027T190000
        DTEND;TZID=Europe/Prague:20261027T200000`),
      ),
    );
    const occ = icsOccurrences(cal, "2026-10-19", "2026-11-10");
    expect(occ.map((o) => `${o.date} ${o.start} ${o.title}`)).toEqual([
      "2026-10-19 18:00 Trénink",
      "2026-10-27 19:00 Trénink (přesunutý)",
      "2026-10-29 18:00 Trénink",
      "2026-11-02 18:00 Trénink",
      "2026-11-05 18:00 Trénink",
    ]);
  });

  it("monthly by weekday, yearly and UNTIL", () => {
    const cal = parseIcs(
      ics(
        ev(`UID:m
        SUMMARY:Schůze SVJ
        DTSTART;TZID=Europe/Prague:20260914T170000
        DTEND;TZID=Europe/Prague:20260914T180000
        RRULE:FREQ=MONTHLY;BYDAY=2MO;UNTIL=20261231T000000Z`) +
          ev(`UID:y
        SUMMARY:Narozeniny
        DTSTART;VALUE=DATE:20000303
        RRULE:FREQ=YEARLY`),
      ),
    );
    const occ = icsOccurrences(cal, "2026-10-01", "2027-03-31");
    expect(occ.filter((o) => o.title === "Schůze SVJ").map((o) => o.date)).toEqual(["2026-10-12", "2026-11-09", "2026-12-14"]);
    expect(occ.filter((o) => o.title === "Narozeniny").map((o) => o.date)).toEqual(["2027-03-03"]);
  });

  it("skips cancelled events and labels downloaded files", () => {
    const text = ics(ev(`UID:c\nSUMMARY:Zrušeno\nSTATUS:CANCELLED\nDTSTART:20261020T100000Z`));
    expect(icsOccurrences(parseIcs(text), "2026-10-20", "2026-10-20")).toEqual([]);
    const labelled = parseIcs(labelIcs(text, "Google", "blue"));
    expect(labelled).toMatchObject({ name: "Google", color: "blue" });
  });
});
