import { useMemo, useState } from "react";
import { basename, dirname, isoDate } from "../../shared/markdown";
import type { NoteMeta } from "../../shared/types";
import { movePath, newFolder, newNote, openDaily, renamePath, switchVault, toggleBookmark, trashPath } from "../lib/actions";
import { activeNotePath, openNote, openView, setState, useApp } from "../lib/store";
import { Icon, Logo } from "./Icon";
import { openMenu } from "./Menu";
import { SyncIndicator } from "./Sync";
import { isMobile } from "../lib/mobile";

/** On a phone, choosing something in the drawer closes it. */
const closeDrawer = () => (isMobile() ? { leftOpen: false } : {});

interface TreeNode {
  name: string;
  path: string;
  folders: TreeNode[];
  notes: NoteMeta[];
}

function buildTree(folders: string[], notes: NoteMeta[]): TreeNode {
  const root: TreeNode = { name: "", path: "", folders: [], notes: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  const ensure = (p: string): TreeNode => {
    if (byPath.has(p)) return byPath.get(p)!;
    const parent = ensure(dirname(p));
    const node: TreeNode = { name: p.split("/").pop()!, path: p, folders: [], notes: [] };
    parent.folders.push(node);
    byPath.set(p, node);
    return node;
  };
  for (const f of folders) ensure(f);
  for (const n of notes) ensure(n.folder).notes.push(n);
  const sort = (node: TreeNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, "cs"));
    node.notes.sort((a, b) => a.title.localeCompare(b.title, "cs", { numeric: true }));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("vimmi:collapsed") ?? "[]"));
  } catch {
    return new Set();
  }
}

