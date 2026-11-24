import type { GateKind, NetlistEdge, NetlistGraph, NetlistNode } from '../types/contracts';
import type { Expr, LValue, Stmt } from './ast';
import type { ElaboratedModule, SignalSnapshot } from './simulator';

interface InternalNode {
  id: string;
  label: string;
  kind: GateKind;
  width: number;
  level: number;
  sourceLine?: number;
  boundSignal?: string;
}

interface InternalEdge {
  id: string;
  from: string;
  to: string;
  signalName: string;
  boundSignal?: string;
}

const BOARD_INPUT_LABELS: Record<string, string> = {
  rst_n: 'RST_N',
  key: 'KEY[3:0]',
  sw: 'SW[7:0]',
};

const BOARD_OUTPUT_LABELS: Record<string, string> = {
  led: 'LED[7:0]',
  traffic: 'TRAFFIC[2:0]',
  seg: 'SEG[15:0]',
};

function collectLValueNames(lv: LValue, out: Set<string>): void {
  switch (lv.type) {
    case 'ident':
    case 'index':
    case 'slice':
      out.add(lv.name);
      return;
    case 'concat':
      for (const item of lv.items) collectLValueNames(item, out);
      return;
  }
}

function collectExprSignals(expr: Expr, knownSignals: Set<string>, out: Set<string>): void {
  switch (expr.type) {
    case 'number':
      return;
    case 'ident':
      if (knownSignals.has(expr.name)) out.add(expr.name);
      return;
    case 'index':
      collectExprSignals(expr.target, knownSignals, out);
      collectExprSignals(expr.index, knownSignals, out);
      return;
    case 'slice':
      collectExprSignals(expr.target, knownSignals, out);
      collectExprSignals(expr.msb, knownSignals, out);
      collectExprSignals(expr.lsb, knownSignals, out);
      return;
    case 'concat':
      for (const it of expr.items) collectExprSignals(it, knownSignals, out);
      return;
    case 'repeat':
      collectExprSignals(expr.count, knownSignals, out);
      for (const it of expr.items) collectExprSignals(it, knownSignals, out);
      return;
    case 'unary':
      collectExprSignals(expr.operand, knownSignals, out);
      return;
    case 'binary':
      collectExprSignals(expr.left, knownSignals, out);
      collectExprSignals(expr.right, knownSignals, out);
      return;
    case 'ternary':
      collectExprSignals(expr.condition, knownSignals, out);
      collectExprSignals(expr.thenExpr, knownSignals, out);
      collectExprSignals(expr.elseExpr, knownSignals, out);
      return;
    case 'sysfn':
      collectExprSignals(expr.arg, knownSignals, out);
      return;
  }
}

function collectStmtIO(
  stmt: Stmt,
  knownSignals: Set<string>,
  reads: Set<string>,
  writes: Set<string>,
  ops: Set<GateKind>
): void {
  switch (stmt.type) {
    case 'empty':
      return;
    case 'block':
      for (const s of stmt.statements) collectStmtIO(s, knownSignals, reads, writes, ops);
      return;
    case 'assign':
      collectLValueNames(stmt.target, writes);
      collectExprSignals(stmt.value, knownSignals, reads);
      ops.add(classifyExprGate(stmt.value));
      return;
    case 'if':
      ops.add('MUX');
      collectExprSignals(stmt.condition, knownSignals, reads);
      collectStmtIO(stmt.thenBranch, knownSignals, reads, writes, ops);
      if (stmt.elseBranch) collectStmtIO(stmt.elseBranch, knownSignals, reads, writes, ops);
      return;
    case 'case':
      ops.add('MUX');
      collectExprSignals(stmt.expr, knownSignals, reads);
      for (const item of stmt.items) {
        for (const p of item.patterns) collectExprSignals(p, knownSignals, reads);
        collectStmtIO(item.body, knownSignals, reads, writes, ops);
      }
      if (stmt.defaultBranch) collectStmtIO(stmt.defaultBranch, knownSignals, reads, writes, ops);
      return;
  }
}

function classifyExprGate(expr: Expr): GateKind {
  switch (expr.type) {
    case 'ternary':
      return 'MUX';
    case 'unary':
      if (expr.op === '~' || expr.op === '!') return 'NOT';
      if (expr.op === '&') return 'AND';
      if (expr.op === '|') return 'OR';
      if (expr.op === '^') return 'XOR';
      return 'ADD';
    case 'binary':
      switch (expr.op) {
        case '&':
        case '&&':
          return 'AND';
        case '|':
        case '||':
          return 'OR';
        case '^':
          return 'XOR';
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
          return 'CMP';
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
        case '<<':
        case '>>':
        case '<<<':
        case '>>>':
          return 'ADD';
      }
      return 'MUX';
    default:
      return 'MUX';
  }
}

