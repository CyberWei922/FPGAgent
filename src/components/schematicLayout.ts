import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint, type ElkPort } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { GateKind, NetlistEdge, NetlistGraph, NetlistNode } from '../types/contracts';

export interface SchematicPin extends ElkPoint {
  id: string;
  side: 'WEST' | 'EAST' | 'SOUTH';
  label?: string;
  clock?: boolean;
  activeLow?: boolean;
}

export interface SchematicNode extends ElkPoint {
  id: string;
  label: string;
  kind: GateKind;
  operator?: string;
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

type TopologyNode = Pick<NetlistNode, 'id' | 'label' | 'kind' | 'width' | 'level' | 'operator'>;
type TopologyEdge = Pick<NetlistEdge, 'id' | 'from' | 'to' | 'signalName' | 'width' | 'fromPin' | 'toPin' | 'activeLow'>;
interface Topology { nodes: TopologyNode[]; edges: TopologyEdge[] }

let elk: InstanceType<typeof ELK> | undefined;

export function schematicTopology(netlist?: NetlistGraph): string {
  if (!netlist?.nodes.length) return '';
  const nodes = netlist.nodes.map(({ id, label, kind, width, level, operator }) => ({ id, label, kind, width, level, operator }))
    .sort((a, b) => a.level - b.level);
  const edges = netlist.edges.map(({ id, from, to, signalName, width, fromPin, toPin, activeLow }) => ({ id, from, to, signalName, width, fromPin, toPin, activeLow }));
  return JSON.stringify({ nodes, edges });
}

function netId(edge: TopologyEdge): string {
  return JSON.stringify([edge.from, edge.fromPin ?? '']);
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
    const outgoing = (outputs.get(node.id) ?? []).sort((a, b) =>
      (groups.get(b)?.[0].fromPin ?? '').localeCompare(groups.get(a)?.[0].fromPin ?? '', undefined, { numeric: true }));
    const select = node.kind === 'MUX' ? incoming.find((edge) => edge.toPin === 'S') : undefined;
    const west = incoming.filter((edge) => edge !== select);
    const terminal = node.kind === 'INPUT' || node.kind === 'OUTPUT' || node.kind === 'CONST';
    const primitive = ['AND', 'OR', 'XOR', 'NOT'].includes(node.kind);
    const bodyHeight = Math.max(terminal ? 28 : 34, 14 * (Math.max(west.length, outgoing.length) + 1));
    const width = primitive ? 64 : Math.min(154, Math.max(terminal ? 82 : 90, node.label.length * 7 + 20));
    const height = bodyHeight + (select ? 37 : 28);
    const pins: SchematicPin[] = [
      ...west.map((edge, index): SchematicPin => ({
        id: `in:${edge.id}`, side: 'WEST', x: 0, y: 8 + bodyHeight * (index + 1) / (west.length + 1),
        label: primitive ? undefined : edge.toPin,
        clock: edge.toPin === 'CLK', activeLow: edge.activeLow,
      })),
      ...outgoing.map((group, index): SchematicPin => ({
        id: `out:${group}`, side: 'EAST', x: width, y: 8 + bodyHeight * (index + 1) / (outgoing.length + 1),
        label: node.kind === 'DFF' ? 'Q' : groups.get(group)?.[0].fromPin,
      })),
    ];
    if (select) pins.push({ id: `in:${select.id}`, side: 'SOUTH', x: width / 2, y: height, label: 'S' });
    return { ...node, width, height, bodyHeight, pins, x: 0, y: 0 };
  });

  const graph: ElkNode = {
    id: 'schematic',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
      'elk.spacing.nodeNode': '18',
      'elk.layered.spacing.nodeNodeBetweenLayers': '38',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
      'elk.layered.spacing.edgeNodeBetweenLayers': '12',
      'elk.separateConnectedComponents': 'false',
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
  const spans = new Map<string, { horizontal: boolean; fixed: number; ranges: [number, number][] }>();
  const paths: string[] = [];
  const snap = ({ x, y }: ElkPoint) => ({ x: Number(x.toFixed(5)), y: Number(y.toFixed(5)) });

  for (const route of routes) {
    for (const section of route.sections ?? []) {
      const points = [section.startPoint, ...section.bendPoints ?? [], section.endPoint].map(snap);
      for (let index = 1; index < points.length; index++) {
        const first = points[index - 1];
        const last = points[index];
        if (first.x === last.x && first.y === last.y) continue;
        if (first.x !== last.x && first.y !== last.y) {
          paths.push(`M ${first.x} ${first.y} L ${last.x} ${last.y}`);
          continue;
        }
        const horizontal = first.y === last.y;
        const fixed = horizontal ? first.y : first.x;
        const a = horizontal ? first.x : first.y;
        const b = horizontal ? last.x : last.y;
        const key = `${horizontal}:${fixed}`;
        const span = spans.get(key) ?? { horizontal, fixed, ranges: [] };
        span.ranges.push([Math.min(a, b), Math.max(a, b)]);
        spans.set(key, span);
      }
    }
  }

  for (const { horizontal, fixed, ranges } of spans.values()) {
    const [first, ...rest] = ranges.sort((a, b) => a[0] - b[0]);
    let [start, end] = first;
    const append = () => {
      paths.push(horizontal ? `M ${start} ${fixed} H ${end}` : `M ${fixed} ${start} V ${end}`);
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
      return { id, edgeIds: group.map((edge) => edge.id), width: group[0].width ?? nodeById.get(group[0].from)?.width ?? 1, path: wirePath(routes), junctions };
    }),
  };
}
