import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint, type ElkPort } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { GateKind, NetlistEdge, NetlistGraph, NetlistNode } from '../types/contracts';

export interface SchematicPin extends ElkPoint {
  id: string;
  side: 'WEST' | 'EAST';
  label?: string;
  clock?: boolean;
  activeLow?: boolean;
}

export interface SchematicNode extends ElkPoint {
  id: string;
  label: string;
  kind: GateKind;
  width: number;
  height: number;
  bodyHeight: number;
  pins: SchematicPin[];
}

interface SchematicWire {
  id: string;
  edgeIds: string[];
  width: number;
  path: string;
  junctions: ElkPoint[];
}

export interface SchematicLayout {
  width: number;
  height: number;
  nodes: SchematicNode[];
  wires: SchematicWire[];
}

type TopologyNode = Pick<NetlistNode, 'id' | 'label' | 'kind' | 'width' | 'level'>;
type TopologyEdge = Pick<NetlistEdge, 'id' | 'from' | 'to' | 'signalName'>;
interface Topology { nodes: TopologyNode[]; edges: TopologyEdge[] }

let elk: InstanceType<typeof ELK> | undefined;

export function schematicTopology(netlist?: NetlistGraph): string {
  if (!netlist?.nodes.length) return '';
  const nodes = netlist.nodes.map(({ id, label, kind, width, level }) => ({ id, label, kind, width, level }))
    .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const edges = netlist.edges.map(({ id, from, to, signalName }) => ({ id, from, to, signalName }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ nodes, edges });
}

function netId(edge: TopologyEdge): string {
  return JSON.stringify([edge.from, edge.signalName]);
}

function pinLabel(kind: GateKind, edge: TopologyEdge, nodes: Map<string, TopologyNode>) {
  if (kind !== 'DFF') return {};
  const signal = [edge.signalName, edge.from, nodes.get(edge.from)?.label].join(' ');
  if (/\b(?:clk|clock)\b/i.test(signal)) return { clock: true };
  if (/\b(?:rst|reset)_n\b/i.test(signal)) return { label: 'R', activeLow: true };
  if (/\b(?:rst|reset)\b/i.test(signal)) return { label: 'R' };
  return { label: 'D' };
}