function formatTrafficNote(val: number): string {
  const parts: string[] = [];
  if (val & 0b100) parts.push('红灯');
  if (val & 0b010) parts.push('黄灯');
  if (val & 0b001) parts.push('绿灯');
  return parts.length > 0 ? `(${parts.join('+')})` : '(全灭)';
}

export class CompiledNetlist {
  private readonly nodes: InternalNode[];
  private readonly edges: InternalEdge[];
  private readonly maxLevel: number;

  constructor(nodes: InternalNode[], edges: InternalEdge[], maxLevel: number) {
    this.nodes = nodes;
    this.edges = edges;
    this.maxLevel = maxLevel;
  }

  evaluate(snapshot: SignalSnapshot): NetlistGraph {
    const nodeMap = new Map<string, NetlistNode>();
    const outNodes: NetlistNode[] = this.nodes.map((n) => {
      const sig = n.boundSignal;
      const value = sig !== undefined ? (snapshot.current[sig] ?? 0) : 0;
      const prev = sig !== undefined ? (snapshot.previous[sig] ?? 0) : 0;
      const node: NetlistNode = {
        id: n.id,
        label: n.label,
        kind: n.kind,
        width: n.width,
        level: n.level,
        value,
        changed: value !== prev,
        sourceLine: n.sourceLine,
      };
      nodeMap.set(n.id, node);
      return node;
    });

    // Propagate changed flag to intermediate logic gates whose boundSignal didn't differ
    // but an upstream input changed and downstream changed.
    const outEdges: NetlistEdge[] = this.edges.map((e) => {
      const fromNode = nodeMap.get(e.from);
      const sig = e.boundSignal;
      const value =
        sig !== undefined ? (snapshot.current[sig] ?? 0) : (fromNode?.value ?? 0);
      const prev =
        sig !== undefined ? (snapshot.previous[sig] ?? 0) : (fromNode?.value ?? 0);
      const changed =
        sig !== undefined ? value !== prev : Boolean(fromNode?.changed);
      return {
        id: e.id,
        from: e.from,
        to: e.to,
        signalName: e.signalName,
        value,
        changed,
      };
    });

    const narration = this.buildNarration(outNodes);
    return {
      nodes: outNodes,
      edges: outEdges,
      maxLevel: this.maxLevel,
      narration,
    };
  }

  private buildNarration(nodes: NetlistNode[]): string {
    const changedNodes = nodes
      .filter((n) => n.changed)
      .sort((a, b) => a.level - b.level);

    if (changedNodes.length === 0) {
      return '当前拍信号保持稳态，无逻辑跳变';
    }

    const inputs = changedNodes.filter((n) => n.kind === 'INPUT');
    const outputs = changedNodes.filter((n) => n.kind === 'OUTPUT');
    const mids = changedNodes.filter((n) => n.kind !== 'INPUT' && n.kind !== 'OUTPUT');

    // Prioritize interactive inputs (KEY/SW) over RST_N when multiple inputs toggle
    const sortedInputs = [...inputs].sort((a, b) =>
      a.id === 'in_rst_n' ? 1 : b.id === 'in_rst_n' ? -1 : 0
    );
    const pickedInputs = sortedInputs.slice(0, 1);

    // Pick up to 2 representative mid-level nodes (distinct levels, preferring DFF/MUX)
    const pickedMids: NetlistNode[] = [];
    const seenMidLevels = new Set<number>();
    for (const m of mids) {
      if (!seenMidLevels.has(m.level)) {
        pickedMids.push(m);
        seenMidLevels.add(m.level);
      }
      if (pickedMids.length >= 2) break;
    }

    // Prioritize TRAFFIC -> LED -> SEG so headline board outputs always appear
    const outOrder = (id: string) =>
      id === 'out_traffic' ? 0 : id === 'out_led' ? 1 : id === 'out_seg' ? 2 : 3;
    const pickedOutputs = [...outputs]
      .sort((a, b) => outOrder(a.id) - outOrder(b.id))
      .slice(0, 2);

    const picked = [...pickedInputs, ...pickedMids, ...pickedOutputs];

    const segments = picked.map((n) => {
      if (n.label === 'TRAFFIC[2:0]') {
        return `${n.label}=${n.value}${formatTrafficNote(n.value)}`;
      }
      if (n.kind === 'INPUT' || n.kind === 'OUTPUT' || n.kind === 'DFF') {
        return `${n.label}=${n.value}`;
      }
      return n.label;
    });

    return segments.join(' → ');
  }
}

