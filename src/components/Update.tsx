// Update banner (new version ready) and the update section in Settings → O aplikaci.
import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../shared/types";
import { Icon } from "./Icon";

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void window.vimmi.update.status().then(setStatus);
    return window.vimmi.update.onStatus(setStatus);
  }, []);
  return status;
}

/** Small card in the corner when an update is being installed or is ready. */
export function UpdateBanner() {
  const status = useUpdateStatus();
  const [hidden, setHidden] = useState<string | null>(null);
  if (!status) return null;
  const key = `${status.state}-${status.version}`;
  if (hidden === key) return null;
  const web = status.method === "reload";

  if (status.state === "ready") {
    return (
      <div className="update-banner" role="status">
        <Icon name="sparkle" size={16} />
        <span>
          {web ? "Je k dispozici nová verze Vimmi." : `Vimmi ${status.version ?? ""} je připravené.`}
          <span className="muted small">{web ? " Načte se při příštím návratu do aplikace." : " Nainstaluje se po restartu."}</span>
        </span>
        <button className="btn primary small" onClick={() => void window.vimmi.update.restart()}>
          {web ? "Obnovit" : "Restartovat"}
        </button>
        <button className="icon-btn small" aria-label="Později" title="Později" onClick={() => setHidden(key)}>
          <Icon name="close" size={14} />
        </button>
      </div>
    );
  }
  if (status.state === "installing" || (status.state === "downloading" && !web)) {
    return (
      <div className="update-banner quiet" role="status">
        <Icon name="sync" size={14} className="spin" />
        <span className="small">
          {status.state === "installing" ? `Instaluji aktualizaci ${status.version ?? ""}…` : `Stahuji aktualizaci ${status.version ?? ""} (${status.progress ?? 0} %)…`}
        </span>
      </div>
    );
  }
  return null;
}

/** Settings → O aplikaci: version, update check, automatic updates. */
export function UpdateSettings({ autoUpdate, onToggle }: { autoUpdate: boolean; onToggle: (v: boolean) => void }) {
  const status = useUpdateStatus();
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const text: Record<UpdateStatus["state"], string> = {
    idle: "",
    checking: "Hledám novou verzi…",
    latest: "Máš nejnovější verzi.",
    available: `Je k dispozici verze ${status.version}.`,
    downloading: `Stahuji verzi ${status.version} (${status.progress ?? 0} %)…`,
    installing: `Instaluji verzi ${status.version}…`,
    ready: status.method === "reload" ? "Nová verze je připravená." : `Verze ${status.version} je připravená – stačí restartovat.`,
    error: status.message ?? "Kontrola aktualizací selhala.",
  };
  return (
    <div className="update-settings">
      <div className="row-actions">
        {status.state === "ready" ? (
          <button className="btn primary" onClick={() => void window.vimmi.update.restart()}>
            <Icon name="sync" size={14} /> {status.method === "reload" ? "Obnovit" : "Restartovat a aktualizovat"}
          </button>
        ) : status.state === "available" && !autoUpdate ? (
          <button className="btn primary" onClick={() => void window.vimmi.update.install()}>
            Aktualizovat
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy || status.method === "none" || ["checking", "downloading", "installing"].includes(status.state)}
            onClick={async () => {
              setBusy(true);
              await window.vimmi.update.check();
              setBusy(false);
            }}
          >
            <Icon name="sync" size={14} /> Zkontrolovat aktualizace
          </button>
        )}
      </div>
      {text[status.state] && <p className={`small ${status.state === "error" ? "error-text" : "muted"}`}>{text[status.state]}</p>}
      {status.method === "none" && <p className="muted small">Vývojová verze se neaktualizuje automaticky.</p>}
      <label className="check update-toggle">
        <input type="checkbox" checked={autoUpdate} onChange={(e) => onToggle(e.target.checked)} /> Instalovat aktualizace automaticky
      </label>
    </div>
  );
}
