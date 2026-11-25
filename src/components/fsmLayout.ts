import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';

export interface FsmEdge {
  from: string;
  to: string;
  label: string;
  labels: string[];
}

export interface ParsedFsm {
  nodes: string[];
  nodeLabels: Record<string, string>;
  initial?: string;
  terminals: string[];
  edges: FsmEdge[];
}

export type FsmLayoutMode = 'auto' | 'ring' | 'layered';
export type ResolvedFsmLayoutMode = 'single' | 'pair' | 'ring' | 'layered';

export interface LayoutNode {
  id: string;
  label: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isInitial: boolean;
  isTerminal: boolean;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  kind: 'primary' | 'secondary' | 'self';
  path: string;
  label: string;
  fullLabel: string;
  labelX: number;
  labelY: number;
  pillWidth: number;
  pillHeight: number;
}

export interface StartMarker {
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FsmLayout {
  mode: ResolvedFsmLayoutMode;
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  startMarker?: StartMarker;
}

interface Point {
  x: number;
  y: number;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface RoutedCurve {
  id: string;
  edge: FsmEdge;
  kind: LayoutEdge['kind'];
  isSelf: boolean;
  path: string;
  samples: Point[];
  evalAt: (t: number) => Point;
  normalAt: (t: number) => Point;
  preferredLabelPos?: Point;
  shortLabel: string;
  pillWidth: number;
  priority: number;
}

const NODE_HEIGHT = 42;
const NODE_RX = 10;
const PILL_HEIGHT = 22;
const CANVAS_PAD = 28;
const START_STEM_LEN = 34;
const START_DOT_R = 5;

let elkInstance: InstanceType<typeof ELK> | undefined;

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1.0 : 0.6;
  }
  return Math.ceil(units * fontSize);
}

function truncateText(text: string, maxUnits: number): string {
  let units = 0;
  let out = '';
  for (const ch of text) {
    const w = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1.65 : 1;
    if (units + w > maxUnits) return `${out.trimEnd()}…`;
    units += w;
    out += ch;
  }
  return text;
}

