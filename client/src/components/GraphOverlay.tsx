import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useDialog } from '../lib/useDialog';
import { faceThumbUrl } from '../lib/api';
import type { GraphNode, RelationshipDTO } from '../lib/types';
import { useAppStore } from '../store/useAppStore';
import { useGraphStore } from '../store/useGraphStore';
import { AuthImg } from './AuthImg';

const REPULSION = 2500;
const SPRING_K = 0.04;
const SPRING_REST_AI = 90;
const SPRING_REST_COOCCUR = 140;
const CENTER_K = 0.004;
const DAMPING = 0.9;
const EPSILON = 0.05;
const MAX_TICKS = 600;
/** idle breathing: per-node sinusoidal drift keeps the settled graph gently floating */
const WANDER = 0.035;
const REDUCED_MOTION =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface SimPoint {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
  phase: number;
}

function useForceLayout(nodes: GraphNode[], edges: RelationshipDTO[], width: number, height: number) {
  const ptsRef = useRef<Map<string, SimPoint>>(new Map());
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const sizeRef = useRef({ width, height });
  nodesRef.current = nodes;
  edgesRef.current = edges;
  sizeRef.current = { width, height };

  const runningRef = useRef(false);
  const ticksRef = useRef(0);
  const rafRef = useRef(0);
  const [, bump] = useState(0);
  const stepRef = useRef<(t: number) => void>(() => {});

  stepRef.current = (t: number) => {
    const pts = ptsRef.current;
    const ids = nodesRef.current.map((n) => n.id);
    const { width: w, height: h } = sizeRef.current;
    const cx = w / 2 || 300;
    const cy = h / 2 || 200;

    for (let i = 0; i < ids.length; i++) {
      const a = pts.get(ids[i]!);
      if (!a) continue;
      for (let j = i + 1; j < ids.length; j++) {
        const b = pts.get(ids[j]!);
        if (!b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const force = REPULSION / d2;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const e of edgesRef.current) {
      const a = pts.get(e.a);
      const b = pts.get(e.b);
      if (!a || !b) continue;
      const rest = e.label ? SPRING_REST_AI : SPRING_REST_COOCCUR;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (d - rest) * SPRING_K;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    let ke = 0;
    for (const id of ids) {
      const p = pts.get(id);
      if (!p) continue;
      if (p.fixed) {
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      p.vx += (cx - p.x) * CENTER_K;
      p.vy += (cy - p.y) * CENTER_K;
      if (!REDUCED_MOTION) {
        p.vx += Math.sin(t * 0.0012 + p.phase) * WANDER;
        p.vy += Math.cos(t * 0.0009 + p.phase * 1.7) * WANDER;
      }
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      p.x += p.vx;
      p.y += p.vy;
      ke += p.vx * p.vx + p.vy * p.vy;
    }

    ticksRef.current += 1;
    bump((v) => v + 1);

    // the breathing loop runs while mounted; only reduced-motion settles and stops
    if (REDUCED_MOTION && (ke < EPSILON || ticksRef.current > MAX_TICKS)) {
      runningRef.current = false;
      return;
    }
    rafRef.current = requestAnimationFrame((next) => stepRef.current(next));
  };

  const reheat = () => {
    ticksRef.current = 0;
    if (!runningRef.current) {
      runningRef.current = true;
      rafRef.current = requestAnimationFrame((next) => stepRef.current(next));
    }
  };

  useEffect(() => {
    const pts = ptsRef.current;
    const ids = new Set(nodes.map((n) => n.id));
    for (const id of Array.from(pts.keys())) if (!ids.has(id)) pts.delete(id);
    const fresh = nodes.filter((n) => !pts.has(n.id));
    const cx = width / 2 || 300;
    const cy = height / 2 || 200;
    const R = Math.max(Math.min(width, height) * 0.35, 60);
    fresh.forEach((n, i) => {
      let h = 0;
      for (let k = 0; k < n.id.length; k++) h = (h * 31 + n.id.charCodeAt(k)) | 0;
      const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
      pts.set(n.id, {
        x: cx + R * Math.cos(angle),
        y: cy + R * Math.sin(angle),
        vx: 0,
        vy: 0,
        fixed: false,
        phase: (Math.abs(h) % 628) / 100,
      });
    });
    reheat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, width, height]);

  useEffect(
    () => () => {
      // StrictMode runs this cleanup between the doubled dev effects — reset the
      // flag too, or the re-run's reheat() thinks the (cancelled) loop still runs.
      cancelAnimationFrame(rafRef.current);
      runningRef.current = false;
    },
    [],
  );

  const onNodePointerDown = (id: string, e: ReactPointerEvent<SVGGElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const p = ptsRef.current.get(id);
    if (!p) return;
    p.fixed = true;
    const move = (ev: PointerEvent) => {
      p.x = ev.clientX - rect.left;
      p.y = ev.clientY - rect.top;
      reheat();
    };
    const up = () => {
      p.fixed = false;
      reheat();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return { positions: ptsRef.current, onNodePointerDown };
}

function avatarFor(n: GraphNode) {
  const from = n.enrolledFrom[0];
  return from ? (
    <AuthImg path={faceThumbUrl(from.entryId, from.faceIndex)} alt={n.name} fallback={n.name.slice(0, 1)} />
  ) : (
    n.name.slice(0, 1)
  );
}

function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: RelationshipDTO[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 420 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { positions, onNodePointerDown } = useForceLayout(nodes, edges, size.width, size.height);
  const neighborIds = new Set<string>();
  if (selectedId) {
    for (const e of edges) {
      if (e.a === selectedId) neighborIds.add(e.b);
      if (e.b === selectedId) neighborIds.add(e.a);
    }
  }

  return (
    <div className="graph-canvas" ref={containerRef} onClick={() => onSelect(null)}>
      <svg width="100%" height="100%">
        {edges.map((e) => {
          const pa = positions.get(e.a);
          const pb = positions.get(e.b);
          if (!pa || !pb) return null;
          const dim = selectedId !== null && e.a !== selectedId && e.b !== selectedId;
          return (
            <g key={e.id} className={`graph-edge-group ${dim ? 'graph-edge--dim' : ''}`}>
              <line
                className={`graph-edge ${e.label === '' ? 'graph-edge--cooccur' : ''}`}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
              />
              {e.label && (
                <text className="graph-edge-label" x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2}>
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const dim = selectedId !== null && n.id !== selectedId && !neighborIds.has(n.id);
          return (
            <g
              key={n.id}
              className={`graph-node ${dim ? 'graph-node--dim' : ''}`}
              onPointerDown={(e) => onNodePointerDown(n.id, e)}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(n.id);
              }}
            >
              <foreignObject x={p.x - 22} y={p.y - 22} width={44} height={44}>
                <span className="user-avatar">{avatarFor(n)}</span>
              </foreignObject>
              <text className="graph-node-label" x={p.x} y={p.y + 34}>
                {n.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function GraphSidePanel({
  selected,
  nodes,
  edges,
  onClose,
}: {
  selected: GraphNode;
  nodes: GraphNode[];
  edges: RelationshipDTO[];
  onClose: () => void;
}) {
  const neighbors = edges
    .filter((e) => e.a === selected.id || e.b === selected.id)
    .map((e) => ({ edge: e, other: nodes.find((n) => n.id === (e.a === selected.id ? e.b : e.a)) }))
    .filter((x): x is { edge: RelationshipDTO; other: GraphNode } => !!x.other);

  return (
    <div className="graph-side-panel">
      <div className="graph-side-header">
        <span className="people-name">{selected.name}</span>
        <button className="icon-btn" title="取消选中" onClick={onClose}>
          ✕
        </button>
      </div>
      {neighbors.length === 0 ? (
        <p className="people-empty">暂无关系记录</p>
      ) : (
        <div className="people-list">
          {neighbors.map(({ edge, other }) => (
            <div key={edge.id} className="people-row">
              <span className="user-avatar">{avatarFor(other)}</span>
              <div>
                <div className="people-name">{other.name}</div>
                <div className="people-relation">{edge.label || '同框'}</div>
              </div>
              {!edge.virtual && (
                <div className="people-actions">
                  <button
                    className="icon-btn"
                    title="删除关系"
                    onClick={() =>
                      void useGraphStore
                        .getState()
                        .removeEdge(edge.id)
                        .catch(() => useAppStore.getState().showToast('没删掉,稍后再试'))
                    }
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function GraphOverlay() {
  const open = useGraphStore((s) => s.open);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const loading = useGraphStore((s) => s.loading);
  const closeOverlay = useGraphStore((s) => s.closeOverlay);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const panelRef = useDialog(open, closeOverlay);

  if (!open) return null;
  const selected = selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null;

  return (
    <div className="review-overlay" onClick={closeOverlay} role="presentation">
      <div
        className="user-panel user-panel--graph"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="关系图谱"
      >
        <div className="user-heading">◈ 关系图谱</div>

        {loading ? (
          <p className="people-empty">正在整理关系…</p>
        ) : nodes.length === 0 ? (
          <p className="people-empty">还没有人物档案,先去「人物」里添加吧。</p>
        ) : (
          <>
            {edges.length === 0 && (
              <p className="people-empty">还没有关系记录,继续写日记,念念会慢慢认出大家的关系。</p>
            )}
            <GraphCanvas nodes={nodes} edges={edges} selectedId={selectedId} onSelect={setSelectedId} />
            {selected && (
              <GraphSidePanel
                selected={selected}
                nodes={nodes}
                edges={edges}
                onClose={() => setSelectedId(null)}
              />
            )}
          </>
        )}

        <button className="icon-btn review-close" title="关闭" onClick={closeOverlay}>
          ✕
        </button>
      </div>
    </div>
  );
}
