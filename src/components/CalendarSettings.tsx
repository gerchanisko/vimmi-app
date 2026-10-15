// Settings → Kalendář: subscribed calendars (Google Calendar and others) and .ics import.
import { useEffect, useState } from "react";
import { EVENT_COLORS, type EventColor } from "../../shared/calendar";
import type { FeedStatus } from "../../shared/calendar-feed";
import type { CalendarSubscription, CalendarSubscriptionStatus, Settings } from "../../shared/types";
import { confirm, errorText, refreshSnapshot, setState, toast } from "../lib/store";
import { COLOR_VAR } from "./Calendar";
import { Icon } from "./Icon";

const COLOR_LABEL: Record<EventColor, string> = { accent: "Fialová", blue: "Modrá", sage: "Zelená", ochre: "Žlutá", clay: "Červená", gray: "Šedá" };

function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return "právě teď";
  if (min < 60) return `před ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `před ${h} h` : new Date(at).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url.replace(/^webcals?:/i, "https:"));
    return `${u.host}/…`;
  } catch {
    return "…";
  }
}

export function CalendarSettingsPanel({ settings }: { settings: Settings }) {
  const subs = settings.calendars ?? [];
  const web = window.vimmi.app.kind === "web";
  const [status, setStatus] = useState<Record<string, CalendarSubscriptionStatus>>({});
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState<EventColor>("blue");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.vimmi.calendar.status().then(setStatus);
    return window.vimmi.calendar.onStatus(setStatus);
  }, []);

  const save = async (next: CalendarSubscription[]) => {
    const s = await window.vimmi.calendar.save(next);
    setState({ settings: s });
    await refreshSnapshot();
  };

  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const sub: CalendarSubscription = { id: Math.random().toString(36).slice(2, 10), name: name.trim() || "Google Kalendář", url: url.trim(), color };
      await save([...subs, sub]);
      setName("");
      setUrl("");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const importFile = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ics,text/calendar";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("Soubor není kalendář ve formátu iCal (.ics).");
        const rel = await window.vimmi.vault.attachment(file.name.endsWith(".ics") ? file.name : `${file.name}.ics`, new TextEncoder().encode(text));
        await refreshSnapshot();
        toast(`Kalendář je v ${rel} – uvidíš ho v Kalendáři.`, "ok");
      } catch (err) {
        toast(errorText(err), "error");
      }
    };
    input.click();
  };

  return (
    <>
      <h3>Kalendář</h3>
      <p className="muted">
        Vidíš tu i události z jiných kalendářů, třeba z Google Kalendáře nebo školního rozvrhu. Jsou jen pro čtení – měníš je tam, odkud pocházejí.
      </p>

      <PhoneFeed settings={settings} />

      <h4 className="settings-sub">Odebírané kalendáře</h4>
      {web && (
        <p className="notice">
          <Icon name="info" size={14} /> Prohlížeč většinou nedovolí kalendář stáhnout (Google to blokuje). Přidej ho v aplikaci na počítači – ta ho stahuje každých 30 minut a telefon ho dostane přes synchronizaci.
        </p>
      )}
      {subs.length === 0 && <p className="muted small">Zatím žádný odebíraný kalendář.</p>}
      <div className="cal-subs">
        {subs.map((s) => {
          const st = status[s.id];
          return (
            <div key={s.id} className="cal-sub">
              <span className="color-dot on-static" style={{ background: COLOR_VAR[(s.color as EventColor) ?? "blue"] ?? COLOR_VAR.blue }} />
              <div className="cal-sub-text">
                <strong>{s.name}</strong>
                <span className="muted small">
                  {maskUrl(s.url)} ·{" "}
                  {st?.busy ? "stahuji…" : st?.error ? <span className="error-text">{st.error}</span> : st?.at ? `aktualizováno ${ago(st.at)}, ${st.events} událostí` : "čeká na stažení"}
                </span>
              </div>
              <button className="btn small" disabled={st?.busy} onClick={() => void window.vimmi.calendar.refresh(s.id)}>
                <Icon name="sync" size={13} /> Obnovit
              </button>
              <button
                className="icon-btn"
                title="Odebrat"
                aria-label={`Odebrat ${s.name}`}
                onClick={() => void save(subs.filter((x) => x.id !== s.id)).then(() => toast(`Kalendář „${s.name}“ je odebraný.`))}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="cal-sub-form">
        <input placeholder="Název (např. Google, Práce)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Název kalendáře" />
        <input
          className="grow-input"
          placeholder="Tajná adresa ve formátu iCal (https://… .ics)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="Adresa kalendáře"
        />
        <div className="event-colors" role="radiogroup" aria-label="Barva">
          {EVENT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={COLOR_LABEL[c]}
              title={COLOR_LABEL[c]}
              className={`color-dot${color === c ? " on" : ""}`}
              style={{ background: COLOR_VAR[c] }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <button className="btn primary" disabled={!url.trim() || busy} onClick={() => void add()}>
          <Icon name="plus" size={14} /> Přidat kalendář
        </button>
      </div>

      <details className="cal-help">
        <summary>Jak získat adresu Google Kalendáře</summary>
        <ol>
          <li>
            Otevři <b>calendar.google.com</b> na počítači.
          </li>
          <li>
            Vpravo nahoře klikni na <b>⚙ → Nastavení</b>.
          </li>
          <li>Vlevo vyber svůj kalendář (pod „Nastavení mých kalendářů“).</li>
          <li>
            Sjeď na <b>Integrace kalendáře</b> a zkopíruj <b>Tajná adresa ve formátu iCal</b>.
          </li>
          <li>Vlož ji sem a dej „Přidat kalendář“.</li>
        </ol>
        <p className="muted small">
          Kdo tuhle adresu zná, vidí tvůj kalendář – nikomu ji nedávej. Vimmi ji uloží jen v tomto zařízení (ne do poznámek ani na GitHub). Do trezoru
          ukládá jen stažené události, aby je viděl i telefon.
        </p>
      </details>

      <h4 className="settings-sub">Import</h4>
      <p className="muted small">Máš kalendář jako soubor .ics (rozvrh, export z jiné aplikace)? Naimportuj ho – zobrazí se v Kalendáři.</p>
      <button className="btn" onClick={() => void importFile()}>
        <Icon name="calendar" size={14} /> Importovat soubor .ics
      </button>
    </>
  );
}

/** "Kalendář v telefonu": Vimmi's events in the phone's own Calendar app, with reminders. */
function PhoneFeed({ settings }: { settings: Settings }) {
  const [status, setStatus] = useState<FeedStatus>({ state: settings.calendarFeed ? "ok" : "off", url: settings.calendarFeed?.url });
  const syncReady = Boolean(settings.sync.enabled && settings.hasSyncToken);
  useEffect(() => {
    void window.vimmi.calendar.feedStatus().then(setStatus);
    return window.vimmi.calendar.onFeedStatus(setStatus);
  }, []);

  const enable = async () => {
    const st = await window.vimmi.calendar.feedEnable().catch((err) => ({ state: "error" as const, message: errorText(err) }));
    setStatus(st);
    setState({ settings: await window.vimmi.settings.get() });
  };
  const disable = async () => {
    if (!(await confirm("Vypnout kalendář v telefonu?", "Odkaz přestane fungovat a telefon přestane dostávat nové události.", "Vypnout", true))) return;
    setStatus(await window.vimmi.calendar.feedDisable());
    setState({ settings: await window.vimmi.settings.get() });
  };
  const url = status.url ?? settings.calendarFeed?.url;
  const webcal = url?.replace(/^https:/, "webcal:");

  return (
    <>
      <h4 className="settings-sub">Kalendář v telefonu</h4>
      <p className="muted small">
        Tvoje události z Vimmi i v kalendáři telefonu – i s připomenutím, když je Vimmi zavřená. Vimmi je zveřejní na tajném odkazu (soukromý Gist na
        tvém GitHubu) a telefon ho odebírá. Kdo odkaz zná, události uvidí – nikomu ho nedávej.
      </p>
      {!url && (
        <>
          {!syncReady && (
            <p className="notice">
              <Icon name="info" size={14} /> Nejdřív zapni synchronizaci s GitHubem (Nastavení → Synchronizace) – kalendář v telefonu používá stejný token.
            </p>
          )}
          <button className="btn primary" disabled={!syncReady || status.state === "busy"} onClick={() => void enable()}>
            {status.state === "busy" ? <Icon name="spinner" size={14} className="spin" /> : <Icon name="calendar" size={14} />} Zapnout kalendář v telefonu
          </button>
          <p className="muted small">
            Token potřebuje navíc oprávnění <b>Gists: Read and write</b> (na GitHubu u tokenu v části <i>Account permissions</i>).
          </p>
        </>
      )}
      {status.state === "error" && status.message && <p className="error-text small">{status.message}</p>}
      {url && (
        <div className="feed-box">
          <div className="feed-link">
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Odkaz na kalendář" />
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(url).then(() => toast("Odkaz zkopírován.", "ok"))}>
              <Icon name="copy" size={13} /> Kopírovat
            </button>
          </div>
          <p className="muted small">
            {status.at ? `Naposledy nahráno ${ago(status.at)}. ` : ""}Vimmi odkaz aktualizuje sama pár sekund po každé změně události.
          </p>
          <details className="cal-help" open>
            <summary>Jak ho přidat do telefonu</summary>
            <p>
              <b>iPhone:</b> otevři tuhle stránku na iPhonu a klepni na{" "}
              <a href={webcal} className="external">
                Přidat do kalendáře iPhonu
              </a>{" "}
              → <b>Odebírat</b>. Vypni přepínač <b>Odstranit upozornění</b>, jinak připomínky nepřijdou. Pro rychlejší aktualizace: Nastavení → Kalendář → Účty →
              Stahovat nová data → <b>Každých 15 minut</b>.
            </p>
            <p>
              <b>Android:</b> na počítači otevři <b>calendar.google.com</b> → vlevo <b>Ostatní kalendáře → + → Z adresy URL</b>, vlož odkaz a přidej. Google ho
              obnovuje jen několikrát denně a vlastní upozornění z odběru nepřebírá – nastav si je u toho kalendáře v Google Kalendáři.
            </p>
          </details>
          <button className="btn ghost danger-text" onClick={() => void disable()}>
            Vypnout kalendář v telefonu
          </button>
        </div>
      )}
    </>
  );
}