function normalizeAngle(angle: number): number {
  let a = angle;
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

function angularDist(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return (
    a.left < b.right + pad &&
    a.right > b.left - pad &&
    a.top < b.bottom + pad &&
    a.bottom > b.top - pad
  );
}

function pointToBoxDist(p: Point, b: Box): number {
  const dx = Math.max(b.left - p.x, 0, p.x - b.right);
  const dy = Math.max(b.top - p.y, 0, p.y - b.bottom);
  return Math.hypot(dx, dy);
}

function makeBox(cx: number, cy: number, w: number, h: number): Box {
  return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}

function rectBorderPoint(
  node: Pick<LayoutNode, 'x' | 'y' | 'width' | 'height'>,
  angle: number,
  margin = 0,
): Point {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const hw = node.width / 2 + margin;
  const hh = node.height / 2 + margin;
  const tx = Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  let px = dx * t;
  let py = dy * t;

  // Clip against rounded rectangle corner arc when ray exits inside a corner quadrant.
  const r = Math.min(NODE_RX + margin, hw, hh);
  const cx = hw - r;
  const cy = hh - r;
  if (Math.abs(px) > cx && Math.abs(py) > cy) {
    const sx = Math.sign(px) * cx;
    const sy = Math.sign(py) * cy;
    const b = -2 * (dx * sx + dy * sy);
    const c = sx * sx + sy * sy - r * r;
    const disc = b * b - 4 * c;
    if (disc >= 0) {
      const tc = (-b + Math.sqrt(disc)) / 2;
      if (tc > 0 && tc < t) {
        px = dx * tc;
        py = dy * tc;
      }
    }
  }

  return { x: node.x + px, y: node.y + py };
}

function quadPoint(p0: Point, p1: Point, p2: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

function quadNormal(p0: Point, p1: Point, p2: Point, t: number): Point {
  const tx = 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
  const ty = 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
  const len = Math.hypot(tx, ty) || 1;
  return { x: ty / len, y: -tx / len };
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

function cubicNormal(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const tx = 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
  const ty = 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
  const len = Math.hypot(tx, ty) || 1;
  return { x: ty / len, y: -tx / len };
}

export function parseMermaidStateDiagram(source: string): ParsedFsm | null {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith('%%') &&
        !line.startsWith('stateDiagram') &&
        !line.startsWith('direction ') &&
        !line.startsWith('note '),
    );

  const rawNodes: string[] = [];
  const nodeSet = new Set<string>();
  const nodeLabels: Record<string, string> = {};
  const edgeMap = new Map<string, FsmEdge>();
  const terminalSet = new Set<string>();
  let initial: string | undefined;

  const ensureNode = (name: string) => {
    if (name === '[*]' || !name || nodeSet.has(name)) return;
    nodeSet.add(name);
    rawNodes.push(name);
  };

  for (const line of lines) {
    const aliasMatch = line.match(/^state\s+"([^"]+)"\s+as\s+([A-Za-z0-9_\u4e00-\u9fa5-]+)$/);
    if (aliasMatch) {
      const [, display, id] = aliasMatch;
      ensureNode(id);
      nodeLabels[id] = display.trim();
      continue;
    }

    const match = line.match(
      /^(\[\*\]|[A-Za-z0-9_\u4e00-\u9fa5-]+)\s*--?>\s*(\[\*\]|[A-Za-z0-9_\u4e00-\u9fa5-]+)(?:\s*:\s*(.+))?$/,
    );
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
      terminalSet.add(from);
      continue;
    }

    ensureNode(from);
    ensureNode(to);
    const key = `${from}\0${to}`;
    const existing = edgeMap.get(key);
    if (existing) {
      if (label && !existing.labels.includes(label)) {
        existing.labels.push(label);
        existing.label = existing.labels.join(' / ');
      }
    } else {
      const labels = label ? [label] : [];
      edgeMap.set(key, { from, to, label, labels });
    }
  }

  if (rawNodes.length === 0) return null;

  const edges = [...edgeMap.values()];
  const nodes: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];

  if (initial && nodeSet.has(initial)) {
    visited.add(initial);
    queue.push(initial);
  }
  while (queue.length > 0) {
    const curr = queue.shift()!;
    nodes.push(curr);
    for (const edge of edges) {
      if (edge.from === curr && !visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  for (const name of rawNodes) {
    if (!visited.has(name)) {
      visited.add(name);
      nodes.push(name);
    }
  }

  return {
    nodes,
    nodeLabels,
    initial,
    terminals: [...terminalSet],
    edges,
  };
}

function hasDirectedCycle(parsed: ParsedFsm): boolean {
  const adj = new Map<string, string[]>();
  for (const n of parsed.nodes) adj.set(n, []);
  for (const e of parsed.edges) {
    if (e.from !== e.to) adj.get(e.from)?.push(e.to);
  }

  const state = new Map<string, number>(); // 0=unvisited, 1=visiting, 2=done
  const dfs = (u: string): boolean => {
    state.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const st = state.get(v) ?? 0;
      if (st === 1) return true;
      if (st === 0 && dfs(v)) return true;
    }
    state.set(u, 2);
    return false;
  };

  for (const n of parsed.nodes) {
    if ((state.get(n) ?? 0) === 0 && dfs(n)) return true;
  }
  return false;
}

export function resolveFsmLayoutMode(
  parsed: ParsedFsm,
  requested: FsmLayoutMode = 'auto',
): ResolvedFsmLayoutMode {
  const n = parsed.nodes.length;
  if (n <= 1) return 'single';
  if (requested === 'ring') return n === 2 ? 'pair' : 'ring';
  if (requested === 'layered') return 'layered';

  if (n === 2) return 'pair';
  if (n <= 6) {
    return hasDirectedCycle(parsed) ? 'ring' : 'layered';
  }
  return 'layered';
}

function orderRingNodes(parsed: ParsedFsm): string[] {
  const n = parsed.nodes.length;
  if (n <= 2) return [...parsed.nodes];

  const start = parsed.initial && parsed.nodes.includes(parsed.initial)
    ? parsed.initial
    : parsed.nodes[0];
  const rest = parsed.nodes.filter((id) => id !== start);
  const edgeSet = new Set(parsed.edges.filter((e) => e.from !== e.to).map((e) => `${e.from}\0${e.to}`));
  const undirectedPairs: Array<[string, string]> = [];
  const seenUndir = new Set<string>();
  for (const e of parsed.edges) {
    if (e.from === e.to) continue;
    const key = e.from < e.to ? `${e.from}\0${e.to}` : `${e.to}\0${e.from}`;
    if (!seenUndir.has(key)) {
      seenUndir.add(key);
      undirectedPairs.push([e.from, e.to]);
    }
  }

  // Exact permutation search for <= 7 nodes (at most 6! = 720 orderings).
  if (n <= 7) {
    const baseIndex = new Map(parsed.nodes.map((id, i) => [id, i]));
    let bestOrder = [start, ...rest];
    let bestScore = -Infinity;

    const scoreOrder = (order: string[]): number => {
      const pos = new Map<string, number>();
      order.forEach((id, i) => pos.set(id, i));

      let chainLen = 0;
      for (let i = 0; i < n - 1; i++) {
        if (edgeSet.has(`${order[i]}\0${order[i + 1]}`)) chainLen++;
        else break;
      }

      let cwPerimeter = 0;
      let ccwPerimeter = 0;
      let totalCircDist = 0;
      for (const e of parsed.edges) {
        if (e.from === e.to) continue;
        const a = pos.get(e.from)!;
        const b = pos.get(e.to)!;
        if ((a + 1) % n === b) cwPerimeter++;
        else if ((b + 1) % n === a) ccwPerimeter++;
        const d = Math.abs(a - b);
        totalCircDist += Math.min(d, n - d);
      }

      let crossings = 0;
      const chords: Array<[number, number]> = [];
      for (const [u, v] of undirectedPairs) {
        const a = pos.get(u)!;
        const b = pos.get(v)!;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (hi - lo > 1 && !(lo === 0 && hi === n - 1)) {
          chords.push([lo, hi]);
        }
      }
      for (let i = 0; i < chords.length; i++) {
        const [a, b] = chords[i];
        for (let j = i + 1; j < chords.length; j++) {
          const [c, d] = chords[j];
          if (a === c || a === d || b === c || b === d) continue;
          if ((a < c && c < b && b < d) || (c < a && a < d && d < b)) {
            crossings++;
          }
        }
      }

      // Mild tie-breaker preserving original BFS / declaration order.
      let inversions = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (baseIndex.get(order[i])! > baseIndex.get(order[j])!) inversions++;
        }
      }

      return (
        chainLen * 1000 +
        cwPerimeter * 140 +
        ccwPerimeter * 30 -
        crossings * 90 -
        totalCircDist * 12 -
        inversions * 0.5
      );
    };

    const perm = [...rest];
    const used = new Array<boolean>(perm.length).fill(false);
    const current: string[] = [start];

    const backtrack = () => {
      if (current.length === n) {
        const s = scoreOrder(current);
        if (s > bestScore) {
          bestScore = s;
          bestOrder = [...current];
        }
        return;
      }
      for (let i = 0; i < perm.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        current.push(perm[i]);
        backtrack();
        current.pop();
        used[i] = false;
      }
    };
    backtrack();
    return bestOrder;
  }

  // Greedy chain DFS fallback for large rings (n > 7).
  const adj = new Map<string, string[]>();
  for (const id of parsed.nodes) adj.set(id, []);
  for (const e of parsed.edges) {
    if (e.from !== e.to) adj.get(e.from)!.push(e.to);
  }
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (u: string) => {
    visited.add(u);
    ordered.push(u);
    for (const v of adj.get(u) ?? []) {
      if (!visited.has(v)) visit(v);
    }
  };
  visit(start);
  for (const id of parsed.nodes) {
    if (!visited.has(id)) visit(id);
  }
  return ordered;
}

