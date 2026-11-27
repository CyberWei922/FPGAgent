import type { GateKind, NetlistEdge, NetlistGraph, NetlistNode } from '../types/contracts';
import type { AlwaysBlock, Expr, LValue, SourceLoc, Stmt } from './ast';
import { evalExpr, maskWidth, type ElaboratedModule, type SignalSnapshot } from './simulator';

type Frame = ReadonlyMap<string, number>;
type ReadValue = (frame: Frame) => number | undefined;
type InternalNode = Omit<NetlistNode, 'value' | 'changed' | 'sampled'> & { read: ReadValue };
type InternalEdge = Omit<NetlistEdge, 'id' | 'value' | 'changed' | 'sampled'> & { read: ReadValue };

interface Source {
  name: string;
  width: number;
  read: ReadValue;
  node?: string;
  pin?: string;
  signal?: string;
  parts?: Source[];
  slice?: { source: Source; offset: number };
  constant?: number;
}

const BOARD_LABELS: Record<string, string> = {
  rst_n: 'RST_N', key: 'KEY[3:0]', sw: 'SW[7:0]',
  led: 'LED[7:0]', traffic: 'TRAFFIC[2:0]', seg: 'SEG[15:0]',
  tone: 'TONE[3:0]',
  screen_x: 'SCR_X[3:0]', screen_y: 'SCR_Y[2:0]', screen_data: 'SCR_DATA[7:0]', screen_cmd: 'SCR_CMD[1:0]',
  screen_color: 'SCR_COLOR[7:0]',
};

function targetNames(target: LValue): string[] {
  return target.type === 'concat' ? target.items.flatMap(targetNames) : [target.name];
}

function lvalueIndexDeps(target: LValue): string[] {
  switch (target.type) {
    case 'ident': return [];
    case 'index': return dependencies(target.index);
    case 'slice': return [...dependencies(target.msb), ...dependencies(target.lsb)];
    case 'indexed': return [
      ...target.indices.flatMap(dependencies),
      ...(target.slice ? [...dependencies(target.slice.msb), ...dependencies(target.slice.lsb)] : []),
    ];
    case 'concat': return target.items.flatMap(lvalueIndexDeps);
  }
}

function operands(expr: Expr): Expr[] {
  switch (expr.type) {
    case 'number':
    case 'ident': return [];
    case 'index': return [expr.target, expr.index];
    case 'slice': return [expr.target, expr.msb, expr.lsb];
    case 'concat': return expr.items;
    case 'repeat': return [expr.count, ...expr.items];
    case 'unary': return [expr.operand];
    case 'binary': return [expr.left, expr.right];
    case 'ternary': return [expr.condition, expr.thenExpr, expr.elseExpr];
    case 'sysfn': return [expr.arg];
  }
}

function dependencies(expr: Expr): string[] {
  return expr.type === 'ident' ? [expr.name] : operands(expr).flatMap(dependencies);
}

function assignments(stmt: Stmt): Extract<Stmt, { type: 'assign' }>[] {
  switch (stmt.type) {
    case 'empty': return [];
    case 'assign': return [stmt];
    case 'block': return stmt.statements.flatMap(assignments);
    case 'if': return [...assignments(stmt.thenBranch), ...assignments(stmt.elseBranch ?? { type: 'empty', loc: stmt.loc })];
    case 'case': return [...stmt.items.flatMap((item) => assignments(item.body)), ...assignments(stmt.defaultBranch ?? { type: 'empty', loc: stmt.loc })];
    case 'for': return assignments(stmt.body);
  }
}

function statementInputs(stmt: Stmt, target: string): string[] {
  switch (stmt.type) {
    case 'empty': return [];
    case 'assign': return targetNames(stmt.target).includes(target)
      ? [...dependencies(stmt.value), ...lvalueIndexDeps(stmt.target)]
      : [];
    case 'block': return stmt.statements.flatMap((child) => statementInputs(child, target));
    case 'if': return [
      ...dependencies(stmt.condition), ...statementInputs(stmt.thenBranch, target),
      ...stmt.elseBranch ? statementInputs(stmt.elseBranch, target) : [],
    ];
    case 'case': return [
      ...dependencies(stmt.expr),
      ...stmt.items.flatMap(({ patterns, body }) => [...patterns.flatMap(dependencies), ...statementInputs(body, target)]),
      ...stmt.defaultBranch ? statementInputs(stmt.defaultBranch, target) : [],
    ];
    case 'for': return [...dependencies(stmt.init), ...dependencies(stmt.condition), ...statementInputs(stmt.body, target)];
  }
}

