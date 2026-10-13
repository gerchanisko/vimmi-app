import { errorText, openNote, openView, restoreLayout, setState, toast, useApp } from "../lib/store";
import type { VaultSnapshot } from "../../shared/types";
import { Icon, Logo } from "./Icon";

export async function enterVault(snapshot: VaultSnapshot | null): Promise<void> {
  if (!snapshot) return;
  const settings = await window.vimmi.settings.get();
  const layout = restoreLayout(snapshot);
  setState({ snapshot, settings, ...layout });
  if (!layout.tabs?.length) {
    const welcome = snapshot.notes.find((n) => n.path === "Vítej ve Vimmi.md");
    if (welcome) openNote(welcome.path);
    else openView("today");
  }
}

export default function Welcome() {
  const recent = useApp((s) => s.settings?.recentVaults ?? []);
  const run = async (fn: () => Promise<VaultSnapshot | null>) => {
    try {
      await enterVault(await fn());
    } catch (err) {
      toast(errorText(err), "error");
    }
  };
  return (
    <div className="welcome">
      <div className="welcome-card">
        <Logo size={44} />
        <h1>Vimmi</h1>
        <p className="lead">Všechno důležité. Na jednom místě.</p>
        <p className="muted">
          Poznámky, úkoly a projekty jako obyčejné soubory Markdown ve složce, kterou máš pod kontrolou. S AI asistentem Claude, který s tvým svolením pomáhá.
        </p>
        <div className="welcome-actions">
          <button className="btn primary big" onClick={() => void run(window.vimmi.vault.createSample)}>
            <Icon name="plus" /> Vytvořit nový trezor
          </button>
          <button className="btn big" onClick={() => void run(window.vimmi.vault.pick)}>
            <Icon name="folder-open" /> Otevřít složku…
          </button>
        </div>
        <p className="muted small">Funguje i s existujícím trezorem z Obsidianu.</p>
        {recent.length > 0 && (
          <div className="recent">
            <h4>Nedávné trezory</h4>
            {recent.map((r) => (
              <button key={r} className="recent-item" onClick={() => void run(() => window.vimmi.vault.open(r))}>
                <Icon name="folder" /> <span>{r.split(/[\\/]/).pop()}</span> <span className="muted small">{r}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