function makeBaseNodes(parsed: ParsedFsm, orderedIds: string[]): LayoutNode[] {
  const terminalSet = new Set(parsed.terminals);
  return orderedIds.map((id, index) => {
    const label = parsed.nodeLabels[id] ?? id;
    const width = Math.max(86, Math.min(156, estimateTextWidth(label, 12.5) + 34));
    return {
      id,
      label,
      index,
      x: 0,
      y: 0,
      width,
      height: NODE_HEIGHT,
      isInitial: parsed.initial === id,
      isTerminal: terminalSet.has(id),
    };
  });
}

function shortEdgeLabel(edge: FsmEdge, maxUnits = 20): { shortLabel: string; pillWidth: number } {
  const shortLabel = edge.label ? truncateText(edge.label, maxUnits) : '';
  const pillWidth = shortLabel ? estimateTextWidth(shortLabel, 11) + 16 : 0;
  return { shortLabel, pillWidth };
}

function positionPairNodes(parsed: ParsedFsm, nodes: LayoutNode[]): void {
  let maxPillW = 0;
  for (const e of parsed.edges) {
    if (e.from !== e.to) {
      maxPillW = Math.max(maxPillW, shortEdgeLabel(e).pillWidth);
    }
  }
  const gap = Math.max(170, maxPillW + 68);
  nodes[0].x = -(gap / 2 + nodes[0].width / 2);
  nodes[0].y = 0;
  nodes[1].x = gap / 2 + nodes[1].width / 2;
  nodes[1].y = 0;
}

function positionRingNodes(parsed: ParsedFsm, nodes: LayoutNode[]): void {
  const n = nodes.length;
  const indexById = new Map(nodes.map((node, i) => [node.id, i]));
  const maxW = Math.max(...nodes.map((node) => node.width));

  let maxPerimLabelW = 0;
  let chordCount = 0;
  for (const e of parsed.edges) {
    if (e.from === e.to) continue;
    const a = indexById.get(e.from)!;
    const b = indexById.get(e.to)!;
    const isPerim = (a + 1) % n === b || (b + 1) % n === a;
    if (isPerim) {
      maxPerimLabelW = Math.max(maxPerimLabelW, shortEdgeLabel(e).pillWidth);
    } else {
      chordCount++;
    }
  }

  let startAngle = -Math.PI / 2;
  if (n === 4) startAngle = (-3 * Math.PI) / 4;
  else if (n === 6) startAngle = (-2 * Math.PI) / 3;

  let rx: number;
  let ry: number;
  if (n === 3) {
    rx = Math.max(195, maxW * 1.2 + maxPerimLabelW * 0.72);
    ry = Math.max(120, rx * 0.64);
  } else if (n === 4) {
    rx = Math.max(195, maxW * 1.15 + maxPerimLabelW * 0.85);
    ry = Math.max(132, rx * 0.68);
  } else if (n === 5) {
    rx = Math.max(255, maxW * 1.45 + maxPerimLabelW * 0.88);
    ry = Math.max(174, rx * 0.69);
  } else {
    const baseR = Math.max(220, (n * (maxW + Math.max(60, maxPerimLabelW * 0.52))) / (2 * Math.PI));
    rx = baseR * 1.24;
    ry = baseR * 0.84;
  }

  if (chordCount >= 2) {
    rx *= 1.08;
    ry *= 1.08;
  }

  nodes.forEach((node, i) => {
    const angle = startAngle + (i * Math.PI * 2) / n;
    node.x = round1(Math.cos(angle) * rx);
    node.y = round1(Math.sin(angle) * ry);
  });
}