function nextExpression(stmt: Stmt | undefined, name: string, previous: Expr | undefined): Expr | undefined {
  switch (stmt?.type) {
    case undefined:
    case 'empty': return previous;
    case 'assign': return stmt.target.type === 'ident' && stmt.target.name === name ? stmt.value : previous;
    case 'block': return stmt.statements.reduce<Expr | undefined>((value, child) => nextExpression(child, name, value), previous);
    case 'if': {
      const thenExpr = nextExpression(stmt.thenBranch, name, previous);
      const elseExpr = nextExpression(stmt.elseBranch, name, previous);
      if (thenExpr === elseExpr) return thenExpr;
      if (!thenExpr || !elseExpr) return undefined;
      return { type: 'ternary', condition: stmt.condition, thenExpr, elseExpr, loc: stmt.loc };
    }
    case 'case':
    case 'for': return undefined;
  }
}

function containsCase(stmt: Stmt): boolean {
  if (stmt.type === 'case' || stmt.type === 'for') return true;
  if (stmt.type === 'block') return stmt.statements.some(containsCase);
  return stmt.type === 'if' && (containsCase(stmt.thenBranch) || Boolean(stmt.elseBranch && containsCase(stmt.elseBranch)));
}

function resetBranch({ body, resetSignal, resetActiveLow }: AlwaysBlock) {
  const statement = body.type === 'block' && body.statements.length === 1 ? body.statements[0] : body;
  if (statement.type !== 'if' || !resetSignal) return;
  const { condition } = statement;
  if (resetActiveLow && condition.type === 'unary' && condition.op === '!' &&
      condition.operand.type === 'ident' && condition.operand.name === resetSignal) return statement;
  if (!resetActiveLow && condition.type === 'ident' && condition.name === resetSignal) return statement;
}

function formatTrafficNote(value: number): string {
  const lights = [value & 4 ? '红灯' : '', value & 2 ? '黄灯' : '', value & 1 ? '绿灯' : ''].filter(Boolean);
  return `(${lights.join('+') || '全灭'})`;
}

export class CompiledNetlist {
  constructor(private readonly nodes: InternalNode[], private readonly edges: InternalEdge[], private readonly maxLevel: number) {}

  evaluate(snapshot: SignalSnapshot): NetlistGraph {
    const current = new Map(Object.entries(snapshot.current));
    const previous = new Map(Object.entries(snapshot.previous));
    const sample = (read: ReadValue) => {
      const value = read(current);
      return { value: value ?? 0, sampled: value !== undefined, changed: value !== read(previous) };
    };
    const nodes = this.nodes.map(({ read, ...node }) => ({ ...node, ...sample(read) }));
    const edges = this.edges.map(({ read, ...edge }, index) => ({ ...edge, id: `e_${index}`, ...sample(read) }));
    return {
      nodes,
      edges,
      maxLevel: this.maxLevel,
      narration: this.buildNarration(nodes),
      levelNarrations: this.buildLevelNarrations(nodes),
    };
  }

  private formatNodeEvent(node: NetlistNode): string {
    if (node.id === 'out_traffic') return `${node.label}=${node.value}${formatTrafficNote(node.value)}`;
    if (node.kind === 'MEM') return `${node.label}(存储更新)`;
    if (['INPUT', 'OUTPUT', 'DFF'].includes(node.kind)) return `${node.label}=${node.value}`;
    return node.sampled ? `${node.label}=${node.value}` : node.label;
  }

