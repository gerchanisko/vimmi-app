import { useEffect } from "react";
import { basename } from "../shared/markdown";
import { AiQuickPanel } from "./components/AiQuick";
import GraphView from "./components/GraphView";
import { Icon } from "./components/Icon";
import { MenuHost, openMenu } from "./components/Menu";
import NoteView from "./components/NoteView";
import { CommandPalette, DialogHost, Spotlight, TemplatePicker, Toasts } from "./components/Overlays";
import RightPanel from "./components/RightPanel";
import Settings from "./components/Settings";
import Sidebar from "./components/Sidebar";
import { ProjectsView, SearchView, TasksView, TodayView } from "./components/Views";
import Welcome, { enterVault } from "./components/Welcome";
import { newNote, toggleRight } from "./lib/actions";
import { isMobile, useMobile } from "./lib/mobile";
import { SyncIndicator } from "./components/Sync";
import { UpdateBanner } from "./components/Update";
import { handleShortcut } from "./lib/commands";
import { flushAll, reloadDoc } from "./lib/docs";
import { closeTab, getState, openNote, openView, refreshSnapshot, setState, useApp, type Tab } from "./lib/store";

const VIEW_TITLES: Record<string, [string, string]> = {
  today: ["Dnes", "today"],
  tasks: ["Úkoly", "task"],
  projects: ["Projekty", "project"],
  graph: ["Graf", "graph"],
  search: ["Hledat", "search"],
  tag: ["Tag", "hash"],
};

export default function App() {
  const ready = useApp((s) => s.ready);
  const snapshot = useApp((s) => s.snapshot);
  const overlay = useApp((s) => s.overlay);
  const theme = useApp((s) => s.settings?.theme ?? "system");

  // Boot: load settings and the last vault.
  useEffect(() => {
    void (async () => {
      const settings = await window.vimmi.settings.get();
      setState({ settings });
      const snap = await window.vimmi.vault.snapshot();
      if (snap) await enterVault(snap);
      setState({ ready: true });
    })();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme === "system" ? "" : theme;
  }, [theme]);

  // Keep the index fresh and open notes in sync with the disk.
  useEffect(() => {
    let timer: number | undefined;
    const offChanged = window.vimmi.vault.onChanged(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void refreshSnapshot(), 50);
    });
    const offNote = window.vimmi.vault.onNoteChanged(({ path }) => void reloadDoc(path));
    const offOpen = window.vimmi.vault.onOpenNote((path) => void refreshSnapshot().then(() => openNote(path, { newTab: true })));
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      if (!s.snapshot || s.dialog) return;
      if (e.key === "Escape" && !s.overlay && isMobile() && (s.leftOpen || s.right)) {
        setState({ leftOpen: false, right: null });
        return;
      }
      if (s.overlay && s.overlay.type !== "settings") return;
      handleShortcut(e);
    };
    const onUnload = () => void flushAll();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("blur", onUnload);
    return () => {
      offChanged();
      offNote();
      offOpen();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("blur", onUnload);
    };
  }, []);

  if (!ready) return <div className="boot" />;

  return (
    <>
      {snapshot ? <Workspace /> : <Welcome />}
      {overlay?.type === "spotlight" && <Spotlight initial={overlay.query} />}
      {overlay?.type === "commands" && <CommandPalette />}
      {overlay?.type === "template" && <TemplatePicker />}
      {overlay?.type === "settings" && <Settings initialTab={overlay.tab} />}
      <AiQuickPanel />
      {snapshot && <UpdateBanner />}
      <DialogHost />
      <MenuHost />
      <Toasts />
    </>
  );
}