function positionLayeredNodes(parsed: ParsedFsm, nodes: LayoutNode[]): void {
  const n = nodes.length;
  const idToIdx = new Map(nodes.map((node, i) => [node.id, i]));
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of parsed.edges) {
    if (e.from === e.to) continue;
    const u = idToIdx.get(e.from);
    const v = idToIdx.get(e.to);
    if (u !== undefined && v !== undefined) adj[u].push(v);
  }

  // Classify back-edges via DFS from initial so layering works cleanly on cyclic graphs too.
  const state = new Array<number>(n).fill(0);
  const backEdges = new Set<string>();
  const dfs = (u: number) => {
    state[u] = 1;
    for (const v of adj[u]) {
      if (state[v] === 1) {
        backEdges.add(`${u}->${v}`);
      } else if (state[v] === 0) {
        dfs(v);
      }
    }
    state[u] = 2;
  };
  for (let i = 0; i < n; i++) {
    if (state[i] === 0) dfs(i);
  }

  // Longest-path layering on the acyclic forward subgraph.
  const dagAdj: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Array<number>(n).fill(0);
  for (let u = 0; u < n; u++) {
    for (const v of adj[u]) {
      if (backEdges.has(`${u}->${v}`)) continue;
      dagAdj[u].push(v);
      indeg[v]++;
    }
  }

  const layer = new Array<number>(n).fill(0);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (indeg[i] === 0) queue.push(i);
  }
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of dagAdj[u]) {
      layer[v] = Math.max(layer[v], layer[u] + 1);
      indeg[v]--;
      if (indeg[v] === 0) queue.push(v);
    }
  }

  const maxLayer = Math.max(0, ...layer);
  const columns: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (let i = 0; i < n; i++) columns[layer[i]].push(i);

  // Two barycenter passes to minimize crossings across adjacent layers.
  const rowPos = new Array<number>(n).fill(0);
  const syncRows = () => {
    for (const col of columns) col.forEach((id, r) => { rowPos[id] = r; });
  };
  syncRows();

  const preds: number[][] = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u++) {
    for (const v of dagAdj[u]) preds[v].push(u);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 1; c < columns.length; c++) {
      columns[c].sort((a, b) => {
        const avgA = preds[a].length
          ? preds[a].reduce((s, p) => s + rowPos[p], 0) / preds[a].length
          : rowPos[a];
        const avgB = preds[b].length
          ? preds[b].reduce((s, p) => s + rowPos[p], 0) / preds[b].length
          : rowPos[b];
        return avgA - avgB || a - b;
      });
      syncRows();
    }
  }

  const colWidths = columns.map((col) =>
    col.length ? Math.max(...col.map((idx) => nodes[idx].width)) : 90,
  );
  const colGaps = new Array<number>(Math.max(0, columns.length - 1)).fill(120);
  for (const e of parsed.edges) {
    if (e.from === e.to) continue;
    const u = idToIdx.get(e.from)!;
    const v = idToIdx.get(e.to)!;
    if (Math.abs(layer[u] - layer[v]) === 1) {
      const c = Math.min(layer[u], layer[v]);
      colGaps[c] = Math.max(colGaps[c], shortEdgeLabel(e).pillWidth + 46);
    }
  }

  const colCenters: number[] = [];
  let cursorX = 0;
  for (let c = 0; c < columns.length; c++) {
    colCenters.push(cursorX + colWidths[c] / 2);
    cursorX += colWidths[c] + (colGaps[c] ?? 0);
  }

  const rowStep = NODE_HEIGHT + 74;
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c];
    const totalH = (col.length - 1) * rowStep;
    col.forEach((idx, r) => {
      nodes[idx].x = round1(colCenters[c]);
      nodes[idx].y = round1(r * rowStep - totalH / 2);
    });
  }
}

function chooseClearAngle(
  preferredAngles: number[],
  occupiedAngles: number[],
  minClearance = 0.56,
): number {
  let bestAngle = preferredAngles[0];
  let bestScore = -Infinity;

  for (let i = 0; i < preferredAngles.length; i++) {
    const candidate = normalizeAngle(preferredAngles[i]);
    const minDist = occupiedAngles.length
      ? Math.min(...occupiedAngles.map((occ) => angularDist(candidate, occ)))
      : Math.PI;
    const meetsThreshold = minDist >= minClearance ? 1 : 0;
    const prefBonus = (preferredAngles.length - i) * 0.24;
    const score = meetsThreshold * 10 + Math.min(minDist, minClearance + 0.16) + prefBonus;
    if (score > bestScore) {
      bestScore = score;
      bestAngle = candidate;
    }
  }
  return bestAngle;
}

function curveClearsNodes(
  p0: Point,
  ctrl: Point,
  p2: Point,
  obstacles: Box[],
  margin = 14,
): boolean {
  for (let i = 1; i <= 11; i++) {
    const pt = quadPoint(p0, ctrl, p2, i / 12);
    for (const box of obstacles) {
      if (pointToBoxDist(pt, box) < margin) return false;
    }
  }
  return true;
}