function layoutInput(topology: Topology) {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const groups = new Map<string, TopologyEdge[]>();
  const inputs = new Map<string, TopologyEdge[]>();
  const outputs = new Map<string, string[]>();
  const edgePorts = new Map<string, { from: string; to: string }>();

  for (const edge of topology.edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    const group = netId(edge);
    if (!groups.has(group)) {
      groups.set(group, []);
      const sources = outputs.get(edge.from) ?? [];
      sources.push(group);
      outputs.set(edge.from, sources);
    }
    groups.get(group)!.push(edge);
    const targets = inputs.get(edge.to) ?? [];
    targets.push(edge);
    inputs.set(edge.to, targets);
    edgePorts.set(edge.id, { from: `out:${group}`, to: `in:${edge.id}` });
  }

  const nodes = topology.nodes.map((node): SchematicNode => {
    const incoming = inputs.get(node.id) ?? [];
    const outgoing = outputs.get(node.id) ?? [];
    const bodyHeight = Math.max(44, 12 * (Math.max(incoming.length, outgoing.length) + 1));
    const width = Math.min(160, Math.max(104, node.label.length * 7 + 22));
    const pins: SchematicPin[] = [
      ...incoming.map((edge, index): SchematicPin => ({
        id: `in:${edge.id}`,
        side: 'WEST', x: 0, y: 8 + bodyHeight * (index + 1) / (incoming.length + 1),
        ...pinLabel(node.kind, edge, nodeById),
      })),
      ...outgoing.map((group, index): SchematicPin => ({
        id: `out:${group}`,
        side: 'EAST', x: width, y: 8 + bodyHeight * (index + 1) / (outgoing.length + 1),
        label: node.kind === 'DFF' && outgoing.length === 1 ? 'Q' : undefined,
      })),
    ];
    return { ...node, width, height: bodyHeight + 33, bodyHeight, pins, x: 0, y: 0 };
  });

  const graph: ElkNode = {
    id: 'schematic',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
      'elk.spacing.nodeNode': '18',
      'elk.layered.spacing.nodeNodeBetweenLayers': '50',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
      'elk.layered.spacing.edgeNodeBetweenLayers': '14',
      'elk.layered.feedbackEdges': 'true',
    },
    children: nodes.map((node): ElkNode => ({
      id: `gate:${node.id}`, width: node.width, height: node.height,
      layoutOptions: {
        'elk.portConstraints': 'FIXED_POS',
        ...(node.kind === 'INPUT' ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}),
        ...(node.kind === 'OUTPUT' ? { 'elk.layered.layering.layerConstraint': 'LAST' } : {}),
      },
      ports: node.pins.map((pin): ElkPort => ({ id: pin.id, x: pin.x, y: pin.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': pin.side } })),
    })),
    edges: [...edgePorts].map(([id, ports]): ElkExtendedEdge => ({ id: `wire:${id}`, sources: [ports.from], targets: [ports.to] })),
  };
  return { graph, groups, nodes, nodeById };
}

function wirePath(routes: ElkExtendedEdge[]): string {
  const spans = new Map<string, { horizontal: boolean; fixed: number; forward: boolean; ranges: [number, number][] }>();

  for (const route of routes) {
    for (const section of route.sections ?? []) {
      const points = [section.startPoint, ...section.bendPoints ?? [], section.endPoint];
      for (let index = 1; index < points.length; index++) {
        const first = points[index - 1];
        const last = points[index];
        if (first.x === last.x && first.y === last.y) continue;
        const horizontal = first.y === last.y;
        const fixed = horizontal ? first.y : first.x;
        const a = horizontal ? first.x : first.y;
        const b = horizontal ? last.x : last.y;
        const forward = a < b;
        const key = `${horizontal}:${fixed}:${forward}`;
        const span = spans.get(key) ?? { horizontal, fixed, forward, ranges: [] };
        span.ranges.push([Math.min(a, b), Math.max(a, b)]);
        spans.set(key, span);
      }
    }
  }

  const paths: string[] = [];
  for (const { horizontal, fixed, forward, ranges } of spans.values()) {
    const [first, ...rest] = ranges.sort((a, b) => a[0] - b[0]);
    let [start, end] = first;
    const append = () => {
      const [from, to] = forward ? [start, end] : [end, start];
      paths.push(horizontal ? `M ${from} ${fixed} H ${to}` : `M ${fixed} ${from} V ${to}`);
    };
    for (const [left, right] of rest) {
      if (left <= end) end = Math.max(end, right);
      else {
        append();
        [start, end] = [left, right];
      }
    }
    append();
  }
  return paths.join(' ');
}

export async function layoutSchematic(topology: string): Promise<SchematicLayout> {
  const { graph, groups, nodes, nodeById } = layoutInput(JSON.parse(topology) as Topology);
  elk ??= new ELK({ algorithms: ['layered'], workerFactory: () => new Worker(workerUrl) });
  const arranged = await elk.layout(graph);
  const positions = new Map(arranged.children?.map((node) => [node.id, node]));
  const edges = new Map(arranged.edges?.map((edge) => [edge.id, edge]));
  return {
    width: arranged.width ?? 1,
    height: arranged.height ?? 1,
    nodes: nodes.map((node) => {
      const placed = positions.get(`gate:${node.id}`);
      return { ...node, x: placed?.x ?? 0, y: placed?.y ?? 0 };
    }),
    wires: [...groups].map(([id, group]) => {
      const routes = group.flatMap((edge) => edges.get(`wire:${edge.id}`) ?? []);
      const points = routes.flatMap((route) => route.junctionPoints ?? []);
      const junctions = [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()];
      return { id, edgeIds: group.map((edge) => edge.id), width: nodeById.get(group[0].from)?.width ?? 1, path: wirePath(routes), junctions };
    }),
  };
}
