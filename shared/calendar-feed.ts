// "Kalendář v telefonu": publishes Vimmi's own events as an iCal feed in a secret GitHub Gist.
// The phone subscribes to it in its own Calendar app, which then shows the events and fires
// reminders even when Vimmi is closed. A secret gist is unlisted, but anyone with the link
// can read it – like Google Calendar's secret iCal address.
import { type CalendarEvent, eventsFromNotes } from "./calendar";
import { Emitter } from "./emitter";
import { GitHub, SyncError, type SyncConfig } from "./sync";
import type { Vault } from "./vault";

export const FEED_FILE = "vimmi.ics";
const FEED_DESCRIPTION = "Vimmi – kalendář pro telefon (neveřejný odkaz)";

export interface FeedInfo {
  gistId: string;
  /** Always the newest version of the feed. */
  url: string;
}

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

/** Folds lines longer than 75 octets, as iCalendar requires. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

const compact = (date: string) => date.replace(/-/g, "");
const compactTime = (date: string, time: string) => `${compact(date)}T${time.replace(":", "")}00`;

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

const RRULE: Record<string, string> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };

/** The iCal text for Vimmi's events. `tz` is the IANA time zone the times are in. */
export function eventsToIcs(events: CalendarEvent[], tz: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Vimmi//Kalendar//CS", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Vimmi", `X-WR-TIMEZONE:${tz}`];
  for (const e of events) {
    if (e.external) continue;
    lines.push("BEGIN:VEVENT", `UID:${esc(e.path)}@vimmi`, `DTSTAMP:${stamp}`, `SUMMARY:${esc(e.title)}`);
    if (e.allDay || !e.start) {
      lines.push(`DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${nextDay(e.endDate ?? e.date)}`);
    } else {
      lines.push(`DTSTART;TZID=${tz}:${compactTime(e.date, e.start)}`, `DTEND;TZID=${tz}:${compactTime(e.date, e.end ?? e.start)}`);
    }
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.description.trim()) lines.push(`DESCRIPTION:${esc(e.description.trim())}`);
    if (e.repeat) lines.push(`RRULE:FREQ=${RRULE[e.repeat]}${e.until ? `;UNTIL=${compact(e.until)}` : ""}`);
    if (e.remind !== undefined && !e.allDay) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${e.remind}M`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Content without the timestamps, to tell whether anything really changed. */
const essence = (ics: string) => ics.replace(/^DTSTAMP:.*\r?\n/gm, "");

function gistError(status: number): never {
  if (status === 403 || status === 404) {
    throw new SyncError("Token nemá přístup ke Gistům. Na GitHubu u tokenu přidej oprávnění „Gists: Read and write“ (v části Account permissions).", status);
  }
  throw new SyncError(`GitHub odpověděl ${status}.`, status);
}

type Gist = { id: string; description: string | null; owner?: { login: string }; files: Record<string, { raw_url?: string; content?: string }> };

const feedUrl = (g: Gist) => `https://gist.githubusercontent.com/${g.owner?.login ?? "_"}/${g.id}/raw/${FEED_FILE}`;

/** Finds the feed gist made earlier (on any device), or creates one. */
export async function enableFeed(cfg: SyncConfig, ics: string): Promise<FeedInfo> {
  const gh = new GitHub(cfg);
  const list = await gh.req<Gist[]>("GET", "/gists?per_page=100", undefined, [403, 404]);
  if (list.status !== 200) gistError(list.status);
  const existing = list.data.find((g) => g.description === FEED_DESCRIPTION && g.files[FEED_FILE]);
  if (existing) {
    await publishFeed(cfg, existing.id, ics, true);
    return { gistId: existing.id, url: feedUrl(existing) };
  }
  const created = await gh.req<Gist>("POST", "/gists", { description: FEED_DESCRIPTION, public: false, files: { [FEED_FILE]: { content: ics } } }, [403, 404, 422]);
  if (created.status !== 201) gistError(created.status);
  return { gistId: created.data.id, url: feedUrl(created.data) };
}

/** Updates the gist when the events changed. Returns whether anything was sent. */
export async function publishFeed(cfg: SyncConfig, gistId: string, ics: string, force = false): Promise<boolean> {
  const gh = new GitHub(cfg);
  if (!force) {
    const current = await gh.req<Gist>("GET", `/gists/${encodeURIComponent(gistId)}`, undefined, [403, 404]);
    if (current.status !== 200) gistError(current.status);
    const old = current.data.files[FEED_FILE]?.content;
    if (old !== undefined && essence(old) === essence(ics)) return false;
  }
  const r = await gh.req("PATCH", `/gists/${encodeURIComponent(gistId)}`, { files: { [FEED_FILE]: { content: ics } } }, [403, 404]);
  if (r.status !== 200) gistError(r.status);
  return true;
}

export async function disableFeed(cfg: SyncConfig, gistId: string): Promise<void> {
  const gh = new GitHub(cfg);
  await gh.req("DELETE", `/gists/${encodeURIComponent(gistId)}`, undefined, [404]);
}

/** Vimmi's events as iCal text, in this device's time zone. */
export function vaultFeed(vault: Vault): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Prague";
  return eventsToIcs(eventsFromNotes(vault.metas()), tz);
}