function routeFsmFromNodes(
  parsed: ParsedFsm,
  nodes: LayoutNode[],
  mode: ResolvedFsmLayoutMode,
): FsmLayout {
  const n = nodes.length;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const indexById = new Map(nodes.map((node, i) => [node.id, i]));
  const edgePairSet = new Set(parsed.edges.map((e) => `${e.from}\0${e.to}`));

  const centroid: Point = {
    x: nodes.reduce((s, node) => s + node.x, 0) / Math.max(1, n),
    y: nodes.reduce((s, node) => s + node.y, 0) / Math.max(1, n),
  };

  // Track occupied attachment angles around each node so self-loops & start markers pick open sectors.
  const nodeAngles = new Map<string, number[]>();
  for (const node of nodes) nodeAngles.set(node.id, []);

  const curves: RoutedCurve[] = [];
  const nonSelfEdges = parsed.edges.filter((e) => e.from !== e.to);
  const selfEdges = parsed.edges.filter((e) => e.from === e.to);

  for (const edge of nonSelfEdges) {
    const u = nodeById.get(edge.from)!;
    const v = nodeById.get(edge.to)!;
    const uIdx = indexById.get(edge.from)!;
    const vIdx = indexById.get(edge.to)!;
    const hasReverse = edgePairSet.has(`${edge.to}\0${edge.from}`);

    const dx = v.x - u.x;
    const dy = v.y - u.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    // Left-hand normal in SVG coords (y down): (uy, -ux) points LEFT of travel direction u -> v.
    const lnx = uy;
    const lny = -ux;

    const midX = (u.x + v.x) / 2;
    const midY = (u.y + v.y) / 2;

    let bend = 0;
    let kind: LayoutEdge['kind'] = 'primary';
    let priority = 2;

    if (mode === 'pair') {
      if (hasReverse) {
        bend = Math.max(46, Math.min(68, dist * 0.24));
        kind = uIdx < vIdx ? 'primary' : 'secondary';
      } else {
        bend = 0;
        kind = 'primary';
      }
      priority = 1;
    } else if (mode === 'ring') {
      const isCw = (uIdx + 1) % n === vIdx;
      const isCcw = (vIdx + 1) % n === uIdx;
      if (isCw) {
        kind = 'primary';
        bend = hasReverse
          ? Math.max(36, Math.min(58, dist * 0.22))
          : Math.max(24, Math.min(48, dist * 0.16));
        priority = 1;
      } else if (isCcw) {
        kind = hasReverse ? 'secondary' : 'primary';
        // For CCW travel on a clockwise ring, left-normal points INWARD.
        bend = hasReverse
          ? Math.max(24, Math.min(42, dist * 0.15))
          : -Math.max(24, Math.min(48, dist * 0.16));
        priority = hasReverse ? 2 : 1;
      } else {
        // Interior chord.
        kind = 'secondary';
        priority = 3;
        if (hasReverse) {
          bend = Math.max(24, Math.min(42, dist * 0.14));
        } else {
          // Gently fan non-diameter chords outward away from center so chords to a shared hub don't bunch.
          const toCenterX = centroid.x - midX;
          const toCenterY = centroid.y - midY;
          const distFromCenter = Math.hypot(toCenterX, toCenterY);
          if (distFromCenter > 12) {
            const dot = lnx * toCenterX + lny * toCenterY;
            const outwardSign = dot >= 0 ? -1 : 1;
            bend = outwardSign * Math.max(16, Math.min(30, dist * 0.08));
          } else {
            bend = 0;
          }
        }
      }
    } else {
      // Layered mode.
      const isForward = v.x > u.x + 8;
      const isBack = v.x < u.x - 8;
      kind = isForward && !hasReverse ? 'primary' : isForward ? 'primary' : 'secondary';
      priority = isBack ? 3 : 2;

      if (hasReverse) {
        bend = Math.max(32, Math.min(56, dist * 0.18));
      } else if (isBack) {
        // Route feedback edges smoothly along the lower side (negative leftNormal when going right->left is UP;
        // positive leftNormal when going right->left is DOWN!).
        // Check: dx < 0, dy = 0 => ux = -1, uy = 0 => lnx = 0, lny = +1 (DOWN).
        bend = Math.max(54, Math.min(120, dist * 0.24));
      } else {
        bend = 0;
      }
    }

    // Ensure curve avoids passing through any intermediate node.
    const otherNodeBoxes = nodes
      .filter((node) => node.id !== u.id && node.id !== v.id)
      .map((node) => makeBox(node.x, node.y, node.width, node.height));

    if (otherNodeBoxes.length > 0) {
      const testBend = (b: number) => {
        const ctrl: Point = { x: midX + lnx * b, y: midY + lny * b };
        const sAng = Math.atan2(ctrl.y - u.y, ctrl.x - u.x);
        const eAng = Math.atan2(ctrl.y - v.y, ctrl.x - v.x);
        const p0 = rectBorderPoint(u, sAng, 1);
        const p2 = rectBorderPoint(v, eAng, 4);
        return curveClearsNodes(p0, ctrl, p2, otherNodeBoxes, 16);
      };

      if (!testBend(bend)) {
        const preferredSign = bend !== 0 ? Math.sign(bend) : mode === 'layered' && v.x >= u.x ? 1 : 1;
        let resolved = bend;
        for (let mag = Math.max(52, Math.abs(bend) + 26); mag <= 260; mag += 26) {
          if (testBend(preferredSign * mag)) {
            resolved = preferredSign * mag;
            break;
          }
          if (testBend(-preferredSign * mag)) {
            resolved = -preferredSign * mag;
            break;
          }
        }
        bend = resolved;
      }
    }

    const ctrl: Point = { x: midX + lnx * bend, y: midY + lny * bend };
    const startAngle = Math.atan2(ctrl.y - u.y, ctrl.x - u.x);
    const endAngle = Math.atan2(ctrl.y - v.y, ctrl.x - v.x);
    const p0 = rectBorderPoint(u, startAngle, 1);
    const p2 = rectBorderPoint(v, endAngle, 4);

    nodeAngles.get(u.id)!.push(startAngle);
    nodeAngles.get(v.id)!.push(endAngle);

    const path = `M ${round1(p0.x)} ${round1(p0.y)} Q ${round1(ctrl.x)} ${round1(ctrl.y)} ${round1(p2.x)} ${round1(p2.y)}`;
    const samples: Point[] = [];
    for (let i = 1; i <= 15; i++) {
      samples.push(quadPoint(p0, ctrl, p2, i / 16));
    }

    const { shortLabel, pillWidth } = shortEdgeLabel(edge);
    curves.push({
      id: `${edge.from}->${edge.to}`,
      edge,
      kind,
      isSelf: false,
      path,
      samples,
      evalAt: (t) => quadPoint(p0, ctrl, p2, t),
      normalAt: (t) => quadNormal(p0, ctrl, p2, t),
      shortLabel,
      pillWidth,
      priority,
    });
  }

  // Place self-loops along each node's cleanest outward radial sector.
  for (const edge of selfEdges) {
    const node = nodeById.get(edge.from)!;
    const occupied = nodeAngles.get(node.id)!;

    let baseAngle = -Math.PI / 2;
    if (mode === 'ring') {
      baseAngle = Math.atan2(node.y - centroid.y, node.x - centroid.x);
    } else if (mode === 'pair') {
      baseAngle = node.index === 0 ? -Math.PI / 2 - 0.28 : -Math.PI / 2 + 0.28;
    } else if (mode === 'layered' && node.y > centroid.y + 10) {
      baseAngle = Math.PI / 2;
    }

    const offsets = [0, 0.35, -0.35, 0.72, -0.72, 1.1, -1.1, Math.PI];
    const theta = chooseClearAngle(
      offsets.map((off) => baseAngle + off),
      occupied,
      0.58,
    );

    const spread = 0.36;
    const p0 = rectBorderPoint(node, theta - spread, 1);
    const p3 = rectBorderPoint(node, theta + spread, 4);
    const reach = 54;
    const c1: Point = {
      x: p0.x + Math.cos(theta - 0.5) * reach,
      y: p0.y + Math.sin(theta - 0.5) * reach,
    };
    const c2: Point = {
      x: p3.x + Math.cos(theta + 0.5) * reach,
      y: p3.y + Math.sin(theta + 0.5) * reach,
    };

    occupied.push(theta - spread, theta, theta + spread);

    const path = `M ${round1(p0.x)} ${round1(p0.y)} C ${round1(c1.x)} ${round1(c1.y)} ${round1(c2.x)} ${round1(c2.y)} ${round1(p3.x)} ${round1(p3.y)}`;
    const samples: Point[] = [];
    for (let i = 1; i <= 15; i++) {
      samples.push(cubicPoint(p0, c1, c2, p3, i / 16));
    }

    const apex = cubicPoint(p0, c1, c2, p3, 0.5);
    const { shortLabel, pillWidth } = shortEdgeLabel(edge, 18);
    // Offset self-loop label gently outward from the loop apex.
    const outX = Math.cos(theta);
    const outY = Math.sin(theta);
    const radialOffset = Math.abs(outX) * (pillWidth / 2 + 8) + Math.abs(outY) * (PILL_HEIGHT / 2 + 7);
    const preferredLabelPos: Point = {
      x: apex.x + outX * Math.min(radialOffset, pillWidth * 0.48 + 14),
      y: apex.y + outY * Math.min(radialOffset, PILL_HEIGHT * 0.5 + 13),
    };

    curves.push({
      id: `${edge.from}->${edge.to}`,
      edge,
      kind: 'self',
      isSelf: true,
      path,
      samples,
      evalAt: (t) => cubicPoint(p0, c1, c2, p3, t),
      normalAt: (t) => cubicNormal(p0, c1, c2, p3, t),
      preferredLabelPos,
      shortLabel,
      pillWidth,
      priority: 0,
    });
  }

  // Place initial state start marker on the cleanest open side of the initial node.
  let startMarker: StartMarker | undefined;
  let startMarkerBox: Box | undefined;
  if (parsed.initial && nodeById.has(parsed.initial)) {
    const initNode = nodeById.get(parsed.initial)!;
    const occupied = nodeAngles.get(initNode.id)!;
    const isTopCenteredRing =
      mode === 'ring' &&
      initNode.y < centroid.y - 20 &&
      Math.abs(initNode.x - centroid.x) < 20;
    const preferredStartAngles = isTopCenteredRing
      ? [
          -Math.PI / 2, // straight top (bilaterally symmetric for triangle / pentagon)
          (-3 * Math.PI) / 4, // upper-left
          (-5 * Math.PI) / 6,
          Math.PI, // horizontal left
          -Math.PI / 4,
          (5 * Math.PI) / 6,
          0,
        ]
      : [
          Math.PI, // horizontal left
          (-5 * Math.PI) / 6, // upper-left
          (-3 * Math.PI) / 4,
          (5 * Math.PI) / 6, // lower-left
          -Math.PI / 2, // top
          -Math.PI / 4,
          0,
        ];
    const startDir = chooseClearAngle(preferredStartAngles, occupied, 0.62);
    const tip = rectBorderPoint(initNode, startDir, 4);
    const cx = tip.x + Math.cos(startDir) * START_STEM_LEN;
    const cy = tip.y + Math.sin(startDir) * START_STEM_LEN;
    const x1 = cx - Math.cos(startDir) * START_DOT_R;
    const y1 = cy - Math.sin(startDir) * START_DOT_R;

    startMarker = {
      cx: round1(cx),
      cy: round1(cy),
      x1: round1(x1),
      y1: round1(y1),
      x2: round1(tip.x),
      y2: round1(tip.y),
    };
    startMarkerBox = {
      left: Math.min(cx - START_DOT_R, tip.x) - 4,
      right: Math.max(cx + START_DOT_R, tip.x) + 4,
      top: Math.min(cy - START_DOT_R, tip.y) - 4,
      bottom: Math.max(cy + START_DOT_R, tip.y) + 4,
    };
  }

  // Global collision-free label placement solver.
  const nodeBoxes: Box[] = nodes.map((node) => makeBox(node.x, node.y, node.width, node.height));
  const placedLabelBoxes: Box[] = [];
  const labelPositions = new Map<string, Point>();

  const curvesByPriority = [...curves].sort((a, b) => a.priority - b.priority);
  for (const curve of curvesByPriority) {
    if (!curve.shortLabel || curve.pillWidth <= 0) {
      const mid = curve.evalAt(0.5);
      labelPositions.set(curve.id, mid);
      continue;
    }

    const otherCurves = curves.filter((other) => other.id !== curve.id);
    const candidates: Array<{ pos: Point; baseCost: number }> = [];

    if (curve.isSelf && curve.preferredLabelPos) {
      const base = curve.preferredLabelPos;
      const apex = curve.evalAt(0.5);
      const dx = base.x - apex.x;
      const dy = base.y - apex.y;
      const len = Math.hypot(dx, dy) || 1;
      const ox = dx / len;
      const oy = dy / len;
      const px = -oy;
      const py = ox;

      candidates.push({ pos: base, baseCost: 0 });
      for (const extra of [6, 14, -4]) {
        for (const tang of [0, 14, -14, 28, -28]) {
          candidates.push({
            pos: { x: base.x + ox * extra + px * tang, y: base.y + oy * extra + py * tang },
            baseCost: Math.abs(extra) * 0.4 + Math.abs(tang) * 0.3,
          });
        }
      }
    } else {
      const ts = [0.5, 0.42, 0.58, 0.35, 0.65, 0.28, 0.72];
      const offsets = [0, 11, -11, 20, -20, 30, -30];
      for (const offset of offsets) {
        for (const t of ts) {
          const pt = curve.evalAt(t);
          const norm = curve.normalAt(t);
          candidates.push({
            pos: { x: pt.x + norm.x * offset, y: pt.y + norm.y * offset },
            baseCost: Math.abs(t - 0.5) * 45 + Math.abs(offset) * 1.4,
          });
        }
      }
    }

    let chosen: Point | undefined;
    let bestCost = Infinity;

    const isFree = (box: Box): boolean => {
      for (const nb of nodeBoxes) {
        if (boxesOverlap(box, nb, 5)) return false;
      }
      if (startMarkerBox && boxesOverlap(box, startMarkerBox, 5)) return false;
      for (const lb of placedLabelBoxes) {
        if (boxesOverlap(box, lb, 5)) return false;
      }
      return true;
    };

    for (const cand of candidates) {
      const box = makeBox(cand.pos.x, cand.pos.y, curve.pillWidth, PILL_HEIGHT);
      if (!isFree(box)) continue;

      // Penalize proximity to OTHER edges' curves (keeps crossing diagonal labels clear of the other line).
      let curvePenalty = 0;
      for (const other of otherCurves) {
        for (const s of other.samples) {
          const d = pointToBoxDist(s, box);
          if (d < 10) curvePenalty += (10 - d) * 12;
        }
      }

      const cost = cand.baseCost + curvePenalty;
      if (cost < bestCost) {
        bestCost = cost;
        chosen = cand.pos;
      }
    }

    // Expanding spiral fallback guarantees zero box overlap even on dense graphs.
    if (!chosen) {
      const origin = curve.preferredLabelPos ?? curve.evalAt(0.5);
      outer: for (let radius = 14; radius <= 220; radius += 12) {
        for (let step = 0; step < 16; step++) {
          const ang = (step * Math.PI * 2) / 16;
          const pt = { x: origin.x + Math.cos(ang) * radius, y: origin.y + Math.sin(ang) * radius };
          const box = makeBox(pt.x, pt.y, curve.pillWidth, PILL_HEIGHT);
          if (isFree(box)) {
            chosen = pt;
            break outer;
          }
        }
      }
      chosen ??= origin;
    }

    labelPositions.set(curve.id, chosen);
    placedLabelBoxes.push(makeBox(chosen.x, chosen.y, curve.pillWidth, PILL_HEIGHT));
  }

  // Compute tight bounding box over nodes, curves, labels, and start marker, then shift to positive coords.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const includeBox = (b: Box) => {
    minX = Math.min(minX, b.left);
    minY = Math.min(minY, b.top);
    maxX = Math.max(maxX, b.right);
    maxY = Math.max(maxY, b.bottom);
  };
  const includePoint = (p: Point, r = 6) => {
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r);
    maxY = Math.max(maxY, p.y + r);
  };

  for (const nb of nodeBoxes) includeBox(nb);
  if (startMarkerBox) includeBox(startMarkerBox);
  for (const curve of curves) {
    for (const s of curve.samples) includePoint(s, 8);
    if (curve.pillWidth > 0) {
      const lp = labelPositions.get(curve.id)!;
      includeBox(makeBox(lp.x, lp.y, curve.pillWidth, PILL_HEIGHT));
    }
  }

  const shiftX = Math.ceil(CANVAS_PAD - minX);
  const shiftY = Math.ceil(CANVAS_PAD - minY);
  const width = Math.max(360, Math.ceil(maxX - minX + CANVAS_PAD * 2));
  const height = Math.max(180, Math.ceil(maxY - minY + CANVAS_PAD * 2));

  const shiftedNodes: LayoutNode[] = nodes.map((node) => ({
    ...node,
    x: round1(node.x + shiftX),
    y: round1(node.y + shiftY),
  }));

  const shiftPath = (path: string): string =>
    path.replace(
      /([MQCL])\s*([-0-9.]+)\s+([-0-9.]+)(?:\s+([-0-9.]+)\s+([-0-9.]+))?(?:\s+([-0-9.]+)\s+([-0-9.]+))?/g,
      (_, cmd, x1, y1, x2, y2, x3, y3) => {
        const parts = [`${cmd} ${round1(Number(x1) + shiftX)} ${round1(Number(y1) + shiftY)}`];
        if (x2 !== undefined && y2 !== undefined) {
          parts.push(`${round1(Number(x2) + shiftX)} ${round1(Number(y2) + shiftY)}`);
        }
        if (x3 !== undefined && y3 !== undefined) {
          parts.push(`${round1(Number(x3) + shiftX)} ${round1(Number(y3) + shiftY)}`);
        }
        return parts.join(' ');
      },
    );

  const layoutEdges: LayoutEdge[] = curves.map((curve) => {
    const lp = labelPositions.get(curve.id)!;
    return {
      id: curve.id,
      from: curve.edge.from,
      to: curve.edge.to,
      kind: curve.kind,
      path: shiftPath(curve.path),
      label: curve.shortLabel,
      fullLabel: curve.edge.label,
      labelX: round1(lp.x + shiftX),
      labelY: round1(lp.y + shiftY),
      pillWidth: curve.pillWidth,
      pillHeight: PILL_HEIGHT,
    };
  });

  const shiftedStartMarker = startMarker
    ? {
        cx: round1(startMarker.cx + shiftX),
        cy: round1(startMarker.cy + shiftY),
        x1: round1(startMarker.x1 + shiftX),
        y1: round1(startMarker.y1 + shiftY),
        x2: round1(startMarker.x2 + shiftX),
        y2: round1(startMarker.y2 + shiftY),
      }
    : undefined;

  return {
    mode,
    width,
    height,
    nodes: shiftedNodes,
    edges: layoutEdges,
    startMarker: shiftedStartMarker,
  };
}