  private buildNarration(nodes: NetlistNode[]): string {
    const changed = nodes.filter((node) => node.changed).sort((a, b) => a.level - b.level);
    if (!changed.length) return '当前拍信号保持稳态，无逻辑跳变';
    const inputs = changed.filter((node) => node.kind === 'INPUT');
    const input = inputs.find((node) => node.id !== 'in_rst_n') ?? inputs[0];
    const middle = changed.filter((node) => !['INPUT', 'OUTPUT', 'BUS', 'CONST'].includes(node.kind));
    const outputs = ['out_traffic', 'out_led', 'out_seg', 'out_tone', 'out_screen_cmd', 'out_screen_data']
      .flatMap((id) => changed.filter((node) => node.id === id));
    return [...input ? [input] : [], ...middle.slice(0, 2), ...outputs.slice(0, 2)].map((node) => {
      if (node.id === 'out_traffic') return `${node.label}=${node.value}${formatTrafficNote(node.value)}`;
      if (node.kind === 'MEM') return `${node.label}(存储更新)`;
      if (['INPUT', 'OUTPUT', 'DFF'].includes(node.kind)) return `${node.label}=${node.value}`;
      return node.label;
    }).join(' → ') || '当前拍内部信号有变化';
  }

  private buildLevelNarrations(nodes: NetlistNode[]): string[] {
    const result: string[] = [];
    for (let lv = 0; lv <= this.maxLevel; lv++) {
      const atLevel = nodes.filter((node) => node.level === lv);
      const changed = atLevel.filter((node) => node.changed);
      if (lv === 0) {
        const changedInputs = changed.filter((node) => node.kind === 'INPUT');
        if (changedInputs.length > 0) {
          const summary = changedInputs.slice(0, 3).map((n) => this.formatNodeEvent(n)).join('、');
          result.push(`第 0 层（输入激励）：${summary}`);
        } else {
          result.push('第 0 层（输入激励）：输入端口保持稳定');
        }
        continue;
      }

      const changedMeaningful = changed.filter((node) => node.kind !== 'CONST' && node.kind !== 'BUS');
      const changedList = changedMeaningful.length > 0 ? changedMeaningful : changed;
      if (changedList.length === 0) {
        if (atLevel.some((n) => n.kind === 'OUTPUT')) {
          result.push(`第 ${lv} 层（输出端）：输出保持稳态`);
        } else if (atLevel.some((n) => n.kind === 'DFF')) {
          result.push(`第 ${lv} 层（触发器）：寄存器保持原值`);
        } else {
          result.push(`第 ${lv} 层（逻辑传播）：本层信号无跳变`);
        }
        continue;
      }

      const outputs = changedList.filter((n) => n.kind === 'OUTPUT');
      const dffs = changedList.filter((n) => n.kind === 'DFF');
      const others = changedList.filter((n) => n.kind !== 'OUTPUT' && n.kind !== 'DFF');
      const ordered = [...outputs, ...dffs, ...others];
      const stageLabel =
        outputs.length === changedList.length
          ? '输出响应'
          : dffs.length > 0
            ? '触发器/状态更新'
            : outputs.length > 0
              ? '逻辑与输出响应'
              : '逻辑门传播';
      const summary = ordered.slice(0, 3).map((n) => this.formatNodeEvent(n)).join('、');
      result.push(`第 ${lv} 层（${stageLabel}）：${summary}`);
    }
    return result;
  }
}

