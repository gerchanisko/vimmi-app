// "Kalendář v telefonu": Vimmi's events as an iCal feed in a secret gist.
process.env.TZ = "Europe/Prague";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventMarkdown } from "../shared/calendar";
import { CalendarFeed, eventsToIcs, type FeedInfo } from "../shared/calendar-feed";
import { eventsFromNotes } from "../shared/calendar";
import { icsOccurrences, parseIcs } from "../shared/ics";
import type { SyncConfig } from "../shared/sync";
import { Vault } from "../shared/vault";
import { FakeGitHub } from "./fake-github";
import { MemoryStorage } from "./memory-storage";

async function vaultWithEvents() {
  const storage = new MemoryStorage();
  await storage.writeText("Kalendář/2026-10-20 Doktor.md", eventMarkdown({ title: "Doktor, MUDr. Nová", date: "2026-10-20", start: "10:00", end: "10:30", location: "Poliklinika; 2. patro", remind: 30 }));
  await storage.writeText("Kalendář/2026-10-21 Trénink.md", eventMarkdown({ title: "Trénink", date: "2026-10-21", start: "18:00", end: "19:30", repeat: "weekly" }));
  await storage.writeText("Kalendář/2026-10-30 Hory.md", eventMarkdown({ title: "Hory", date: "2026-10-30", endDate: "2026-11-01", allDay: true }));
  const vault = new Vault(storage);
  await vault.load();
  return vault;
}

describe("feed content", () => {
  it("round-trips Vimmi events with reminders, repeats and all-day events", async () => {
    const vault = await vaultWithEvents();
    const ics = eventsToIcs(eventsFromNotes(vault.metas()), "Europe/Prague");
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).toContain("RRULE:FREQ=WEEKLY");
    expect(ics).toContain("SUMMARY:Doktor\\, MUDr. Nová");
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const occ = icsOccurrences(parseIcs(ics), "2026-10-19", "2026-11-05");
    expect(occ.map((o) => `${o.date} ${o.start ?? "celý den"} ${o.title}`)).toEqual([
      "2026-10-20 10:00 Doktor, MUDr. Nová",
      "2026-10-21 18:00 Trénink",
      "2026-10-28 18:00 Trénink",
      "2026-10-30 celý den Hory",
      "2026-10-31 celý den Hory",
      "2026-11-01 celý den Hory",
      "2026-11-04 18:00 Trénink",
    ]);
  });
});

describe("feed publishing", () => {
  let gh: FakeGitHub;
  const realFetch = globalThis.fetch;
  const cfg: SyncConfig = { owner: "me", repo: "notes", token: "t", device: "pc", apiBase: "https://gh.test" };
  beforeEach(() => {
    gh = new FakeGitHub();
    globalThis.fetch = gh.fetch as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("creates a secret gist, reuses it from another device, updates it and deletes it", async () => {
    const vault = await vaultWithEvents();
    let saved: FeedInfo | undefined;
    const feed = new CalendarFeed(() => vault, () => cfg, () => saved, (f) => (saved = f));
    const st = await feed.enable();
    expect(st.state).toBe("ok");
    expect(gh.gists.size).toBe(1);
    const [gist] = [...gh.gists.values()];
    expect(gist.public).toBe(false);
    expect(gist.files["vimmi.ics"]).toContain("Doktor");
    expect(saved?.url).toMatch(/^https:\/\/gist\.githubusercontent\.com\/me\/\w+\/raw\/vimmi\.ics$/);

    // A second device finds the same gist instead of making another one.
    let saved2: FeedInfo | undefined;
    await new CalendarFeed(() => vault, () => cfg, () => saved2, (f) => (saved2 = f)).enable();
    expect(gh.gists.size).toBe(1);
    expect(saved2?.gistId).toBe(saved?.gistId);

    // Unchanged events: nothing is uploaded; a change is.
    const before = gh.requests;
    await feed.publish();
    expect(gh.requests).toBe(before);
    await vault.write("Kalendář/2026-10-20 Doktor.md", vault.read("Kalendář/2026-10-20 Doktor.md").replace("10:00", "11:00"));
    await feed.publish();
    expect([...gh.gists.values()][0].files["vimmi.ics"]).toContain("T110000");

    await feed.disable();
    expect(gh.gists.size).toBe(0);
    expect(saved).toBeUndefined();
  });

  it("explains a token without the Gists permission", async () => {
    gh.gistsForbidden = true;
    const vault = await vaultWithEvents();
    const st = await new CalendarFeed(() => vault, () => cfg, () => undefined, () => {}).enable();
    expect(st.state).toBe("error");
    expect(st.message).toContain("Gists: Read and write");
  });
});