export function layoutFsm(parsed: ParsedFsm, requestedMode: FsmLayoutMode = 'auto'): FsmLayout {
  const resolved = resolveFsmLayoutMode(parsed, requestedMode);
  const orderedIds = resolved === 'ring' ? orderRingNodes(parsed) : [...parsed.nodes];
  const nodes = makeBaseNodes(parsed, orderedIds);

  if (resolved === 'single') {
    nodes[0].x = 0;
    nodes[0].y = 0;
  } else if (resolved === 'pair') {
    positionPairNodes(parsed, nodes);
  } else if (resolved === 'ring') {
    positionRingNodes(parsed, nodes);
  } else {
    positionLayeredNodes(parsed, nodes);
  }

  return routeFsmFromNodes(parsed, nodes, resolved);
}

export async function layoutFsmWithElk(parsed: ParsedFsm): Promise<FsmLayout> {
  const nodes = makeBaseNodes(parsed, [...parsed.nodes]);
  const nonSelfEdges = parsed.edges.filter((e) => e.from !== e.to);

  let maxLabelW = 0;
  for (const e of nonSelfEdges) {
    maxLabelW = Math.max(maxLabelW, shortEdgeLabel(e).pillWidth);
  }

  const graph: ElkNode = {
    id: 'fsm',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '74',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.max(120, maxLabelW + 46)),
      'elk.layered.feedbackEdges': 'true',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: nodes.map((node): ElkNode => ({
      id: node.id,
      width: node.width,
      height: node.height,
      ...(node.isInitial ? { layoutOptions: { 'elk.layered.layering.layerConstraint': 'FIRST' } } : {}),
    })),
    edges: nonSelfEdges.map((edge, idx): ElkExtendedEdge => ({
      id: `e:${idx}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  };

  elkInstance ??= new ELK({ algorithms: ['layered'], workerFactory: () => new Worker(workerUrl) });
  const arranged = await elkInstance.layout(graph);
  const posMap = new Map(arranged.children?.map((c) => [c.id, c]));

  for (const node of nodes) {
    const placed = posMap.get(node.id);
    if (placed) {
      node.x = round1((placed.x ?? 0) + node.width / 2);
      node.y = round1((placed.y ?? 0) + node.height / 2);
    }
  }

  return routeFsmFromNodes(parsed, nodes, 'layered');
}