export function buildNetlist(elaborated: ElaboratedModule): CompiledNetlist {
  const { ast, signals } = elaborated;
  const knownSignals = new Set(signals.keys());

  const nodes: InternalNode[] = [];
  const nodeById = new Map<string, InternalNode>();
  const edges: InternalEdge[] = [];
  const edgeKeys = new Set<string>();
  const signalDriverNode = new Map<string, string>();

  const addNode = (node: InternalNode): InternalNode => {
    const existing = nodeById.get(node.id);
    if (existing) return existing;
    nodes.push(node);
    nodeById.set(node.id, node);
    return node;
  };

  const addEdge = (from: string, to: string, signalName: string, boundSignal?: string): void => {
    if (from === to) return;
    const key = `${from}->${to}:${signalName}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      id: `e_${edges.length}`,
      from,
      to,
      signalName,
      boundSignal,
    });
  };

  // 1. Create INPUT port nodes (skip clk; DFFs implicitly clock on clk)
  for (const [name, meta] of signals) {
    if (meta.isPort && meta.direction === 'input' && name !== 'clk') {
      const id = `in_${name}`;
      addNode({
        id,
        label: BOARD_INPUT_LABELS[name] ?? name.toUpperCase(),
        kind: 'INPUT',
        width: meta.width,
        level: 0,
        boundSignal: name,
      });
      signalDriverNode.set(name, id);
    }
  }

  // 2. Pre-create DFF nodes for all signals written in sequential always blocks
  const seqTargets = new Set<string>();
  for (const block of ast.alwaysBlocks) {
    if (block.sensitivity !== 'seq') continue;
    const reads = new Set<string>();
    const writes = new Set<string>();
    const ops = new Set<GateKind>();
    collectStmtIO(block.body, knownSignals, reads, writes, ops);
    for (const w of writes) {
      seqTargets.add(w);
      const meta = signals.get(w);
      const dffId = `dff_${w}`;
      addNode({
        id: dffId,
        label: `DFF_${w}`,
        kind: 'DFF',
        width: meta?.width ?? 1,
        level: 1,
        sourceLine: block.loc.line,
        boundSignal: w,
      });
      signalDriverNode.set(w, dffId);
    }
  }

  // 3. Create combinational logic nodes for wireInits, assigns, and comb always blocks
  const pendingConnections: Array<{ targetNodeId: string; readSignals: string[] }> = [];

  const registerCombLogic = (
    targetName: string,
    kind: GateKind,
    readSignals: Set<string>,
    sourceLine: number
  ) => {
    const meta = signals.get(targetName);
    const gateId = `gate_${targetName}`;
    addNode({
      id: gateId,
      label: `${kind}_${targetName}`,
      kind,
      width: meta?.width ?? 1,
      level: 1,
      sourceLine,
      boundSignal: targetName,
    });
    if (!signalDriverNode.has(targetName)) {
      signalDriverNode.set(targetName, gateId);
    }
    pendingConnections.push({
      targetNodeId: gateId,
      readSignals: Array.from(readSignals),
    });
  };

  for (const wi of elaborated.wireInits) {
    const reads = new Set<string>();
    collectExprSignals(wi.value, knownSignals, reads);
    const kind = classifyExprGate(wi.value);
    registerCombLogic(wi.name, kind, reads, wi.value.loc.line);
  }

  for (const a of ast.assigns) {
    const targets = new Set<string>();
    collectLValueNames(a.target, targets);
    const reads = new Set<string>();
    collectExprSignals(a.value, knownSignals, reads);
    const kind = classifyExprGate(a.value);
    for (const t of targets) {
      registerCombLogic(t, kind, reads, a.loc.line);
    }
  }

  for (const block of ast.alwaysBlocks) {
    if (block.sensitivity !== 'comb') continue;
    const reads = new Set<string>();
    const writes = new Set<string>();
    const ops = new Set<GateKind>();
    collectStmtIO(block.body, knownSignals, reads, writes, ops);
    const primaryKind: GateKind = ops.has('MUX')
      ? 'MUX'
      : ops.values().next().value ?? 'MUX';
    for (const w of writes) {
      registerCombLogic(w, primaryKind, reads, block.loc.line);
    }
  }

  // 4. Create next-state logic nodes feeding each sequential DFF
  for (const block of ast.alwaysBlocks) {
    if (block.sensitivity !== 'seq') continue;
    const reads = new Set<string>();
    const writes = new Set<string>();
    const ops = new Set<GateKind>();
    collectStmtIO(block.body, knownSignals, reads, writes, ops);

    const logicKind: GateKind = ops.has('MUX')
      ? 'MUX'
      : ops.has('ADD')
        ? 'ADD'
        : ops.has('CMP')
          ? 'CMP'
          : 'MUX';

    for (const w of writes) {
      const meta = signals.get(w);
      const dffId = `dff_${w}`;
      const filteredReads = Array.from(reads).filter((r) => r !== 'clk');
      if (filteredReads.length > 0) {
        const logicId = `next_${w}`;
        addNode({
          id: logicId,
          label: `${logicKind}_${w}`,
          kind: logicKind,
          width: meta?.width ?? 1,
          level: 1,
          sourceLine: block.loc.line,
          boundSignal: w,
        });
        pendingConnections.push({
          targetNodeId: logicId,
          readSignals: filteredReads,
        });
        addEdge(logicId, dffId, `${w}_next`, w);
      }
    }
  }

  // 5. Wire all signal read dependencies to their resolved driver nodes
  for (const conn of pendingConnections) {
    for (const sigName of conn.readSignals) {
      if (sigName === 'clk') continue;
      const driverId = signalDriverNode.get(sigName);
      if (driverId) {
        addEdge(driverId, conn.targetNodeId, sigName, sigName);
      }
    }
  }

  // 6. Create OUTPUT port nodes and connect their drivers
  for (const [name, meta] of signals) {
    if (meta.isPort && meta.direction === 'output') {
      const outId = `out_${name}`;
      addNode({
        id: outId,
        label: BOARD_OUTPUT_LABELS[name] ?? name.toUpperCase(),
        kind: 'OUTPUT',
        width: meta.width,
        level: 2,
        boundSignal: name,
      });
      const driverId = signalDriverNode.get(name);
      if (driverId && driverId !== outId) {
        addEdge(driverId, outId, name, name);
      }
    }
  }

  // 7. Compute topological levels (DFF breaks combinational feedback loops)
  const levelMap = new Map<string, number>();
  for (const n of nodes) {
    levelMap.set(n.id, n.kind === 'INPUT' ? 0 : 1);
  }

  // Relax levels up to nodes.length passes, ignoring self/DFF feedback cycles
  const maxPasses = Math.max(1, nodes.length);
  for (let pass = 0; pass < maxPasses; pass++) {
    let updated = false;
    for (const e of edges) {
      const fromNode = nodeById.get(e.from);
      const toNode = nodeById.get(e.to);
      if (!fromNode || !toNode) continue;
      // Break feedback from DFF back into next-state logic so DAG levels remain finite
      if (fromNode.kind === 'DFF' && toNode.id.startsWith('next_')) continue;
      if (fromNode.kind === 'DFF' && toNode.kind === 'MUX' && toNode.id.startsWith('gate_')) {
        // Allow DFF -> output comb logic, but cap growth if cyclic
        const curFrom = levelMap.get(e.from) ?? 0;
        const curTo = levelMap.get(e.to) ?? 1;
        if (curFrom + 1 > curTo && curFrom + 1 <= maxPasses) {
          levelMap.set(e.to, curFrom + 1);
          updated = true;
        }
        continue;
      }
      const curFrom = levelMap.get(e.from) ?? 0;
      const curTo = levelMap.get(e.to) ?? 1;
      if (curFrom + 1 > curTo && curFrom + 1 <= maxPasses) {
        levelMap.set(e.to, curFrom + 1);
        updated = true;
      }
    }
    if (!updated) break;
  }

  let maxLevel = 0;
  for (const n of nodes) {
    n.level = levelMap.get(n.id) ?? 0;
    if (n.level > maxLevel) maxLevel = n.level;
  }

  // Ensure OUTPUT nodes sit on the rightmost boundary when they have predecessors
  for (const n of nodes) {
    if (n.kind === 'OUTPUT') {
      let maxPred = 0;
      for (const e of edges) {
        if (e.to === n.id) {
          maxPred = Math.max(maxPred, levelMap.get(e.from) ?? 0);
        }
      }
      n.level = Math.max(n.level, maxPred + 1);
      if (n.level > maxLevel) maxLevel = n.level;
    }
  }

  return new CompiledNetlist(nodes, edges, maxLevel);
}
