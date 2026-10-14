// Sync status indicator and the "Synchronizace" settings panel.
import { useEffect, useState } from "react";
import type { Settings, SyncStatus } from "../../shared/types";
import { errorText, setState, toast } from "../lib/store";
import { Icon } from "./Icon";

function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>({ state: "off" });
  useEffect(() => {
    void window.vimmi.sync.status().then(setStatus);
    return window.vimmi.sync.onStatus(setStatus);
  }, []);
  return status;
}

function ago(ts?: number): string {
  if (!ts) return "zatím nikdy";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "právě teď";
  if (s < 60) return `před ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `před ${m} min`;
  return new Date(ts).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" });
}

/** Small cloud icon showing sync state; click syncs now. Hidden when sync is off. */
export function SyncIndicator({ compact }: { compact?: boolean }) {
  const status = useSyncStatus();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (status.lastChange?.conflicts.length && Date.now() - status.lastChange.at < 5000) {
      toast(`Konflikt při synchronizaci – druhá verze je uložená jako „${status.lastChange.conflicts[0].replace(/\.md$/, "")}“.`, "error");
    }
  }, [status.lastChange]);
  if (status.state === "off") return null;
  const label =
    status.state === "syncing" ? "Synchronizuji…" : status.state === "error" ? `Synchronizace selhala: ${status.message}` : `Synchronizováno ${ago(status.lastSync)}`;
  return (
    <button
      className={`sync-indicator state-${status.state}${compact ? " compact" : ""}`}
      onClick={() => {
        if (status.state === "error") setState({ overlay: { type: "settings", tab: "sync" } });
        else void window.vimmi.sync.now();
      }}
      title={label}
      aria-label={label}
    >
      <Icon name={status.state === "error" ? "cloud-off" : status.state === "syncing" ? "sync" : "cloud"} size={16} className={status.state === "syncing" ? "spin" : ""} />
      {!compact && <span>{label}</span>}
    </button>
  );
}

export function SyncSettingsPanel({ settings }: { settings: Settings }) {
  const status = useSyncStatus();
  const web = window.vimmi.app.kind === "web";
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState(settings.sync.owner ? `${settings.sync.owner}/${settings.sync.repo}` : "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const sync = settings.sync;

  const refresh = async () => setState({ settings: { ...settings, ...(await window.vimmi.settings.get()) } });

  const saveToken = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      await window.vimmi.sync.setToken(token.trim());
      const login = await window.vimmi.sync.user();
      if (!repo) setRepo(`${login}/vimmi-poznamky`);
      setToken("");
      setMessage({ ok: true, text: `Token funguje – přihlášen jako ${login}.` });
      await refresh();
    } catch (err) {
      await window.vimmi.sync.setToken(null);
      setMessage({ ok: false, text: errorText(err) });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const parseRepo = (): { owner: string; repo: string } | null => {
    const m = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").match(/^([\w.-]+)\/([\w.-]+)$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  };

  const enable = async () => {
    const r = parseRepo();
    if (!r) {
      setMessage({ ok: false, text: "Zadej repozitář ve tvaru uživatel/název, např. jana/vimmi-poznamky." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await window.vimmi.sync.configure({ enabled: true, owner: r.owner, repo: r.repo });
      await refresh();
      const st = await window.vimmi.sync.now();
      if (st.state === "error") setMessage({ ok: false, text: st.message ?? "Synchronizace selhala." });
      else {
        setMessage({ ok: true, text: "Synchronizace je zapnutá." });
        // Pulled notes appear in the sidebar.
        setState({ snapshot: await window.vimmi.vault.snapshot() });
      }
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const createRepo = async () => {
    const name = parseRepo()?.repo ?? "vimmi-poznamky";
    setBusy(true);
    setMessage(null);
    try {
      const r = await window.vimmi.sync.createRepo(name);
      setRepo(`${r.owner}/${r.repo}`);
      setMessage({ ok: true, text: `Soukromý repozitář ${r.owner}/${r.repo} je vytvořený. Teď zapni synchronizaci.` });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    await window.vimmi.sync.configure({ enabled: false });
    await refresh();
  };

  const removeToken = async () => {
    await window.vimmi.sync.configure({ enabled: false });
    await window.vimmi.sync.setToken(null);
    await refresh();
  };

  const open = (url: string) => void window.vimmi.app.openExternal(url);

  return (
    <>
      <h3>Synchronizace</h3>
      <p className="muted">
        Poznámky se synchronizují přes <strong>soukromý repozitář na tvém GitHubu</strong> – mezi počítačem, telefonem i dalšími zařízeními. Zdarma, s celou
        historií změn a bez dalšího účtu. Když stejnou poznámku upravíš na dvou místech najednou, nic se neztratí: druhá verze se uloží vedle jako „konflikt“.
      </p>

      {sync.enabled && settings.hasSyncToken ? (
        <div className="sync-card">
          <div className="sync-card-head">
            <Icon name={status.state === "error" ? "cloud-off" : "cloud"} size={20} />
            <div>
              <strong>
                {sync.owner}/{sync.repo}
              </strong>
              <span className="muted small">
                {status.state === "syncing" ? "Synchronizuji…" : status.state === "error" ? "Chyba synchronizace" : `Synchronizováno ${ago(status.lastSync)}`}
              </span>
            </div>
          </div>
          {status.state === "error" && <p className="error-text">{status.message}</p>}
          {status.lastChange && (
            <p className="muted small">
              Poslední změny: staženo {status.lastChange.pulled}, odesláno {status.lastChange.pushed}
              {status.lastChange.deleted ? `, smazáno ${status.lastChange.deleted}` : ""}
              {status.lastChange.conflicts.length ? `, konflikty ${status.lastChange.conflicts.length}` : ""}.
            </p>
          )}
          <div className="row-actions">
            <button className="btn primary" onClick={() => void window.vimmi.sync.now()} disabled={status.state === "syncing"}>
              <Icon name="sync" size={14} /> Synchronizovat teď
            </button>
            <button className="btn" onClick={() => open(`https://github.com/${sync.owner}/${sync.repo}/commits`)}>
              Historie změn <Icon name="external" size={13} />
            </button>
            <button className="btn ghost" onClick={() => void disable()}>
              Vypnout
            </button>
          </div>
          <p className="muted small">Synchronizuje se automaticky: při spuštění, chvíli po úpravě, každou minutu a při návratu do aplikace.</p>
        </div>
      ) : (
        <ol className="sync-steps">
          <li>
            <strong>Vytvoř soukromý repozitář</strong> na GitHubu, třeba <code>vimmi-poznamky</code>.
            <div className="row-actions">
              <button className="btn" onClick={() => open("https://github.com/new?name=vimmi-poznamky&visibility=private&description=Pozn%C3%A1mky%20z%20Vimmi")}>
                Vytvořit repozitář <Icon name="external" size={13} />
              </button>
            </div>
          </li>
          <li>
            <strong>Vytvoř token</strong> s přístupem jen k tomuto repozitáři: <em>Repository access → Only select repositories</em> a v oprávněních{" "}
            <em>Contents → Read and write</em>.
            <div className="row-actions">
              <button className="btn" onClick={() => open("https://github.com/settings/personal-access-tokens/new")}>
                Vytvořit token <Icon name="external" size={13} />
              </button>
            </div>
          </li>
          <li>
            <strong>Vlož token</strong>
            {settings.hasSyncToken ? (
              <div className="row-actions">
                <span className="pill ok">
                  <Icon name="ok" size={13} /> Token je uložen
                </span>
                <button className="btn ghost" onClick={() => void removeToken()}>
                  Odebrat
                </button>
              </div>
            ) : (
              <form
                className="row-actions"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveToken();
                }}
              >
                <input type="password" className="key-input" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
                <button className="btn primary" type="submit" disabled={!token.trim() || busy}>
                  Uložit
                </button>
              </form>
            )}
          </li>
          <li>
            <strong>Zapni synchronizaci</strong>
            <div className="row-actions">
              <input className="key-input" placeholder="uživatel/vimmi-poznamky" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Repozitář" />
              <button className="btn primary" onClick={() => void enable()} disabled={!settings.hasSyncToken || busy}>
                {busy ? "Pracuji…" : "Zapnout"}
              </button>
              {settings.hasSyncToken && (
                <button className="btn ghost" onClick={() => void createRepo()} disabled={busy} title="Funguje s tokenem, který smí zakládat repozitáře">
                  Založit repozitář za mě
                </button>
              )}
            </div>
          </li>
        </ol>
      )}
      {message && <p className={message.ok ? "ok-text" : "error-text"}>{message.text}</p>}
      <p className="muted small">
        {web
          ? "Token se ukládá v prohlížeči tohoto zařízení. Na každém zařízení stačí vložit token a stejný repozitář."
          : "Token se ukládá zašifrovaně v systémové klíčence. Na telefonu otevři webovou verzi Vimmi a připoj stejný repozitář."}
      </p>
    </>
  );
}
