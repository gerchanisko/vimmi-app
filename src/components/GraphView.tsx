// Force-directed graph of notes and their links, drawn on a canvas.
import { useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { basename } from "../../shared/markdown";
import { activeNotePath, openNote, useApp } from "../lib/store";
import { Icon } from "./Icon";

interface GNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: "note" | "tag" | "missing" | "project";
  degree: number;
}
type GLink = SimulationLinkDatum<GNode>;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

export default function GraphView({ focus }: { focus?: string }) {
  const notes = useApp((s) => s.snapshot?.notes ?? []);
  const current = useApp(() => activeNotePath());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [showTags, setShowTags] = useState(false);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showMissing, setShowMissing] = useState(false);
  const [local, setLocal] = useState<string | null>(focus ?? null);
  const [depth, setDepth] = useState(1);
  const [filter, setFilter] = useState("");

  useEffect(() => setLocal(focus ?? null), [focus]);

  const data = useMemo(() => {
    const nodes = new Map<string, GNode>();
    const links: { source: string; target: string }[] = [];
    for (const n of notes) {
      nodes.set(n.path, { id: n.path, label: n.title, kind: n.type === "project" || n.type === "projekt" ? "project" : "note", degree: 0 });
    }
    for (const n of notes) {
      for (const l of n.links) {
        if (l.resolved) {
          if (l.resolved !== n.path) links.push({ source: n.path, target: l.resolved });
        } else if (showMissing) {
          const id = `missing:${l.target.toLowerCase()}`;
          if (!nodes.has(id)) nodes.set(id, { id, label: l.target, kind: "missing", degree: 0 });
          links.push({ source: n.path, target: id });
        }
      }
      if (showTags) {
        for (const t of n.tags) {
          const id = `tag:${t}`;
          if (!nodes.has(id)) nodes.set(id, { id, label: `#${t}`, kind: "tag", degree: 0 });
          links.push({ source: n.path, target: id });
        }
      }
    }
    // De-duplicate links.
    const seen = new Set<string>();
    const unique = links.filter((l) => {
      const k = [l.source, l.target].sort().join("→");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    for (const l of unique) {
      nodes.get(l.source)!.degree++;
      nodes.get(l.target)!.degree++;
    }
    let keep = new Set(nodes.keys());
    if (local && nodes.has(local)) {
      keep = new Set([local]);
      for (let d = 0; d < depth; d++) {
        for (const l of unique) {
          if (keep.has(l.source)) keep.add(l.target);
          else if (keep.has(l.target)) keep.add(l.source);
        }
      }
    }
    if (!showOrphans && !local) for (const [id, n] of nodes) if (n.degree === 0) keep.delete(id);
    if (filter.trim()) {
      const f = filter.toLowerCase();
      for (const [id, n] of nodes) if (!n.label.toLowerCase().includes(f) && !id.toLowerCase().includes(f)) keep.delete(id);
    }
    return {
      nodes: [...nodes.values()].filter((n) => keep.has(n.id)),
      links: unique.filter((l) => keep.has(l.source) && keep.has(l.target)),
    };
  }, [notes, showTags, showOrphans, showMissing, local, depth, filter]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    let width = wrap.clientWidth;
    let height = wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    let transform = { x: width / 2, y: height / 2, k: 1 };
    let hover: GNode | null = null;
    let drag: GNode | null = null;
    let panning: { x: number; y: number } | null = null;
    let moved = false;

    const nodes: GNode[] = data.nodes.map((n) => ({ ...n }));
    const links: GLink[] = data.links.map((l) => ({ source: l.source, target: l.target }));
    const neighbors = new Map<string, Set<string>>();
    for (const l of data.links) {
      if (!neighbors.has(l.source)) neighbors.set(l.source, new Set());
      if (!neighbors.has(l.target)) neighbors.set(l.target, new Set());
      neighbors.get(l.source)!.add(l.target);
      neighbors.get(l.target)!.add(l.source);
    }

    const colors = {
      note: cssVar("--text-2"),
      project: cssVar("--accent"),
      tag: cssVar("--sage"),
      missing: cssVar("--border-strong"),
      link: cssVar("--border-strong"),
      text: cssVar("--text"),
      accent: cssVar("--accent"),
      bg: cssVar("--bg"),
    };

    const resize = () => {
      width = wrap.clientWidth;
      height = wrap.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      draw();
    };

    const radius = (n: GNode) => (n.kind === "tag" ? 3.5 : 4 + Math.sqrt(n.degree) * 1.8);

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);
      const hl = hover ? neighbors.get(hover.id) : null;
      ctx.lineWidth = 1 / transform.k;
      for (const l of links) {
        const s = l.source as GNode;
        const t = l.target as GNode;
        const active = hover && (s.id === hover.id || t.id === hover.id);
        ctx.strokeStyle = active ? colors.accent : colors.link;
        ctx.globalAlpha = hover && !active ? 0.15 : active ? 0.9 : 0.5;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
        ctx.stroke();
      }
      for (const n of nodes) {
        const dim = hover && n.id !== hover.id && !hl?.has(n.id);
        ctx.globalAlpha = dim ? 0.2 : 1;
        ctx.fillStyle = n.id === current || n.id === hover?.id ? colors.accent : colors[n.kind];
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2);
        ctx.fill();
      }
      const showLabels = transform.k > 0.7 || nodes.length < 60;
      ctx.font = `${12 / Math.max(transform.k, 0.6)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      for (const n of nodes) {
        const isHl = hover && (n.id === hover.id || hl?.has(n.id));
        if (!showLabels && !isHl && n.id !== current) continue;
        ctx.globalAlpha = hover && !isHl ? 0.15 : 0.9;
        ctx.fillStyle = colors.text;
        ctx.fillText(n.label, n.x!, n.y! + radius(n) + 12 / Math.max(transform.k, 0.6));
      }
      ctx.globalAlpha = 1;
    };

    const sim = forceSimulation(nodes)
      .force("link", forceLink<GNode, GLink>(links).id((d) => d.id).distance(60).strength(0.6))
      .force("charge", forceManyBody().strength(-160))
      .force("center", forceCenter(0, 0).strength(0.05))
      .force("collide", forceCollide<GNode>().radius((n) => radius(n) + 6))
      .on("tick", draw);

    const toWorld = (e: { offsetX: number; offsetY: number }) => ({
      x: (e.offsetX - transform.x) / transform.k,
      y: (e.offsetY - transform.y) / transform.k,
    });
    const nodeAt = (e: MouseEvent) => {
      const p = toWorld(e);
      let best: GNode | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y);
        if (d < radius(n) + 6 / transform.k && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    const onDown = (e: MouseEvent) => {
      moved = false;
      const n = nodeAt(e);
      if (n) {
        drag = n;
        n.fx = n.x;
        n.fy = n.y;
        sim.alphaTarget(0.2).restart();
      } else panning = { x: e.offsetX - transform.x, y: e.offsetY - transform.y };
    };
    const onMove = (e: MouseEvent) => {
      if (drag) {
        moved = true;
        const p = toWorld(e);
        drag.fx = p.x;
        drag.fy = p.y;
      } else if (panning) {
        moved = true;
        transform = { ...transform, x: e.offsetX - panning.x, y: e.offsetY - panning.y };
        draw();
      } else {
        const n = nodeAt(e);
        if (n !== hover) {
          hover = n;
          canvas.style.cursor = n ? "pointer" : "grab";
          draw();
        }
      }
    };
    const onUp = (e: MouseEvent) => {
      if (drag) {
        if (!moved && drag.kind !== "tag" && drag.kind !== "missing") openNote(drag.id, { newTab: e.ctrlKey || e.metaKey });
        drag.fx = null;
        drag.fy = null;
        sim.alphaTarget(0);
      }
      drag = null;
      panning = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = Math.min(4, Math.max(0.15, transform.k * Math.exp(-e.deltaY * 0.0015)));
      const p = toWorld(e);
      transform = { k, x: e.offsetX - p.x * k, y: e.offsetY - p.y * k };
      draw();
    };

    // Pointer events cover mouse, touch and pen.
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    transform = { x: width / 2, y: height / 2, k: nodes.length > 150 ? 0.6 : 1 };

    return () => {
      sim.stop();
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [data, current]);

  return (
    <div className="view graph-view">
      <div className="graph-toolbar">
        <strong>{local ? `Graf: ${basename(local)}` : "Graf souvislostí"}</strong>
        <span className="muted small">
          {data.nodes.length} uzlů · {data.links.length} spojení
        </span>
        <span className="grow" />
        <input className="filter-input" placeholder="Filtrovat…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {local ? (
          <>
            <label className="check">
              Hloubka
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            <button className="btn small" onClick={() => setLocal(null)}>
              Celý trezor
            </button>
          </>
        ) : (
          current && (
            <button className="btn small" onClick={() => setLocal(current)}>
              Jen okolí poznámky
            </button>
          )
        )}
        <label className="check">
          <input type="checkbox" checked={showTags} onChange={(e) => setShowTags(e.target.checked)} /> Tagy
        </label>
        <label className="check">
          <input type="checkbox" checked={showMissing} onChange={(e) => setShowMissing(e.target.checked)} /> Neexistující
        </label>
        {!local && (
          <label className="check">
            <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} /> Osamocené
          </label>
        )}
      </div>
      <div className="graph-canvas" ref={wrapRef}>
        <canvas ref={canvasRef} aria-label="Graf propojení poznámek" />
        {data.nodes.length === 0 && (
          <div className="graph-empty muted">
            <Icon name="graph" size={28} />
            <p>Nic k zobrazení. Propoj poznámky pomocí [[odkazů]].</p>
          </div>
        )}
      </div>
    </div>
  );
}