export default function Sidebar() {
  const snapshot = useApp((s) => s.snapshot)!;
  const bookmarks = useApp((s) => s.bookmarks);
  const active = useApp(() => activeNotePath());
  const activeView = useApp((s) => {
    const t = s.tabs.find((x) => x.id === s.active);
    return t?.kind === "view" ? t.view : null;
  });
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [sections, setSections] = useState({ bookmarks: true, files: true, tags: true });
  const [dragOver, setDragOver] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(snapshot.folders, snapshot.notes), [snapshot]);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of snapshot.notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "cs"));
  }, [snapshot]);
  const openToday = snapshot.notes.reduce((n, m) => n + m.tasks.filter((t) => !t.done && t.due && t.due <= isoDate()).length, 0);

  const toggle = (p: string) => {
    const next = new Set(collapsed);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setCollapsed(next);
    try {
      localStorage.setItem("vimmi:collapsed", JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };

  const folderMenu = (e: React.MouseEvent, path: string) =>
    openMenu(e, [
      { label: "Nová poznámka", icon: "plus", action: () => void newNote(path) },
      { label: "Nová složka", icon: "folder-plus", action: () => void newFolder(path) },
      ...(path
        ? [
            { label: "Přejmenovat…", icon: "rename", action: () => void renamePath(path, true) },
            { label: "Ukázat ve správci souborů", icon: "folder-open", action: () => void window.vimmi.vault.reveal(path) },
            { separator: true as const },
            { label: "Přesunout do koše", icon: "trash", danger: true, action: () => void trashPath(path, true) },
          ]
        : []),
    ]);

  const noteMenu = (e: React.MouseEvent, path: string) =>
    openMenu(e, [
      { label: "Otevřít v nové kartě", icon: "plus", action: () => openNote(path, { newTab: true }) },
      { label: bookmarks.includes(path) ? "Odebrat ze záložek" : "Přidat do záložek", icon: "star", action: () => toggleBookmark(path) },
      { label: "Přejmenovat…", icon: "rename", action: () => void renamePath(path) },
      { label: "Ukázat ve správci souborů", icon: "folder-open", action: () => void window.vimmi.vault.reveal(path) },
      { separator: true },
      { label: "Přesunout do koše", icon: "trash", danger: true, action: () => void trashPath(path) },
    ]);

  const dropProps = (folder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("text/x-vimmi-path")) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(folder);
    },
    onDragLeave: () => setDragOver((d) => (d === folder ? null : d)),
    onDrop: (e: React.DragEvent) => {
      const p = e.dataTransfer.getData("text/x-vimmi-path");
      setDragOver(null);
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      if (folder === p || folder.startsWith(p + "/")) return;
      void movePath(p, folder);
    },
  });

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => (
    <>
      {node.folders.map((f) => {
        const open = !collapsed.has(f.path);
        return (
          <div key={f.path} className={dragOver === f.path ? "drop-target" : undefined} {...dropProps(f.path)}>
            <button
              className="tree-item folder"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => toggle(f.path)}
              onContextMenu={(e) => folderMenu(e, f.path)}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/x-vimmi-path", f.path)}
              aria-expanded={open}
            >
              <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
              <span className="tree-label">{f.name}</span>
            </button>
            {open && renderNode(f, depth + 1)}
          </div>
        );
      })}
      {node.notes.map((n) => (
        <button
          key={n.path}
          className={`tree-item${n.path === active ? " active" : ""}`}
          style={{ paddingLeft: 22 + depth * 14 }}
          onClick={(e) => openNote(n.path, { newTab: e.ctrlKey || e.metaKey || e.button === 1 })}
          onAuxClick={(e) => e.button === 1 && openNote(n.path, { newTab: true })}
          onContextMenu={(e) => noteMenu(e, n.path)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/x-vimmi-path", n.path);
            e.dataTransfer.setData("text/plain", `[[${n.title}]]`);
          }}
          title={n.path}
        >
          <span className="tree-label">{n.title}</span>
          {(n.type === "project" || n.type === "projekt") && <Icon name="project" size={13} className="muted" />}
        </button>
      ))}
    </>
  );

  return (
    <aside className="sidebar">
      <div className="vault-head">
        <button
          className="vault-name"
          onClick={(e) =>
            openMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), [
              { heading: snapshot.root },
              { label: "Otevřít jiný trezor…", icon: "folder-open", action: () => void switchVault() },
              { label: "Ukázat ve správci souborů", icon: "external", action: () => void window.vimmi.vault.reveal("") },
            ])
          }
          title={snapshot.root}
        >
          <Logo size={18} />
          <span>{snapshot.name}</span>
          <Icon name="chevron-down" size={14} />
        </button>
        <button className="icon-btn" onClick={() => void newNote()} title="Nová poznámka (Ctrl+N)" aria-label="Nová poznámka">
          <Icon name="pen" />
        </button>
      </div>

      <nav className="side-nav">
        <button className="nav-item" onClick={() => setState({ overlay: { type: "spotlight" }, ...closeDrawer() })}>
          <Icon name="search" /> Hledat <kbd>Ctrl K</kbd>
        </button>
        <button className={`nav-item${activeView === "today" ? " active" : ""}`} onClick={() => openView("today")}>
          <Icon name="today" /> Dnes {openToday > 0 && <span className="count">{openToday}</span>}
        </button>
        <button className={`nav-item${activeView === "tasks" ? " active" : ""}`} onClick={() => openView("tasks")}>
          <Icon name="task" /> Úkoly
        </button>
        <button className={`nav-item${activeView === "projects" ? " active" : ""}`} onClick={() => openView("projects")}>
          <Icon name="project" /> Projekty
        </button>
        <button className={`nav-item${activeView === "graph" ? " active" : ""}`} onClick={() => openView("graph")}>
          <Icon name="graph" /> Graf
        </button>
        <button className="nav-item" onClick={() => void openDaily()}>
          <Icon name="calendar" /> Deník <kbd>Ctrl D</kbd>
        </button>
      </nav>

      <div className="side-scroll">
        {bookmarks.length > 0 && (
          <section>
            <button className="side-section" onClick={() => setSections((s) => ({ ...s, bookmarks: !s.bookmarks }))}>
              <Icon name={sections.bookmarks ? "chevron-down" : "chevron-right"} size={12} /> Záložky
            </button>
            {sections.bookmarks &&
              bookmarks.map((b) => (
                <button key={b} className={`tree-item${b === active ? " active" : ""}`} style={{ paddingLeft: 22 }} onClick={() => openNote(b)} onContextMenu={(e) => noteMenu(e, b)}>
                  <Icon name="star" size={13} className="filled" />
                  <span className="tree-label">{basename(b)}</span>
                </button>
              ))}
          </section>
        )}

        <section className={dragOver === "" ? "drop-target" : undefined} {...dropProps("")}>
          <div className="side-section-row">
            <button className="side-section" onClick={() => setSections((s) => ({ ...s, files: !s.files }))} onContextMenu={(e) => folderMenu(e, "")}>
              <Icon name={sections.files ? "chevron-down" : "chevron-right"} size={12} /> Poznámky
            </button>
            <button className="icon-btn small" title="Nová složka" aria-label="Nová složka" onClick={() => void newFolder("")}>
              <Icon name="folder-plus" size={14} />
            </button>
          </div>
          {sections.files && (snapshot.notes.length || snapshot.folders.length ? renderNode(tree, 0) : <p className="muted pad">Zatím žádné poznámky.</p>)}
        </section>

        {tags.length > 0 && (
          <section>
            <button className="side-section" onClick={() => setSections((s) => ({ ...s, tags: !s.tags }))}>
              <Icon name={sections.tags ? "chevron-down" : "chevron-right"} size={12} /> Tagy
            </button>
            {sections.tags && (
              <div className="tag-cloud">
                {tags.map(([t, c]) => (
                  <button key={t} className="tag-chip" onClick={() => openView("search", "#" + t)}>
                    #{t} <span className="muted">{c}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      <div className="side-foot">
        <SyncIndicator />
        <button className="nav-item" onClick={() => setState({ overlay: { type: "settings" }, ...closeDrawer() })}>
          <Icon name="settings" /> Nastavení
        </button>
      </div>
    </aside>
  );
}