export interface FeedStatus {
  state: "off" | "ok" | "busy" | "error";
  url?: string;
  /** Last successful upload. */
  at?: number;
  message?: string;
}

/** Keeps the phone feed up to date after event changes (a few seconds after the last change). */
export class CalendarFeed extends Emitter {
  status: FeedStatus = { state: "off" };
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private lastSent?: string;
  private sentTo?: string;

  constructor(
    private getVault: () => Vault | undefined,
    private getConfig: () => SyncConfig | null,
    private getFeed: () => FeedInfo | undefined,
    private saveFeed: (feed: FeedInfo | undefined) => void,
  ) {
    super();
  }

  private set(patch: Partial<FeedStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  /** Watches the vault of the current session (call after opening a vault). */
  start(): void {
    this.unsubscribe?.();
    const vault = this.getVault();
    const feed = this.getFeed();
    // What was uploaded is remembered per gist (another vault or gist starts fresh).
    if (feed?.gistId !== this.sentTo) this.lastSent = undefined;
    if (!vault || !feed) {
      this.set({ state: "off", url: undefined, message: undefined });
      return;
    }
    this.set({ state: "ok", url: feed.url, message: undefined });
    this.unsubscribe = vault.on("note-changed", () => this.schedule());
    this.schedule(2_000);
  }

  private schedule(ms = 8_000): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.publish(), ms);
  }

  async publish(): Promise<FeedStatus> {
    const vault = this.getVault();
    const feed = this.getFeed();
    const cfg = this.getConfig();
    if (!vault || !feed || !cfg) return this.status;
    const ics = vaultFeed(vault);
    if (this.lastSent !== undefined && essence(ics) === this.lastSent) return this.status;
    try {
      await publishFeed(cfg, feed.gistId, ics);
      this.lastSent = essence(ics);
      this.sentTo = feed.gistId;
      this.set({ state: "ok", at: Date.now(), message: undefined, url: feed.url });
    } catch (err) {
      this.set({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return this.status;
  }

  async enable(): Promise<FeedStatus> {
    const vault = this.getVault();
    const cfg = this.getConfig();
    if (!vault) throw new Error("Není otevřený trezor.");
    if (!cfg) throw new Error("Nejdřív zapni synchronizaci s GitHubem (Nastavení → Synchronizace). Kalendář pro telefon používá stejný token.");
    this.set({ state: "busy", message: undefined });
    try {
      const ics = vaultFeed(vault);
      const feed = await enableFeed(cfg, ics);
      this.saveFeed(feed);
      this.lastSent = essence(ics);
      this.sentTo = feed.gistId;
      this.set({ state: "ok", url: feed.url, at: Date.now() });
      this.start();
    } catch (err) {
      this.set({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return this.status;
  }

  /** Deletes the gist: the phone's subscribed calendar then becomes empty or stops updating. */
  async disable(): Promise<FeedStatus> {
    const feed = this.getFeed();
    const cfg = this.getConfig();
    this.unsubscribe?.();
    clearTimeout(this.timer);
    if (feed && cfg) await disableFeed(cfg, feed.gistId).catch(() => {});
    this.saveFeed(undefined);
    this.set({ state: "off", url: undefined, at: undefined, message: undefined });
    return this.status;
  }
}