function Workspace() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const leftOpen = useApp((s) => s.leftOpen);
  const right = useApp((s) => s.right);
  const mobile = useMobile();

  useEffect(() => {
    if (mobile) setState({ leftOpen: false });
  }, [mobile]);

  const content = (
    <div className="tab-content">
      {tabs.length === 0 && <EmptyState />}
      {tabs.map((t) => (
        <div key={t.id} className="tab-pane" hidden={t.id !== active}>
          <TabContent tab={t} active={t.id === active} />
        </div>
      ))}
    </div>
  );

  if (mobile) {
    const tab = tabs.find((t) => t.id === active);
    const title = tab ? (tab.kind === "note" ? basename(tab.path) : VIEW_TITLES[tab.view][0]) : "Vimmi";
    return (
      <div className="workspace mobile">
        <main className="main">
          <div className="mobile-top">
            <button className="icon-btn" onClick={() => setState({ leftOpen: true })} aria-label="Menu">
              <Icon name="menu" size={20} />
            </button>
            <button className="mobile-title" onClick={() => setState({ overlay: { type: "spotlight" } })}>
              {title}
            </button>
            <SyncIndicator compact />
          </div>
          {content}
          <nav className="bottom-bar" aria-label="Hlavní navigace">
            <button className={tab?.kind === "view" && tab.view === "today" ? "on" : ""} onClick={() => openView("today")}>
              <Icon name="today" size={22} />
              <span>Dnes</span>
            </button>
            <button className={tab?.kind === "view" && tab.view === "tasks" ? "on" : ""} onClick={() => openView("tasks")}>
              <Icon name="task" size={22} />
              <span>Úkoly</span>
            </button>
            <button className="bottom-new" onClick={() => void newNote()} aria-label="Nová poznámka">
              <Icon name="plus" size={24} />
            </button>
            <button onClick={() => setState({ overlay: { type: "spotlight" } })}>
              <Icon name="search" size={22} />
              <span>Hledat</span>
            </button>
            <button className={right === "ai" ? "on" : ""} onClick={() => toggleRight("ai")}>
              <Icon name="sparkle" size={22} />
              <span>AI</span>
            </button>
          </nav>
        </main>
        {leftOpen && (
          <>
            <button className="drawer-backdrop" aria-label="Zavřít menu" onClick={() => setState({ leftOpen: false })} />
            <div className="drawer">
              <Sidebar />
            </div>
          </>
        )}
        <RightPanel />
      </div>
    );
  }

  return (
    <div className={`workspace${leftOpen ? "" : " left-closed"}${right ? " right-open" : ""}`}>
      {leftOpen && <Sidebar />}
      <main className="main">
        <div className="tabbar" role="tablist">
          <button className="icon-btn" onClick={() => setState((s) => ({ leftOpen: !s.leftOpen }))} title="Levý panel (Ctrl+\)" aria-label="Levý panel">
            <Icon name="panel-left" />
          </button>
          <div className="tabs">
            {tabs.map((t) => (
              <TabButton key={t.id} tab={t} active={t.id === active} />
            ))}
            <button className="icon-btn small" onClick={() => setState({ overlay: { type: "spotlight" } })} title="Otevřít (Ctrl+K)" aria-label="Nová karta">
              <Icon name="plus" size={14} />
            </button>
          </div>
          <SyncIndicator compact />
          <button className={`btn ai-toggle${right === "ai" ? " on" : ""}`} onClick={() => toggleRight("ai")} title="AI asistent (Ctrl+J)">
            <Icon name="sparkle" /> AI
          </button>
          <button className="icon-btn" onClick={() => setState((s) => ({ right: s.right ? null : "links" }))} title="Pravý panel" aria-label="Pravý panel">
            <Icon name="panel-right" />
          </button>
        </div>
        {content}
      </main>
      <RightPanel />
    </div>
  );
}

function TabButton({ tab, active }: { tab: Tab; active: boolean }) {
  const [label, icon] = tab.kind === "note" ? [basename(tab.path), "note"] : VIEW_TITLES[tab.view];
  const title = tab.kind === "view" && tab.view === "search" && tab.arg ? `Hledat: ${tab.arg}` : label;
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`tab${active ? " active" : ""}`}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.id);
        } else setState({ active: tab.id });
      }}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: "Zavřít", icon: "close", action: () => closeTab(tab.id) },
          { label: "Zavřít ostatní", action: () => setState((s) => ({ tabs: s.tabs.filter((t) => t.id === tab.id), active: tab.id })) },
          { label: "Zavřít vše", action: () => setState({ tabs: [], active: null }) },
        ])
      }
      title={tab.kind === "note" ? tab.path : title}
    >
      <Icon name={icon} size={14} />
      <span className="tab-label">{title}</span>
      <button
        className="tab-close"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}
        aria-label="Zavřít kartu"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  if (tab.kind === "note") return <NoteView tabId={tab.id} path={tab.path} mode={tab.mode} active={active} />;
  switch (tab.view) {
    case "today":
      return <TodayView />;
    case "tasks":
      return <TasksView />;
    case "projects":
      return <ProjectsView />;
    case "graph":
      return active ? <GraphView focus={tab.arg} /> : null;
    case "search":
    case "tag":
      return <SearchView initial={tab.arg} />;
  }
}

function EmptyState() {
  return (
    <div className="empty-state">
      <p className="muted">Žádná otevřená poznámka.</p>
      <div className="empty-actions">
        <button className="btn" onClick={() => setState({ overlay: { type: "spotlight" } })}>
          <Icon name="search" /> Hledat <kbd>Ctrl K</kbd>
        </button>
        <button className="btn" onClick={() => openView("today")}>
          <Icon name="today" /> Dnes
        </button>
        <button className="btn" onClick={() => void newNote()}>
          <Icon name="pen" /> Nová poznámka <kbd>Ctrl N</kbd>
        </button>
      </div>
    </div>
  );
}
