import { Code2, GitBranch } from 'lucide-react';
import { useMemo, useState } from 'react';

interface FsmEdge {
  from: string;
  to: string;
  label: string;
}

interface ParsedFsm {
  nodes: string[];
  initial?: string;
  edges: FsmEdge[];
}

function parseMermaidStateDiagram(source: string): ParsedFsm | null {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%') && !line.startsWith('stateDiagram'));

  const nodes: string[] = [];
  const nodeSet = new Set<string>();
  const edges: FsmEdge[] = [];
  let initial: string | undefined;

  const ensureNode = (name: string) => {
    if (name === '[*]' || !name || nodeSet.has(name)) return;
    nodeSet.add(name);
    nodes.push(name);
  };

  for (const line of lines) {
    const match = line.match(/^(\[\*\]|[A-Za-z0-9_\u4e00-\u9fa5-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_\u4e00-\u9fa5-]+)(?:\s*:\s*(.+))?$/);
    if (!match) continue;
    const [, from, to, rawLabel] = match;
    const label = rawLabel?.trim() ?? '';
    if (from === '[*]') {
      ensureNode(to);
      initial = to;
      continue;
    }
    if (to === '[*]') {
      ensureNode(from);
      continue;
    }
    ensureNode(from);
    ensureNode(to);
    edges.push({ from, to, label });
  }

  if (nodes.length === 0) return null;
  return { nodes, initial, edges };
}

export function FsmDiagram({ source }: { source: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const parsed = useMemo(() => parseMermaidStateDiagram(source), [source]);

  if (!parsed || showRaw) {
    return (
      <div className="fsm-box">
        <div className="fsm-head">
          <span><GitBranch size={14} /> 状态转移图（FSM）</span>
          {parsed && (
            <button type="button" className="mini-action-btn" onClick={() => setShowRaw(false)}>
              图形视图
            </button>
          )}
        </div>
        <pre className="fsm-raw">{source}</pre>
      </div>
    );
  }

  const count = parsed.nodes.length;
  const cols = Math.min(count, 4);
  const rows = Math.ceil(count / cols);
  const cellW = 166;
  const cellH = 112;
  const padX = 56;
  const padY = 58;
  const width = Math.max(420, cols * cellW + padX * 2);
  const height = Math.max(190, rows * cellH + padY * 2);

  const pos = new Map<string, { x: number; y: number }>();
  parsed.nodes.forEach((name, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    pos.set(name, {
      x: padX + col * cellW + cellW / 2,
      y: padY + row * cellH + cellH / 2,
    });
  });

  const nodeW = 104;
  const nodeH = 38;

  return (
    <div className="fsm-box">
      <div className="fsm-head">
        <span><GitBranch size={14} /> 状态转移图（{parsed.nodes.length} 个状态）</span>
        <button type="button" className="mini-action-btn" onClick={() => setShowRaw(true)}>
          <Code2 size={12} /> Mermaid 源码
        </button>
      </div>
      <div className="fsm-canvas">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="有限状态机转移图">
          <defs>
            <marker id="fsm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 9 5 L 0 8.5 z" className="fsm-arrow-head" />
            </marker>
          </defs>

          {parsed.initial && pos.get(parsed.initial) && (() => {
            const target = pos.get(parsed.initial)!;
            const startX = Math.max(16, target.x - nodeW / 2 - 34);
            return (
              <g className="fsm-start">
                <circle cx={startX} cy={target.y} r="5" />
                <line x1={startX + 5} y1={target.y} x2={target.x - nodeW / 2 - 3} y2={target.y} markerEnd="url(#fsm-arrow)" />
              </g>
            );
          })()}

          {parsed.edges.map((edge, idx) => {
            const a = pos.get(edge.from);
            const b = pos.get(edge.to);
            if (!a || !b) return null;

            if (edge.from === edge.to) {
              const loopPath = `M ${a.x - 16} ${a.y - nodeH / 2} C ${a.x - 26} ${a.y - nodeH / 2 - 34}, ${a.x + 26} ${a.y - nodeH / 2 - 34}, ${a.x + 16} ${a.y - nodeH / 2 - 2}`;
              return (
                <g key={`${edge.from}-${edge.to}-${idx}`} className="fsm-edge">
                  <path d={loopPath} markerEnd="url(#fsm-arrow)" />
                  {edge.label && (
                    <text x={a.x} y={a.y - nodeH / 2 - 30} textAnchor="middle">
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            }

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.hypot(dx, dy) || 1;
            const ux = dx / dist;
            const uy = dy / dist;
            const rx = nodeW / 2 + 4;
            const ry = nodeH / 2 + 4;
            const sx = a.x + ux * Math.min(rx, Math.abs(rx / (ux || 1)));
            const sy = a.y + uy * Math.min(ry, Math.abs(ry / (uy || 1)));
            const ex = b.x - ux * Math.min(rx, Math.abs(rx / (ux || 1)));
            const ey = b.y - uy * Math.min(ry, Math.abs(ry / (uy || 1)));

            const hasReverse = parsed.edges.some((other) => other.from === edge.to && other.to === edge.from);
            const curveLift = hasReverse ? 24 : dx < 0 ? 34 : -18;
            const nx = -uy;
            const ny = ux;
            const cx = (sx + ex) / 2 + nx * curveLift;
            const cy = (sy + ey) / 2 + ny * curveLift;
            const labelX = (sx + 2 * cx + ex) / 4;
            const labelY = (sy + 2 * cy + ey) / 4 - 4;
            const shortLabel = edge.label.length > 18 ? `${edge.label.slice(0, 17)}…` : edge.label;

            return (
              <g key={`${edge.from}-${edge.to}-${idx}`} className="fsm-edge">
                <path d={`M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`} markerEnd="url(#fsm-arrow)" />
                {shortLabel && (
                  <g>
                    <title>{edge.label}</title>
                    <text x={labelX} y={labelY} textAnchor="middle">
                      {shortLabel}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {parsed.nodes.map((name) => {
            const point = pos.get(name)!;
            const isInit = parsed.initial === name;
            return (
              <g key={name} className={`fsm-node${isInit ? ' initial' : ''}`} transform={`translate(${point.x - nodeW / 2} ${point.y - nodeH / 2})`}>
                <rect width={nodeW} height={nodeH} rx="9" />
                <text x={nodeW / 2} y={nodeH / 2} textAnchor="middle" dominantBaseline="central">
                  {name.length > 11 ? `${name.slice(0, 10)}…` : name}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
