// Subscribed calendars: download into the vault, keep the secret address out of it.
import { describe, expect, it } from "vitest";
import { CalendarSubscriptions, normalizeCalendarUrl } from "../shared/calendar-subs";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types";
import { Vault } from "../shared/vault";
import { MemoryStorage } from "./memory-storage";

const ICS = (stamp: string) =>
  `BEGIN:VCALENDAR\r\nX-WR-CALNAME:Můj Google\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTAMP:${stamp}\r\nSUMMARY:Zubař\r\nDTSTART:20261020T080000Z\r\nDTEND:20261020T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const SECRET = "https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123secret/basic.ics";

async function setup() {
  const storage = new MemoryStorage();
  const vault = new Vault(storage);
  await vault.load();
  let settings: Settings = { ...DEFAULT_SETTINGS, calendars: [] };
  let stamp = "20261015T100000Z";
  let fetches = 0;
  globalThis.fetch = (async (url: string) => {
    fetches++;
    if (String(url).includes("chyba")) return new Response("nope", { status: 404 });
    return new Response(ICS(stamp), { status: 200 });
  }) as typeof fetch;
  const subs = new CalendarSubscriptions(
    () => vault,
    () => settings,
    (calendars) => (settings = { ...settings, calendars }),
  );
  return {
    vault,
    storage,
    subs,
    settings: () => settings,
    setStamp: (s: string) => (stamp = s),
    fetches: () => fetches,
    files: () => vault.snapshot().files,
  };
}

describe("calendar subscriptions", () => {
  it("downloads into the vault without the secret address and without rewriting unchanged calendars", async () => {
    const t = await setup();
    await t.subs.save([{ id: "g", name: "Google", url: SECRET.replace("https:", "webcal:"), color: "sage" }]);
    expect(t.files()).toEqual(["Kalendář/Odebírané/Google.ics"]);
    const text = new TextDecoder().decode(await t.vault.readBytes("Kalendář/Odebírané/Google.ics"));
    expect(text).toContain("SUMMARY:Zubař");
    expect(text).toContain("X-VIMMI-COLOR:sage");
    expect(text).not.toContain("private-abc123secret");
    expect(text).not.toContain("DTSTAMP");
    expect(t.subs.status.g).toMatchObject({ events: 1, busy: false });
    expect(t.settings().calendars[0].file).toBe("Kalendář/Odebírané/Google.ics");

    // Google changes DTSTAMP on every download; the file must stay the same (no new sync commit).
    let changes = 0;
    t.vault.on("note-changed", () => changes++);
    t.setStamp("20261015T110000Z");
    await t.subs.refresh();
    expect(changes).toBe(0);
  });

  it("renaming moves the file, removing deletes it, errors are reported", async () => {
    const t = await setup();
    await t.subs.save([{ id: "g", name: "Google", url: SECRET, color: "blue" }]);
    await t.subs.save([{ ...t.settings().calendars[0], name: "Práce" }]);
    expect(t.files()).toEqual(["Kalendář/Odebírané/Práce.ics"]);
    await t.subs.save([]);
    expect(t.files()).toEqual([]);
    await t.subs.save([{ id: "x", name: "Špatná", url: "https://example.com/chyba.ics", color: "blue" }]);
    expect(t.subs.status.x.error).toContain("404");
  });

  it("accepts only https (or webcal) addresses", () => {
    expect(normalizeCalendarUrl("webcal://p01.calendar.example/x.ics")).toBe("https://p01.calendar.example/x.ics");
    expect(() => normalizeCalendarUrl("http://example.com/x.ics")).toThrow("https://");
    expect(() => normalizeCalendarUrl("file:///etc/passwd")).toThrow();
  });
});
