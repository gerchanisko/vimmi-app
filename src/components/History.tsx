// Version history of a note: versions kept on this device and, with sync on, on GitHub.
import { useEffect, useMemo, useState } from "react";
import type { NoteVersion } from "../../shared/history";
import { basename } from "../../shared/markdown";
import { loadDoc, reloadDoc, saveDoc } from "../lib/docs";
import { useMobile } from "../lib/mobile";
import { confirm, errorText, refreshSnapshot, setState, toast, useApp } from "../lib/store";
import { DiffView } from "./AiChat";
import { Icon } from "./Icon";

const SOURCE_LABEL: Record<NoteVersion["source"], string> = {
  edit: "Tvoje úpravy",
  ai: "Před úpravou od AI",
  sync: "Před změnou z jiného zařízení",
  disk: "Před změnou mimo Vimmi",
  trash: "Před smazáním",
  restore: "Před obnovením starší verze",
  github: "Uloženo na GitHubu",
};

function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const time = d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Dnes ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Včera ${time}`;
  return `${d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })} ${time}`;
}

export default function HistoryDialog({ path }: { path: string }) {
  const mobile = useMobile();
  const syncOn = useApp((s) => Boolean(s.settings?.sync.enabled && s.settings?.hasSyncToken));
  const [local, setLocal] = useState<NoteVersion[] | null>(null);
  const [remote, setRemote] = useState<NoteVersion[] | null>(syncOn ? null : []);
  const [remoteError, setRemoteError] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<NoteVersion | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => setState({ overlay: null });

  useEffect(() => {
    void (async () => {
      await saveDoc(path); // the current text includes the latest typing
      setCurrent(await loadDoc(path));
      setLocal(await window.vimmi.vault.versions(path).catch(() => []));
    })();
    if (syncOn) {
      window.vimmi.sync
        .history(path)
        .then(setRemote)
        .catch((err) => {
          setRemote([]);
          setRemoteError(errorText(err));
        });
    }
  }, [path, syncOn]);

  const versions = useMemo(() => [...(local ?? []), ...(remote ?? [])].sort((a, b) => b.at - a.at), [local, remote]);

  useEffect(() => {
    if (!mobile && !selected && versions.length) setSelected(versions[0]);
  }, [versions, selected, mobile]);

  useEffect(() => {
    if (!selected) return;
    setText(null);
    setLoadingText(true);
    const read = selected.source === "github" ? window.vimmi.sync.version(path, selected.id) : window.vimmi.vault.version(path, selected.id);
    read
      .then((t) => setText(t ?? ""))
      .catch((err) => {
        toast(errorText(err), "error");
        setText("");
      })
      .finally(() => setLoadingText(false));
  }, [selected, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const restore = async () => {
    if (text === null || !selected) return;
    if (!(await confirm("Obnovit tuto verzi?", "Současný text se uloží do historie, takže se k němu můžeš vrátit.", "Obnovit"))) return;
    setBusy(true);
    try {
      await saveDoc(path);
      await window.vimmi.vault.restore(path, text);
      await reloadDoc(path);
      await refreshSnapshot();
      toast(`Obnovena verze: ${when(selected.at)}.`, "ok");
      close();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const loading = local === null || remote === null;
  const same = text !== null && current !== null && text === current;
  const showList = !mobile || !selected;
  const showDetail = !mobile || selected;

  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="history" role="dialog" aria-label={`Historie verzí: ${basename(path)}`}>
        {showList && (
          <aside className="history-list">
            <div className="history-head">
              <h2>Historie verzí</h2>
              {mobile && (
                <button className="icon-btn" onClick={close} aria-label="Zavřít">
                  <Icon name="close" />
                </button>
              )}
            </div>
            <p className="muted small history-note">{basename(path)}</p>
            {versions.map((v) => (
              <button key={`${v.source}:${v.id}`} className={`history-item${selected === v ? " on" : ""}`} onClick={() => setSelected(v)}>
                <strong>{when(v.at)}</strong>
                <span className="muted small">
                  {v.source === "github" ? <Icon name="cloud" size={12} /> : <Icon name="history" size={12} />} {SOURCE_LABEL[v.source]}
                  {v.device ? ` · ${v.device}` : ""}
                </span>
              </button>
            ))}
            {loading && (
              <p className="muted small history-note">
                <Icon name="spinner" size={12} className="spin" /> Načítám{syncOn ? " i z GitHubu" : ""}…
              </p>
            )}
            {!loading && versions.length === 0 && (
              <p className="muted small history-note">
                Zatím žádné starší verze. Vimmi si je ukládá při psaní (nejvýš jednou za 10 minut), před každou úpravou od AI, před synchronizací a před smazáním.
              </p>
            )}
            {remoteError && <p className="error-text small history-note">GitHub: {remoteError}</p>}
            {!syncOn && !loading && (
              <p className="muted small history-note">Se zapnutou synchronizací uvidíš i dlouhodobou historii z GitHubu.</p>
            )}
          </aside>
        )}
        {showDetail && (
          <section className="history-detail">
            <div className="history-head">
              {mobile && (
                <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Zpět na seznam">
                  <Icon name="chevron-right" className="flip" />
                </button>
              )}
              <h3>{selected ? `${when(selected.at)} · ${SOURCE_LABEL[selected.source]}` : "Vyber verzi"}</h3>
              <span className="grow" />
              <div className="segmented" role="tablist">
                <button role="tab" aria-selected={!full} className={!full ? "on" : ""} onClick={() => setFull(false)}>
                  Změny
                </button>
                <button role="tab" aria-selected={full} className={full ? "on" : ""} onClick={() => setFull(true)}>
                  Celý text
                </button>
              </div>
              {!mobile && (
                <button className="icon-btn" onClick={close} aria-label="Zavřít">
                  <Icon name="close" />
                </button>
              )}
            </div>
            <div className="history-body">
              {loadingText || text === null || current === null ? (
                selected && (
                  <p className="muted">
                    <Icon name="spinner" size={14} className="spin" /> Načítám verzi…
                  </p>
                )
              ) : same ? (
                <p className="muted">Tahle verze je stejná jako současný text.</p>
              ) : full ? (
                <pre className="history-text">{text}</pre>
              ) : (
                <>
                  <p className="muted small">
                    Co se od té doby změnilo: <span className="legend del">červeně</span> to, co z poznámky zmizelo, <span className="legend add">zeleně</span> to, co přibylo.
                  </p>
                  <DiffView before={text} after={current} />
                </>
              )}
            </div>
            <div className="history-actions">
              <button className="btn" onClick={close}>
                Zavřít
              </button>
              <button className="btn primary" disabled={!selected || text === null || same || busy} onClick={() => void restore()}>
                <Icon name="history" size={14} /> Obnovit tuto verzi
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
