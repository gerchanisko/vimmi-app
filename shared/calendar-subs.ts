// Subscribed calendars: downloads each calendar's .ics address and saves it into the vault
// (Kalendář/Odebírané/<name>.ics), so the calendar shows it and sync carries it to the phone.
// The secret address itself stays in the device settings and never enters the vault.
import { labelIcs, parseIcs } from "./ics";
import { joinPath, safeFileName } from "./markdown";
import { Emitter } from "./emitter";
import type { CalendarSubscription, CalendarSubscriptionStatus, Settings } from "./types";
import type { Vault } from "./vault";

const MAX_BYTES = 15 * 1024 * 1024;

export function subscriptionFile(calendarFolder: string, sub: Pick<CalendarSubscription, "name">): string {
  return joinPath(calendarFolder || "Kalendář", "Odebírané", `${safeFileName(sub.name) || "Kalendář"}.ics`);
}

/** webcal:// → https://; only https (and local addresses for testing) are allowed. */
export function normalizeCalendarUrl(url: string): string {
  const u = new URL(url.trim().replace(/^webcals?:\/\//i, "https://"));
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("Adresa kalendáře musí začínat https:// (nebo webcal://).");
  return u.toString();
}

/** Lines that change on every download (DTSTAMP) would make sync commit the file each time. */
function stable(text: string): string {
  return text.replace(/^DTSTAMP[:;].*\r?\n/gm, "");
}

export async function downloadCalendar(
  vault: Vault,
  calendarFolder: string,
  sub: CalendarSubscription,
  fetchImpl: typeof fetch = fetch,
): Promise<{ file: string; status: CalendarSubscriptionStatus }> {
  let res: Response;
  try {
    res = await fetchImpl(normalizeCalendarUrl(sub.url), { headers: { Accept: "text/calendar, */*" }, cache: "no-store" });
  } catch (err) {
    if (err instanceof Error && /https:\/\//.test(err.message)) throw err;
    throw new Error("Kalendář se nepodařilo stáhnout. Jsi připojený k internetu? (Ve webové aplikaci to prohlížeč nedovolí – odběr obnovuje aplikace na počítači.)");
  }
  if (!res.ok) throw new Error(res.status === 404 ? "Adresa kalendáře neexistuje (404). Zkontroluj, že jsi zkopíroval celou." : `Server kalendáře odpověděl ${res.status}.`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("Kalendář je příliš velký.");
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("Na adrese není kalendář ve formátu iCal (.ics).");
  const content = stable(labelIcs(text, sub.name, sub.color));
  const file = subscriptionFile(calendarFolder, sub);
  const current = vault.snapshot().files.includes(file) ? new TextDecoder().decode(await vault.readBytes(file)) : null;
  if (current !== content) await vault.writeSynced(file, new TextEncoder().encode(content));
  // A renamed subscription: remove the file under the old name.
  if (sub.file && sub.file !== file && vault.snapshot().files.includes(sub.file)) await vault.trash(sub.file);
  return { file, status: { at: Date.now(), events: parseIcs(content).events.length } };
}

const REFRESH_MS = 30 * 60_000;

/** Keeps subscribed calendars fresh: shortly after start, every 30 minutes and on demand. */
export class CalendarSubscriptions extends Emitter {
  status: Record<string, CalendarSubscriptionStatus> = {};
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;

  constructor(
    private getVault: () => Vault | undefined,
    private getSettings: () => Settings,
    private saveSubs: (subs: CalendarSubscription[]) => void,
  ) {
    super();
  }

  start(): void {
    this.stop();
    this.first = setTimeout(() => void this.refresh(), 3_000);
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  private set(id: string, patch: CalendarSubscriptionStatus): void {
    this.status = { ...this.status, [id]: { ...this.status[id], ...patch } };
    this.emit("status", this.status);
  }

  /** Downloads one calendar (or all of them). */
  async refresh(id?: string): Promise<Record<string, CalendarSubscriptionStatus>> {
    const vault = this.getVault();
    if (!vault) return this.status;
    for (const sub of this.getSettings().calendars.filter((s) => !id || s.id === id)) {
      this.set(sub.id, { busy: true });
      try {
        const { file, status } = await downloadCalendar(vault, this.getSettings().calendarFolder, sub);
        if (sub.file !== file) {
          this.saveSubs(this.getSettings().calendars.map((s) => (s.id === sub.id ? { ...s, file } : s)));
        }
        this.set(sub.id, { ...status, busy: false, error: undefined });
      } catch (err) {
        this.set(sub.id, { busy: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.status;
  }

  /** Saves the list; removed calendars disappear from the vault, new and changed ones download. */
  async save(next: CalendarSubscription[]): Promise<void> {
    const before = this.getSettings().calendars;
    const vault = this.getVault();
    for (const old of before) {
      if (next.some((s) => s.id === old.id)) continue;
      if (vault && old.file && vault.snapshot().files.includes(old.file)) await vault.trash(old.file).catch(() => {});
      const { [old.id]: _gone, ...rest } = this.status;
      this.status = rest;
    }
    this.saveSubs(next);
    for (const sub of next) {
      const prev = before.find((s) => s.id === sub.id);
      if (!prev || prev.url !== sub.url || prev.name !== sub.name || prev.color !== sub.color) await this.refresh(sub.id);
    }
    this.emit("status", this.status);
  }
}
