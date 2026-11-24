import * as dagre from 'dagre';
import { useMemo } from 'react';
import type { GateKind, NetlistGraph } from '../types/contracts';

const NODE_W = 120;
const NODE_H = 40;

const KIND_COLOR: Record<GateKind, string> = {
  INPUT: '#0ea5e9',
  OUTPUT: '#f59e0b',
  AND: '#8b5cf6',
  OR: '#8b5cf6',
  NOT: '#8b5cf6',
  XOR: '#8b5cf6',
  MUX: '#ec4899',
  CMP: '#14b8a6',
  ADD: '#14b8a6',
  DFF: '#22c55e',
};

interface Layout {
  width: number;
  height: number;
  nodes: Map<string, { x: number; y: number }>;
  edges: Map<string, { x: number; y: number }[]>;
}

function layoutGraph(graph: NetlistGraph): Layout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of graph.edges) g.setEdge(e.from, e.to, {}, e.id);
  dagre.layout(g);

  const nodes = new Map(graph.nodes.map((n) => [n.id, { x: g.node(n.id).x, y: g.node(n.id).y }]));
  const edges = new Map(graph.edges.map((e) => [e.id, g.edge({ v: e.from, w: e.to, name: e.id }).points]));
  const { width = 0, height = 0 } = g.graph();
  return { width, height, nodes, edges };
}

function topologyKey(graph: NetlistGraph): string {
  return graph.nodes.map((n) => n.id).join(',') + '|' + graph.edges.map((e) => e.id).join(',');
}

function formatValue(value: number, width: number): string {
  return width === 1 ? String(value) : `0x${value.toString(16).toUpperCase()}`;
}

export function GateCanvas({ netlist }: { netlist?: NetlistGraph }) {
  const key = netlist ? topologyKey(netlist) : '';
  // Re-layout only when topology changes; values update every clock.
  const layout = useMemo(() => (netlist ? layoutGraph(netlist) : null), [key]);

  if (!netlist || !layout) {
    return <div className="flex flex-1 items-center justify-center text-slate-500">编译成功后在此显示门级信号流</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <svg width={layout.width} height={layout.height} className="mx-auto">
          {netlist.edges.map((e) => {
            const points = layout.edges.get(e.id);
            if (!points) return null;
            const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
            const high = e.value > 0;
            return (
              <path
                key={e.id}
                d={d}
                fill="none"
                stroke={high ? '#22d3ee' : '#334155'}
                strokeWidth={high ? 2.5 : 1.5}
                className={e.changed ? 'wire-pulse' : undefined}
                style={high ? { filter: 'drop-shadow(0 0 4px #22d3ee)' } : undefined}
              />
            );
          })}
          {netlist.nodes.map((n) => {
            const pos = layout.nodes.get(n.id);
            if (!pos) return null;
            const color = KIND_COLOR[n.kind];
            return (
              <g key={n.id} transform={`translate(${pos.x - NODE_W / 2},${pos.y - NODE_H / 2})`}>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill="#0f172a"
                  stroke={color}
                  strokeWidth={n.changed ? 3 : 1.5}
                  style={n.changed ? { filter: `drop-shadow(0 0 6px ${color})` } : undefined}
                />
                <text x={NODE_W / 2} y={16} textAnchor="middle" fontSize={11} fill="#e2e8f0">
                  {n.label}
                </text>
                <text x={NODE_W / 2} y={31} textAnchor="middle" fontSize={11} fill={color} fontFamily="monospace">
                  {formatValue(n.value, n.width)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="border-t border-slate-800 bg-slate-950 px-4 py-2 text-sm text-cyan-200">{netlist.narration}</div>
    </div>
  );
}
