// Context / dropdown menu rendered at a screen position.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";

export type MenuItem =
  | { label: string; icon?: string; action: () => void; danger?: boolean; shortcut?: string; disabled?: boolean }
  | { separator: true }
  | { heading: string };

let menu: { x: number; y: number; items: MenuItem[] } | null = null;
const listeners = new Set<() => void>();
const set = (m: typeof menu) => {
  menu = m;
  for (const l of listeners) l();
};

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void } | DOMRect, items: MenuItem[]) {
  if ("preventDefault" in e && e.preventDefault) e.preventDefault();
  const pos = "clientX" in e ? { x: e.clientX, y: e.clientY } : { x: e.left, y: e.bottom + 4 };
  set({ ...pos, items });
}

export function MenuHost() {
  const m = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => menu,
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [focus, setFocus] = useState(-1);

  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 8), y: Math.min(m.y, window.innerHeight - r.height - 8) });
    setFocus(-1);
  }, [m]);

  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      set(null);
    };
    const actionable = m.items.map((it, i) => ("action" in it && !it.disabled ? i : -1)).filter((i) => i >= 0);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") set(null);
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocus((f) => {
          const idx = actionable.indexOf(f);
          const next = e.key === "ArrowDown" ? actionable[(idx + 1) % actionable.length] : actionable[(idx - 1 + actionable.length) % actionable.length];
          return next ?? -1;
        });
      } else if (e.key === "Enter") {
        setFocus((f) => {
          const it = m.items[f];
          if (it && "action" in it) {
            set(null);
            it.action();
          }
          return f;
        });
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key, true);
    };
  }, [m]);

  if (!m) return null;
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {m.items.map((it, i) =>
        "separator" in it ? (
          <div key={i} className="menu-sep" />
        ) : "heading" in it ? (
          <div key={i} className="menu-heading">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${it.danger ? " danger" : ""}${focus === i ? " focus" : ""}`}
            disabled={it.disabled}
            onMouseEnter={() => setFocus(i)}
            onClick={() => {
              set(null);
              it.action();
            }}
          >
            {it.icon ? <Icon name={it.icon} /> : <span className="icon-space" />}
            <span>{it.label}</span>
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