export function buildNetlist({ ast, signals, params, arrays, wireInits }: ElaboratedModule): CompiledNetlist {
  const nodes: InternalNode[] = [];
  const edges: InternalEdge[] = [];
  const drivers = new Map<string, Source>();
  const pending: Array<{ source: Source; to: string; toPin?: string; activeLow?: boolean }> = [];
  const empty: Frame = new Map();
  const evaluate = (expr: Expr, frame = empty) => evalExpr(expr, frame, signals, params, undefined, arrays);
  const isConstant = (expr: Expr) => dependencies(expr).every((name) => params.has(name));
  const hasVariableWidth = (expr: Expr): boolean =>
    (expr.type === 'slice' && (!isConstant(expr.msb) || !isConstant(expr.lsb))) ||
    (expr.type === 'repeat' && !isConstant(expr.count)) || operands(expr).some(hasVariableWidth);
  const signal = (name: string): Source => ({
    name,
    signal: name,
    width: signals.get(name)?.width ?? arrays.get(name)?.elementWidth ?? 1,
    read: (frame) => frame.get(name),
  });
  const isKnownSignal = (name: string) => signals.has(name) || arrays.has(name);
  const findArrayRoot = (expr: Expr): string | null => {
    let cur: Expr = expr;
    if (cur.type === 'slice') cur = cur.target;
    while (cur.type === 'index') cur = cur.target;
    return cur.type === 'ident' && arrays.has(cur.name) ? cur.name : null;
  };
  const connect = (source: Source, to: string, toPin?: string, activeLow?: boolean) => pending.push({ source, to, toPin, activeLow });

  function addNode(kind: GateKind, name: string, width: number, read: ReadValue, loc?: SourceLoc, operator?: string, id = `logic_${nodes.length}`): Source {
    nodes.push({ id, label: name, kind, width, level: 0, read, sourceLine: loc?.line, operator });
    return { node: id, name, width, read };
  }

  const constants = new Map<string, Source>();
  function constant(value: number, width: number): Source {
    const name = `${width}'h${value.toString(16).toUpperCase()}`;
    let source = constants.get(name);
    if (!source) {
      source = addNode('CONST', name, width, () => value);
      source.constant = value;
      constants.set(name, source);
    }
    return source;
  }

  function bundle(parts: Source[], name: string, loc?: SourceLoc): Source {
    const width = Math.min(32, parts.reduce((total, part) => total + part.width, 0));
    const read: ReadValue = (frame) => {
      let value = 0;
      for (const part of parts) {
        const bits = part.read(frame);
        if (bits === undefined) return;
        value = part.width >= 32 ? bits : (value << part.width) | bits;
      }
      return maskWidth(value, width);
    };
    const output = addNode('BUS', name, width, read, loc, '拼接');
    let high = parts.reduce((total, part) => total + part.width, 0) - 1;
    for (const part of parts) {
      const low = high - part.width + 1;
      connect(part, output.node!, high === low ? `[${high}]` : `[${high}:${low}]`);
      high = low - 1;
    }
    return { ...output, parts };
  }

  const splitters = new Map<string, Source>();
  function tap(source: Source, offset: number, width: number): Source {
    if (offset === 0 && width === source.width) return source;
    if (offset < 0 || offset >= 32) return constant(0, width);
    if (source.constant !== undefined) return constant(maskWidth(source.constant >>> offset, width), width);
    if (source.slice && offset + width <= source.width) {
      return tap(source.slice.source, source.slice.offset + offset, width);
    }
    if (source.parts && offset + width <= source.width) {
      let end = 0;
      for (const part of source.parts.toReversed()) {
        if (offset >= end && offset + width <= end + part.width) return tap(part, offset - end, width);
        end += part.width;
      }
    }
    const key = source.signal ?? source.node!;
    let splitter = splitters.get(key);
    if (!splitter) {
      splitter = addNode('BUS', `${source.name} 分线`, source.width, source.read, undefined, '分线');
      connect(source, splitter.node!);
      splitters.set(key, splitter);
    }
    const low = offset + (signals.get(source.signal ?? '')?.lsb ?? 0);
    const pin = width === 1 ? `[${low}]` : `[${low + width - 1}:${low}]`;
    return {
      node: splitter.node, pin, name: `${source.name}${pin}`, width, slice: { source, offset },
      read: (frame) => {
        const bits = source.read(frame);
        return bits === undefined ? undefined : maskWidth(bits >>> offset, width);
      },
    };
  }

  function resize(source: Source, width: number, name: string, loc?: SourceLoc): Source {
    if (source.width === width) return source;
    if (source.constant !== undefined) return constant(maskWidth(source.constant, width), width);
    if (source.width > width) return tap(source, 0, width);
    return bundle([constant(0, width - source.width), source], name, loc);
  }

  function ripple(left: Source, right: Source, width: number, name: string, loc: SourceLoc): Source {
    function gate(kind: 'AND' | 'OR' | 'XOR', a: Source, b: Source, label: string): Source {
      const read: ReadValue = (frame) => {
        const first = a.read(frame);
        const second = b.read(frame);
        if (first === undefined || second === undefined) return;
        if (kind === 'AND') return first & second;
        if (kind === 'OR') return first | second;
        return first ^ second;
      };
      const output = addNode(kind, label, 1, read, loc);
      connect(a, output.node!, 'A');
      connect(b, output.node!, 'B');
      return output;
    }
    const sum: Source[] = [];
    let carry = constant(0, 1);
    for (let bit = 0; bit < width; bit++) {
      const a = bit < left.width ? tap(left, bit, 1) : constant(0, 1);
      const b = bit < right.width ? tap(right, bit, 1) : constant(0, 1);
      if (a.constant === 0 && b.constant === 0) {
        sum.unshift(carry);
        carry = constant(0, 1);
        continue;
      }
      const propagate = a.constant === 0 ? b : b.constant === 0 ? a : gate('XOR', a, b, carry.constant === 0 ? `S${bit}` : `P${bit}`);
      sum.unshift(carry.constant === 0 ? propagate : gate('XOR', propagate, carry, `S${bit}`));
      if (bit === width - 1) break;
      const carryName = `C${bit + 1}`;
      const generate = a.constant === 0 || b.constant === 0 ? constant(0, 1) : gate('AND', a, b, carry.constant === 0 ? carryName : `G${bit}`);
      if (carry.constant === 0) carry = generate;
      else if (generate.constant === 0) carry = gate('AND', propagate, carry, carryName);
      else carry = gate('OR', generate, gate('AND', propagate, carry, `T${bit}`), carryName);
    }
    return width === 1 ? sum[0] : bundle(sum, name, loc);
  }

  const expressions = new WeakMap<Expr, Source>();
  function expression(expr: Expr, name?: string): Source {
    const existing = expressions.get(expr);
    if (existing) return existing;
    const source = lowerExpression(expr, name);
    expressions.set(expr, source);
    return source;
  }

  function lowerExpression(expr: Expr, name?: string): Source {
    const { width, value } = evaluate(expr);
    const read: ReadValue = (frame) => evaluate(expr, frame).value;
    if (isConstant(expr)) return constant(value, width);
    if (expr.type === 'ident') return signal(expr.name);
    if (expr.type === 'sysfn') return expression(expr.arg, name);
    if (expr.type === 'concat') return bundle(expr.items.map((part) => expression(part)), name ?? '总线', expr.loc);
    if (expr.type === 'index' || expr.type === 'slice') {
      const arrRoot = findArrayRoot(expr);
      if (arrRoot) {
        const output = addNode('RTL', name ?? `${arrRoot} 读口`, width, () => undefined, expr.loc, 'MEM_RD');
        for (const input of new Set(dependencies(expr))) {
          if (isKnownSignal(input)) connect(signal(input), output.node!);
        }
        return output;
      }
    }
    if (expr.type === 'index' && isConstant(expr.index) || expr.type === 'slice' && isConstant(expr.msb) && isConstant(expr.lsb)) {
      const target = expression(expr.target);
      const low = expr.type === 'index' ? evaluate(expr.index).value | 0 : Math.min(evaluate(expr.msb).value | 0, evaluate(expr.lsb).value | 0);
      const base = expr.target.type === 'ident' ? signals.get(expr.target.name)?.lsb ?? 0 : 0;
      return tap(target, low - base, width);
    }
    if (expr.type === 'ternary') {
      const output = addNode('MUX', name ?? '选择', width, read, expr.loc);
      connect(resize(expression(expr.elseExpr), width, '输入 0', expr.loc), output.node!, '0');
      connect(resize(expression(expr.thenExpr), width, '输入 1', expr.loc), output.node!, '1');
      const condition = expression(expr.condition);
      if (condition.width === 1) connect(condition, output.node!, 'S');
      else {
        const truth = addNode('RTL', '非零检测', 1, (frame) => Number(Boolean(condition.read(frame))), expr.loc, '≠0');
        connect(condition, truth.node!);
        connect(truth, output.node!, 'S');
      }
      return output;
    }
    if (expr.type === 'binary' || expr.type === 'unary') {
      const operands = expr.type === 'binary' ? [expression(expr.left), expression(expr.right)] : [expression(expr.operand)];
      const [left, right] = operands;
      const op = expr.op;
      if (expr.type === 'unary' && op === '+') return left;
      if (expr.type === 'binary' && op === '+' && width <= 5) return ripple(left, right, width, name ?? '和', expr.loc);
      const bitwise: Record<string, GateKind> = { '&': 'AND', '|': 'OR', '^': 'XOR', '~': 'NOT' };
      let kind: GateKind = 'RTL';
      if ((expr.type === 'binary' && bitwise[op]) || op === '~') kind = bitwise[op];
      else if (op === '!' && left.width === 1) kind = 'NOT';
      else if ((op === '&&' || op === '||') && left.width === 1 && right.width === 1) kind = op === '&&' ? 'AND' : 'OR';
      else if (op === '+' || op === '-') kind = 'ADD';
      else if (['==', '!=', '===', '!==', '<', '<=', '>', '>='].includes(op)) kind = 'CMP';
      const output = addNode(kind, name ?? op, width, read, expr.loc, op);
      operands.forEach((operand, index) => {
        const input = expr.type === 'binary' && bitwise[op] ? resize(operand, width, operand.name, expr.loc) : operand;
        connect(input, output.node!, index === 0 ? 'A' : 'B');
      });
      return output;
    }
    const output = addNode('RTL', name ?? '总线取位', width, read, expr.loc, expr.type === 'repeat' ? '复制' : '取位');
    for (const input of new Set(dependencies(expr))) if (isKnownSignal(input)) connect(signal(input), output.node!);
    return output;
  }

  for (const { name, isPort, direction, width } of signals.values()) {
    if (!isPort || direction !== 'input') continue;
    const read = name === 'clk' ? () => undefined : signal(name).read;
    drivers.set(name, addNode('INPUT', BOARD_LABELS[name] ?? name.toUpperCase(), width, read, undefined, undefined, `in_${name}`));
  }

  for (const arr of arrays.values()) {
    if (arr.invalidReason) continue;
    const dimsLabel = arr.dimensions.map((d) => d.size).join('×');
    const memLabel = `${arr.name}[${dimsLabel}]`;
    drivers.set(
      arr.name,
      addNode('MEM', memLabel, arr.elementWidth, (frame) => frame.get(arr.name), arr.loc, 'MEM', `mem_${arr.name}`)
    );
  }

  const blocks = ast.alwaysBlocks.map((block) => ({ block, writes: assignments(block.body) }));
  for (const { block, writes } of blocks) {
    if (block.sensitivity !== 'seq') continue;
    for (const name of new Set(writes.flatMap((item) => targetNames(item.target)))) {
      if (arrays.has(name)) continue;
      const { width, read } = signal(name);
      drivers.set(name, addNode('DFF', name, width, read, block.loc, undefined, `dff_${name}`));
    }
  }

  function assigned(value: Expr, width: number, name: string): Source {
    if (!hasVariableWidth(value)) return resize(expression(value, name), width, name, value.loc);
    const source = addNode('RTL', name, width, (frame) => maskWidth(evaluate(value, frame).value, width), value.loc, 'RTL');
    for (const input of new Set(dependencies(value))) if (isKnownSignal(input)) connect(signal(input), source.node!);
    return source;
  }

  function drive(name: string, value: Expr) {
    drivers.set(name, assigned(value, signal(name).width, name));
  }

  for (const { name, value } of wireInits) drive(name, value);
  const partialDrivers = new Map<string, Source>();
  for (const { target, value, loc } of ast.assigns) {
    if (target.type === 'ident' && !partialDrivers.has(target.name)) {
      drive(target.name, value);
      continue;
    }
    const source = hasVariableWidth(value) ? assigned(value, 32, '位赋值') : expression(value);
    for (const name of new Set(targetNames(target))) {
      let driver = partialDrivers.get(name);
      if (!driver) {
        const { width, read } = signal(name);
        driver = addNode('RTL', name, width, read, loc, '位赋值');
        const other = drivers.get(name);
        if (other && other.signal !== name) connect(other, driver.node!);
        partialDrivers.set(name, driver);
        drivers.set(name, driver);
      }
      connect(source, driver.node!);
    }
  }

  for (const { block, writes } of blocks) {
    const sequential = block.sensitivity === 'seq';
    const names = new Set(writes.flatMap((item) => targetNames(item.target)));
    const reset = sequential ? resetBranch(block) : undefined;
    for (const name of names) {
      if (arrays.has(name)) {
        const memId = `mem_${name}`;
        const reads = new Set(statementInputs(block.body, name));
        for (const input of reads) {
          if (input !== name && isKnownSignal(input)) connect(signal(input), memId, 'WR');
        }
        if (sequential && block.clockSignal) {
          connect(signal(block.clockSignal), memId, 'CLK', block.clockFalling);
        }
        continue;
      }
      const wholeWrites = writes.every((item) =>
        (!sequential || item.kind === 'nonblocking') && (item.target.type === 'ident' || !targetNames(item.target).includes(name)));
      const { width, read } = signal(name);
      const previous: Expr | undefined = sequential ? { type: 'ident', name, loc: block.loc } : undefined;
      const initial = reset && wholeWrites && !containsCase(reset.thenBranch) ? nextExpression(reset.thenBranch, name, undefined) : undefined;
      const clear = initial && isConstant(initial) && maskWidth(evaluate(initial).value, width) === 0;
      const body = clear ? reset?.elseBranch : block.body;
      const reads = new Set(body ? statementInputs(body, name) : []);
      const simple = wholeWrites && (!body || !containsCase(body)) && (sequential || ![...reads].some((dep) => names.has(dep)));
      const value = simple ? nextExpression(body, name, previous) : undefined;
      let source: Source;
      if (value) source = assigned(value, width, sequential ? `${name} D` : name);
      else {
        source = addNode('RTL', sequential ? `${name} D` : name, width, sequential ? () => undefined : read, block.loc, 'RTL');
        for (const input of reads) if (isKnownSignal(input)) connect(signal(input), source.node!);
      }
      if (sequential) {
        const id = `dff_${name}`;
        connect(source, id, 'D');
        if (block.clockSignal) connect(signal(block.clockSignal), id, 'CLK', block.clockFalling);
        if (clear && block.resetSignal) connect(signal(block.resetSignal), id, 'CLR', block.resetActiveLow);
      } else {
        drivers.set(name, source);
      }
    }
  }

  for (const [name, meta] of signals) {
    if (!meta.isPort || meta.direction !== 'output') continue;
    const { width, read } = signal(name);
    const output = addNode('OUTPUT', BOARD_LABELS[name] ?? name.toUpperCase(), width, read, undefined, undefined, `out_${name}`);
    connect(signal(name), output.node!);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const { source, to, toPin, activeLow } of pending) {
    let driver: Source | undefined = source;
    const visited = new Set<string>();
    while (driver?.signal && !visited.has(driver.signal)) {
      visited.add(driver.signal);
      driver = drivers.get(driver.signal);
    }
    if (!driver?.node) continue;
    const from = driver.node;
    edges.push({
      from, to, width: source.width, fromPin: driver.pin, toPin, activeLow,
      signalName: source.signal && driver.pin === undefined ? source.signal : driver.name,
      read: driver.read,
    });
  }

  const live = new Set(
    nodes.filter((node) => node.kind === 'OUTPUT' || node.kind === 'DFF' || node.kind === 'MEM').map((node) => node.id)
  );
  for (let count = 0; count < nodes.length; count++) {
    const size = live.size;
    for (const edge of edges) if (live.has(edge.to)) live.add(edge.from);
    if (live.size === size) break;
  }
  const shownNodes = nodes.filter((node) => live.has(node.id));
  const shownEdges = edges.filter((edge) => live.has(edge.to));
  for (const node of shownNodes) node.level = node.kind === 'INPUT' || node.kind === 'CONST' ? 0 : 1;
  for (let pass = 0; pass < shownNodes.length; pass++) {
    let changed = false;
    for (const edge of shownEdges) {
      const from = nodeById.get(edge.from)!;
      const to = nodeById.get(edge.to)!;
      if (to.kind === 'DFF' || to.kind === 'MEM' || to.level >= from.level + 1 || from.level + 1 > shownNodes.length) continue;
      to.level = from.level + 1;
      changed = true;
    }
    if (!changed) break;
  }
  return new CompiledNetlist(shownNodes, shownEdges, Math.max(0, ...shownNodes.map((node) => node.level)));
}
