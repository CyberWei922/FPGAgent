import type { BoardInputs, BoardOutputs, SignalSample } from '../types/contracts';
import type {
  AlwaysBlock,
  Expr,
  LValue,
  ModuleAst,
  PortDirection,
  RangeSpec,
  SignalKind,
  Stmt,
} from './ast';

export interface SignalMeta {
  name: string;
  width: number;
  msb: number;
  lsb: number;
  mask: number;
  signed: boolean;
  isPort: boolean;
  direction?: PortDirection;
  kind: SignalKind;
}

export interface ElaboratedModule {
  ast: ModuleAst;
  params: Map<string, { value: number; width: number; signed: boolean }>;
  signals: Map<string, SignalMeta>;
  wireInits: Array<{ name: string; value: Expr }>;
  regInits: Array<{ name: string; value: Expr }>;
}

interface EvalValue {
  value: number;
  width: number;
  signed: boolean;
}

interface PendingWrite {
  target: LValue;
  value: number;
}

export const MAX_COMB_ITERATIONS = 16;
export const MAX_FOR_ITERATIONS = 128;

function isExprStatic(
  expr: Expr,
  params: Map<string, { value: number; width: number; signed: boolean }>,
  constVars: ReadonlySet<string>
): boolean {
  switch (expr.type) {
    case 'number':
      return true;
    case 'ident':
      return params.has(expr.name) || constVars.has(expr.name);
    case 'index':
      return isExprStatic(expr.target, params, constVars) && isExprStatic(expr.index, params, constVars);
    case 'slice':
      return (
        isExprStatic(expr.target, params, constVars) &&
        isExprStatic(expr.msb, params, constVars) &&
        isExprStatic(expr.lsb, params, constVars)
      );
    case 'concat':
      return expr.items.every((it) => isExprStatic(it, params, constVars));
    case 'repeat':
      return isExprStatic(expr.count, params, constVars) && expr.items.every((it) => isExprStatic(it, params, constVars));
    case 'unary':
      return isExprStatic(expr.operand, params, constVars);
    case 'binary':
      return isExprStatic(expr.left, params, constVars) && isExprStatic(expr.right, params, constVars);
    case 'ternary':
      return (
        isExprStatic(expr.condition, params, constVars) &&
        isExprStatic(expr.thenExpr, params, constVars) &&
        isExprStatic(expr.elseExpr, params, constVars)
      );
    case 'sysfn':
      return isExprStatic(expr.arg, params, constVars);
  }
}

function substituteExpr(expr: Expr, varName: string, value: number): Expr {
  switch (expr.type) {
    case 'number':
      return expr;
    case 'ident':
      if (expr.name === varName) {
        return {
          type: 'number',
          value: value >>> 0,
          width: 32,
          sized: false,
          signed: true,
          raw: String(value),
          loc: expr.loc,
        };
      }
      return expr;
    case 'index':
      return {
        ...expr,
        target: substituteExpr(expr.target, varName, value),
        index: substituteExpr(expr.index, varName, value),
      };
    case 'slice':
      return {
        ...expr,
        target: substituteExpr(expr.target, varName, value),
        msb: substituteExpr(expr.msb, varName, value),
        lsb: substituteExpr(expr.lsb, varName, value),
      };
    case 'concat':
      return { ...expr, items: expr.items.map((it) => substituteExpr(it, varName, value)) };
    case 'repeat':
      return {
        ...expr,
        count: substituteExpr(expr.count, varName, value),
        items: expr.items.map((it) => substituteExpr(it, varName, value)),
      };
    case 'unary':
      return { ...expr, operand: substituteExpr(expr.operand, varName, value) };
    case 'binary':
      return {
        ...expr,
        left: substituteExpr(expr.left, varName, value),
        right: substituteExpr(expr.right, varName, value),
      };
    case 'ternary':
      return {
        ...expr,
        condition: substituteExpr(expr.condition, varName, value),
        thenExpr: substituteExpr(expr.thenExpr, varName, value),
        elseExpr: substituteExpr(expr.elseExpr, varName, value),
      };
    case 'sysfn':
      return { ...expr, arg: substituteExpr(expr.arg, varName, value) };
  }
}

function substituteLValue(lv: LValue, varName: string, value: number): LValue {
  switch (lv.type) {
    case 'ident':
      return lv;
    case 'index':
      return { ...lv, index: substituteExpr(lv.index, varName, value) };
    case 'slice':
      return {
        ...lv,
        msb: substituteExpr(lv.msb, varName, value),
        lsb: substituteExpr(lv.lsb, varName, value),
      };
    case 'concat':
      return { ...lv, items: lv.items.map((it) => substituteLValue(it, varName, value)) };
  }
}

function substituteStmt(stmt: Stmt, varName: string, value: number): Stmt {
  switch (stmt.type) {
    case 'empty':
      return stmt;
    case 'block':
      return { ...stmt, statements: stmt.statements.map((s) => substituteStmt(s, varName, value)) };
    case 'assign':
      return {
        ...stmt,
        target: substituteLValue(stmt.target, varName, value),
        value: substituteExpr(stmt.value, varName, value),
      };
    case 'if':
      return {
        ...stmt,
        condition: substituteExpr(stmt.condition, varName, value),
        thenBranch: substituteStmt(stmt.thenBranch, varName, value),
        elseBranch: stmt.elseBranch ? substituteStmt(stmt.elseBranch, varName, value) : undefined,
      };
    case 'case':
      return {
        ...stmt,
        expr: substituteExpr(stmt.expr, varName, value),
        items: stmt.items.map((item) => ({
          ...item,
          patterns: item.patterns.map((p) => substituteExpr(p, varName, value)),
          body: substituteStmt(item.body, varName, value),
        })),
        defaultBranch: stmt.defaultBranch ? substituteStmt(stmt.defaultBranch, varName, value) : undefined,
      };
    case 'for':
      if (stmt.varName === varName) return stmt;
      return {
        ...stmt,
        init: substituteExpr(stmt.init, varName, value),
        condition: substituteExpr(stmt.condition, varName, value),
        step: substituteStmt(stmt.step, varName, value),
        body: substituteStmt(stmt.body, varName, value),
      };
  }
}

function unrollStmt(
  stmt: Stmt,
  params: Map<string, { value: number; width: number; signed: boolean }>
): Stmt {
  switch (stmt.type) {
    case 'empty':
    case 'assign':
      return stmt;
    case 'block':
      return { ...stmt, statements: stmt.statements.map((s) => unrollStmt(s, params)) };
    case 'if':
      return {
        ...stmt,
        thenBranch: unrollStmt(stmt.thenBranch, params),
        elseBranch: stmt.elseBranch ? unrollStmt(stmt.elseBranch, params) : undefined,
      };
    case 'case':
      return {
        ...stmt,
        items: stmt.items.map((item) => ({ ...item, body: unrollStmt(item.body, params) })),
        defaultBranch: stmt.defaultBranch ? unrollStmt(stmt.defaultBranch, params) : undefined,
      };
    case 'for': {
      const varSet = new Set([stmt.varName]);
      const stepExpr =
        stmt.step.type === 'assign' &&
        stmt.step.target.type === 'ident' &&
        stmt.step.target.name === stmt.varName
          ? stmt.step.value
          : null;
      if (
        !stepExpr ||
        !isExprStatic(stmt.init, params, new Set()) ||
        !isExprStatic(stmt.condition, params, varSet) ||
        !isExprStatic(stepExpr, params, varSet)
      ) {
        return { ...stmt, body: unrollStmt(stmt.body, params) };
      }

      const loopSignals = new Map<string, SignalMeta>([
        [
          stmt.varName,
          {
            name: stmt.varName,
            width: 32,
            msb: 31,
            lsb: 0,
            mask: 0xffffffff,
            signed: true,
            isPort: false,
            kind: 'reg',
          },
        ],
      ]);
      const env = new Map<string, number>();
      let cur = toSigned(evalConstExpr(stmt.init, params).value, 32);
      const unrolled: Stmt[] = [];
      for (let iter = 0; iter < MAX_FOR_ITERATIONS; iter++) {
        env.set(stmt.varName, cur >>> 0);
        const cond = evalExpr(stmt.condition, env, loopSignals, params);
        if (cond.value === 0) break;
        const clonedBody = substituteStmt(stmt.body, stmt.varName, cur);
        unrolled.push(unrollStmt(clonedBody, params));
        const nextVal = evalExpr(stepExpr, env, loopSignals, params);
        cur = toSigned(nextVal.value, 32);
      }
      return { type: 'block', statements: unrolled, loc: stmt.loc };
    }
  }
}

function matchCasePattern(
  kind: 'case' | 'casez' | 'casex',
  targetVal: number,
  patExpr: Expr,
  patVal: number
): boolean {
  if (kind === 'case' || patExpr.type !== 'number') {
    return targetVal === patVal;
  }
  const mask =
    kind === 'casez'
      ? (patExpr.wildcardMask ?? 0)
      : (patExpr.wildcardMask ?? 0) | (patExpr.xMask ?? 0);
  if (mask === 0) return targetVal === patVal;
  return ((targetVal & ~mask) >>> 0) === ((patVal & ~mask) >>> 0);
}

export function maskWidth(value: number, width: number): number {
  if (width <= 0) return 0;
  if (width >= 32) return value >>> 0;
  return ((value >>> 0) & ((1 << width) - 1)) >>> 0;
}

export function toSigned(value: number, width: number): number {
  if (width <= 0) return 0;
  const masked = maskWidth(value, width);
  if (width >= 32) return masked | 0;
  const shift = 32 - width;
  return (masked << shift) >> shift;
}

function evalConstExpr(
  expr: Expr,
  params: Map<string, { value: number; width: number; signed: boolean }>
): EvalValue {
  const emptySignals = new Map<string, SignalMeta>();
  const emptyValues = new Map<string, number>();
  return evalExpr(expr, emptyValues, emptySignals, params);
}

function resolveRange(
  range: RangeSpec | null,
  params: Map<string, { value: number; width: number; signed: boolean }>
): { msb: number; lsb: number; width: number } {
  if (!range) return { msb: 0, lsb: 0, width: 1 };
  const msbVal = toSigned(evalConstExpr(range.msb, params).value, 32);
  const lsbVal = toSigned(evalConstExpr(range.lsb, params).value, 32);
  const width = Math.max(1, Math.min(32, Math.abs(msbVal - lsbVal) + 1));
  return { msb: msbVal, lsb: lsbVal, width };
}

export function elaborate(ast: ModuleAst): ElaboratedModule {
  const params = new Map<string, { value: number; width: number; signed: boolean }>();
  for (const p of ast.params) {
    const ev = evalConstExpr(p.value, params);
    const rangeInfo = p.range ? resolveRange(p.range, params) : null;
    const width = rangeInfo ? rangeInfo.width : ev.width;
    const signed = p.signed || (!p.range && ev.signed);
    params.set(p.name, {
      value: maskWidth(ev.value, width),
      width,
      signed,
    });
  }

  const signals = new Map<string, SignalMeta>();
  const wireInits: Array<{ name: string; value: Expr }> = [];
  const regInits: Array<{ name: string; value: Expr }> = [];

  for (const port of ast.ports) {
    const { msb, lsb, width } = resolveRange(port.range, params);
    signals.set(port.name, {
      name: port.name,
      width,
      msb,
      lsb,
      mask: maskWidth(0xffffffff, width),
      signed: port.signed,
      isPort: true,
      direction: port.direction,
      kind: port.kind ?? 'wire',
    });
  }

  for (const sig of ast.signals) {
    const existing = signals.get(sig.name);
    const { msb, lsb, width } = resolveRange(sig.range, params);
    if (existing) {
      if (sig.direction) existing.direction = sig.direction;
      if (sig.kind === 'reg') existing.kind = 'reg';
      if (sig.signed) existing.signed = true;
      if (sig.range) {
        existing.msb = msb;
        existing.lsb = lsb;
        existing.width = width;
        existing.mask = maskWidth(0xffffffff, width);
      }
    } else {
      signals.set(sig.name, {
        name: sig.name,
        width,
        msb,
        lsb,
        mask: maskWidth(0xffffffff, width),
        signed: sig.signed,
        isPort: sig.direction !== undefined,
        direction: sig.direction,
        kind: sig.kind,
      });
    }

    if (sig.init) {
      if (sig.kind === 'wire') {
        wireInits.push({ name: sig.name, value: sig.init });
      } else {
        regInits.push({ name: sig.name, value: sig.init });
      }
    }
  }

  const unrolledAst: ModuleAst = {
    ...ast,
    alwaysBlocks: ast.alwaysBlocks.map((block) => ({
      ...block,
      body: unrollStmt(block.body, params),
    })),
  };

  return { ast: unrolledAst, params, signals, wireInits, regInits };
}

export function evalExpr(
  expr: Expr,
  values: ReadonlyMap<string, number>,
  signals: Map<string, SignalMeta>,
  params: Map<string, { value: number; width: number; signed: boolean }>
): EvalValue {
  switch (expr.type) {
    case 'number':
      return {
        value: maskWidth(expr.value, expr.width),
        width: expr.width,
        signed: expr.signed,
      };

    case 'ident': {
      const p = params.get(expr.name);
      if (p) return { value: p.value, width: p.width, signed: p.signed };
      const meta = signals.get(expr.name);
      const val = values.get(expr.name) ?? 0;
      if (meta) {
        return { value: maskWidth(val, meta.width), width: meta.width, signed: meta.signed };
      }
      return { value: val >>> 0, width: 32, signed: false };
    }

    case 'index': {
      const base = evalExpr(expr.target, values, signals, params);
      const idxEv = evalExpr(expr.index, values, signals, params);
      let lsbOffset = 0;
      if (expr.target.type === 'ident') {
        const meta = signals.get(expr.target.name);
        if (meta) lsbOffset = meta.lsb;
      }
      const bitPos = toSigned(idxEv.value, 32) - lsbOffset;
      const bit = bitPos >= 0 && bitPos < 32 ? (base.value >>> bitPos) & 1 : 0;
      return { value: bit, width: 1, signed: false };
    }

    case 'slice': {
      const base = evalExpr(expr.target, values, signals, params);
      const msbEv = evalExpr(expr.msb, values, signals, params);
      const lsbEv = evalExpr(expr.lsb, values, signals, params);
      let lsbOffset = 0;
      if (expr.target.type === 'ident') {
        const meta = signals.get(expr.target.name);
        if (meta) lsbOffset = meta.lsb;
      }
      const hi = toSigned(msbEv.value, 32) - lsbOffset;
      const lo = toSigned(lsbEv.value, 32) - lsbOffset;
      const low = Math.min(hi, lo);
      const high = Math.max(hi, lo);
      const w = Math.max(1, Math.min(32, high - low + 1));
      const shifted = low >= 0 && low < 32 ? base.value >>> low : 0;
      return { value: maskWidth(shifted, w), width: w, signed: false };
    }

    case 'concat': {
      let acc = 0n;
      let totalWidth = 0;
      for (const item of expr.items) {
        const ev = evalExpr(item, values, signals, params);
        const w = Math.max(1, ev.width);
        acc = (acc << BigInt(w)) | BigInt(maskWidth(ev.value, w));
        totalWidth += w;
      }
      const finalWidth = Math.min(32, Math.max(1, totalWidth));
      const mask = (1n << BigInt(finalWidth)) - 1n;
      return { value: Number(acc & mask) >>> 0, width: finalWidth, signed: false };
    }

    case 'repeat': {
      const countEv = evalExpr(expr.count, values, signals, params);
      const count = Math.max(0, Math.min(32, countEv.value));
      let innerAcc = 0n;
      let innerWidth = 0;
      for (const item of expr.items) {
        const ev = evalExpr(item, values, signals, params);
        const w = Math.max(1, ev.width);
        innerAcc = (innerAcc << BigInt(w)) | BigInt(maskWidth(ev.value, w));
        innerWidth += w;
      }
      let acc = 0n;
      let totalWidth = 0;
      for (let i = 0; i < count; i++) {
        acc = (acc << BigInt(innerWidth)) | innerAcc;
        totalWidth += innerWidth;
      }
      const finalWidth = Math.min(32, Math.max(1, totalWidth));
      const mask = (1n << BigInt(finalWidth)) - 1n;
      return { value: Number(acc & mask) >>> 0, width: finalWidth, signed: false };
    }

    case 'sysfn': {
      const arg = evalExpr(expr.arg, values, signals, params);
      return {
        value: arg.value,
        width: arg.width,
        signed: expr.name === '$signed',
      };
    }

    case 'unary': {
      const op = evalExpr(expr.operand, values, signals, params);
      switch (expr.op) {
        case '+':
          return op;
        case '-':
          return {
            value: maskWidth(-toSigned(op.value, op.width), op.width),
            width: op.width,
            signed: op.signed,
          };
        case '~':
          return {
            value: maskWidth(~op.value, op.width),
            width: op.width,
            signed: op.signed,
          };
        case '!':
          return { value: op.value === 0 ? 1 : 0, width: 1, signed: false };
        case '&': {
          const allOnes = maskWidth(0xffffffff, op.width);
          return { value: op.value === allOnes ? 1 : 0, width: 1, signed: false };
        }
        case '~&': {
          const allOnes = maskWidth(0xffffffff, op.width);
          return { value: op.value === allOnes ? 0 : 1, width: 1, signed: false };
        }
        case '|':
          return { value: op.value !== 0 ? 1 : 0, width: 1, signed: false };
        case '~|':
          return { value: op.value === 0 ? 1 : 0, width: 1, signed: false };
        case '^': {
          const v = op.value;
          let parity = 0;
          for (let b = 0; b < op.width; b++) {
            parity ^= (v >>> b) & 1;
          }
          return { value: parity, width: 1, signed: false };
        }
        case '~^':
        case '^~': {
          const v = op.value;
          let parity = 0;
          for (let b = 0; b < op.width; b++) {
            parity ^= (v >>> b) & 1;
          }
          return { value: parity ^ 1, width: 1, signed: false };
        }
      }
    }

    case 'binary': {
      const l = evalExpr(expr.left, values, signals, params);
      const r = evalExpr(expr.right, values, signals, params);
      const maxW = Math.min(32, Math.max(l.width, r.width));
      const bothSigned = l.signed && r.signed;

      switch (expr.op) {
        case '+': {
          const sum = (l.value + r.value) >>> 0;
          return { value: maskWidth(sum, maxW), width: maxW, signed: bothSigned };
        }
        case '-': {
          const diff = (l.value - r.value) >>> 0;
          return { value: maskWidth(diff, maxW), width: maxW, signed: bothSigned };
        }
        case '*': {
          const prod = bothSigned
            ? toSigned(l.value, l.width) * toSigned(r.value, r.width)
            : Math.imul(l.value, r.value);
          return { value: maskWidth(prod, maxW), width: maxW, signed: bothSigned };
        }
        case '/': {
          const denom = bothSigned ? toSigned(r.value, r.width) : r.value;
          if (denom === 0) return { value: 0, width: maxW, signed: bothSigned };
          const num = bothSigned ? toSigned(l.value, l.width) : l.value;
          const q = Math.trunc(num / denom);
          return { value: maskWidth(q, maxW), width: maxW, signed: bothSigned };
        }
        case '%': {
          const denom = bothSigned ? toSigned(r.value, r.width) : r.value;
          if (denom === 0) return { value: 0, width: maxW, signed: bothSigned };
          const num = bothSigned ? toSigned(l.value, l.width) : l.value;
          const rem = num % denom;
          return { value: maskWidth(rem, maxW), width: maxW, signed: bothSigned };
        }
        case '&':
          return { value: maskWidth(l.value & r.value, maxW), width: maxW, signed: bothSigned };
        case '|':
          return { value: maskWidth(l.value | r.value, maxW), width: maxW, signed: bothSigned };
        case '^':
          return { value: maskWidth(l.value ^ r.value, maxW), width: maxW, signed: bothSigned };
        case '~^':
        case '^~':
          return { value: maskWidth(~(l.value ^ r.value), maxW), width: maxW, signed: bothSigned };
        case '&&':
          return { value: l.value !== 0 && r.value !== 0 ? 1 : 0, width: 1, signed: false };
        case '||':
          return { value: l.value !== 0 || r.value !== 0 ? 1 : 0, width: 1, signed: false };
        case '==':
        case '===': {
          const eq = bothSigned
            ? toSigned(l.value, l.width) === toSigned(r.value, r.width)
            : l.value === r.value;
          return { value: eq ? 1 : 0, width: 1, signed: false };
        }
        case '!=':
        case '!==': {
          const neq = bothSigned
            ? toSigned(l.value, l.width) !== toSigned(r.value, r.width)
            : l.value !== r.value;
          return { value: neq ? 1 : 0, width: 1, signed: false };
        }
        case '<': {
          const cmp = bothSigned
            ? toSigned(l.value, l.width) < toSigned(r.value, r.width)
            : l.value < r.value;
          return { value: cmp ? 1 : 0, width: 1, signed: false };
        }
        case '<=': {
          const cmp = bothSigned
            ? toSigned(l.value, l.width) <= toSigned(r.value, r.width)
            : l.value <= r.value;
          return { value: cmp ? 1 : 0, width: 1, signed: false };
        }
        case '>': {
          const cmp = bothSigned
            ? toSigned(l.value, l.width) > toSigned(r.value, r.width)
            : l.value > r.value;
          return { value: cmp ? 1 : 0, width: 1, signed: false };
        }
        case '>=': {
          const cmp = bothSigned
            ? toSigned(l.value, l.width) >= toSigned(r.value, r.width)
            : l.value >= r.value;
          return { value: cmp ? 1 : 0, width: 1, signed: false };
        }
        case '<<':
        case '<<<': {
          const amt = r.value;
          const res = amt >= 32 ? 0 : (l.value << amt) >>> 0;
          return { value: maskWidth(res, l.width), width: l.width, signed: l.signed };
        }
        case '>>': {
          const amt = r.value;
          const res = amt >= 32 ? 0 : l.value >>> amt;
          return { value: maskWidth(res, l.width), width: l.width, signed: false };
        }
        case '>>>': {
          const amt = r.value;
          if (l.signed) {
            const s = toSigned(l.value, l.width);
            const res = amt >= 32 ? (s < 0 ? -1 : 0) : s >> amt;
            return { value: maskWidth(res, l.width), width: l.width, signed: true };
          }
          const res = amt >= 32 ? 0 : l.value >>> amt;
          return { value: maskWidth(res, l.width), width: l.width, signed: false };
        }
      }
    }

    case 'ternary': {
      const cond = evalExpr(expr.condition, values, signals, params);
      const thenEv = evalExpr(expr.thenExpr, values, signals, params);
      const elseEv = evalExpr(expr.elseExpr, values, signals, params);
      const w = Math.max(thenEv.width, elseEv.width);
      const signed = thenEv.signed && elseEv.signed;
      const chosen = cond.value !== 0 ? thenEv.value : elseEv.value;
      return { value: maskWidth(chosen, w), width: w, signed };
    }
  }
}

function lvalueWidth(
  target: LValue,
  values: Map<string, number>,
  signals: Map<string, SignalMeta>,
  params: Map<string, { value: number; width: number; signed: boolean }>
): number {
  switch (target.type) {
    case 'ident':
      return signals.get(target.name)?.width ?? 32;
    case 'index':
      return 1;
    case 'slice': {
      const hi = toSigned(evalExpr(target.msb, values, signals, params).value, 32);
      const lo = toSigned(evalExpr(target.lsb, values, signals, params).value, 32);
      return Math.max(1, Math.min(32, Math.abs(hi - lo) + 1));
    }
    case 'concat':
      return target.items.reduce(
        (sum, item) => sum + lvalueWidth(item, values, signals, params),
        0
      );
  }
}

function writeLValue(
  target: LValue,
  rhsVal: number,
  values: Map<string, number>,
  signals: Map<string, SignalMeta>,
  params: Map<string, { value: number; width: number; signed: boolean }>
): boolean {
  switch (target.type) {
    case 'ident': {
      const meta = signals.get(target.name);
      const next = meta ? maskWidth(rhsVal, meta.width) : rhsVal >>> 0;
      const prev = values.get(target.name) ?? 0;
      values.set(target.name, next);
      return next !== prev;
    }

    case 'index': {
      const meta = signals.get(target.name);
      const lsbOffset = meta ? meta.lsb : 0;
      const width = meta ? meta.width : 32;
      const bitPos = toSigned(evalExpr(target.index, values, signals, params).value, 32) - lsbOffset;
      if (bitPos < 0 || bitPos >= width) return false;
      const prev = values.get(target.name) ?? 0;
      const bitMask = (1 << bitPos) >>> 0;
      const next = (rhsVal & 1) !== 0 ? (prev | bitMask) >>> 0 : (prev & ~bitMask) >>> 0;
      values.set(target.name, maskWidth(next, width));
      return next !== prev;
    }

    case 'slice': {
      const meta = signals.get(target.name);
      const lsbOffset = meta ? meta.lsb : 0;
      const sigWidth = meta ? meta.width : 32;
      const hi = toSigned(evalExpr(target.msb, values, signals, params).value, 32) - lsbOffset;
      const lo = toSigned(evalExpr(target.lsb, values, signals, params).value, 32) - lsbOffset;
      const low = Math.min(hi, lo);
      const high = Math.max(hi, lo);
      if (high < 0 || low >= sigWidth) return false;
      const w = high - low + 1;
      const prev = BigInt(values.get(target.name) ?? 0);
      const fieldMask = ((1n << BigInt(w)) - 1n) << BigInt(low);
      const inserted = (BigInt(maskWidth(rhsVal, w)) << BigInt(low)) & fieldMask;
      const nextBig = (prev & ~fieldMask) | inserted;
      const next = maskWidth(Number(nextBig & 0xffffffffn) >>> 0, sigWidth);
      values.set(target.name, next);
      return next !== Number(prev);
    }

    case 'concat': {
      let remaining = BigInt(rhsVal >>> 0);
      let changed = false;
      for (let i = target.items.length - 1; i >= 0; i--) {
        const item = target.items[i];
        const w = lvalueWidth(item, values, signals, params);
        const mask = (1n << BigInt(w)) - 1n;
        const part = Number(remaining & mask) >>> 0;
        if (writeLValue(item, part, values, signals, params)) {
          changed = true;
        }
        remaining >>= BigInt(w);
      }
      return changed;
    }
  }
}

export interface StepOutcome {
  sample: SignalSample;
  combLoopDetected: boolean;
}

export interface SignalSnapshot {
  current: Record<string, number>;
  previous: Record<string, number>;
}

export class SimulationSession {
  readonly elaborated: ElaboratedModule;
  private values = new Map<string, number>();
  private prevValues = new Map<string, number>();
  private cycle = 0;

  constructor(elaborated: ElaboratedModule) {
    this.elaborated = elaborated;
    this.reset();
  }

  reset(): void {
    this.cycle = 0;
    this.values.clear();
    this.prevValues.clear();
    for (const [name] of this.elaborated.signals) {
      this.values.set(name, 0);
      this.prevValues.set(name, 0);
    }
    for (const init of this.elaborated.regInits) {
      const ev = evalExpr(
        init.value,
        this.values,
        this.elaborated.signals,
        this.elaborated.params
      );
      const meta = this.elaborated.signals.get(init.name);
      this.values.set(init.name, meta ? maskWidth(ev.value, meta.width) : ev.value);
    }
    this.runCombinational();
    for (const [name, val] of this.values) {
      this.prevValues.set(name, val);
    }
  }

  getSignalsSnapshot(): SignalSnapshot {
    const current: Record<string, number> = {};
    const previous: Record<string, number> = {};
    for (const [name, val] of this.values) {
      current[name] = val;
      previous[name] = this.prevValues.get(name) ?? 0;
    }
    return { current, previous };
  }

  step(inputs: BoardInputs): StepOutcome {
    for (const [name, val] of this.values) {
      this.prevValues.set(name, val);
    }

    const sanitizedInputs: BoardInputs = {
      rst_n: inputs.rst_n ? 1 : 0,
      key: maskWidth(inputs.key, 4),
      sw: maskWidth(inputs.sw, 8),
    };

    this.applyInputs(sanitizedInputs);

    // Pre-edge combinational convergence so 2-block/3-block FSM next_state sees current inputs.
    const preLoop = this.runCombinational();

    const preEdgeSnapshot = new Map(this.values);
    const blockingCommits: PendingWrite[] = [];
    const nbaCommits: PendingWrite[] = [];

    for (const block of this.elaborated.ast.alwaysBlocks) {
      if (block.sensitivity !== 'seq') continue;
      this.execSeqBlock(block, preEdgeSnapshot, blockingCommits, nbaCommits);
    }

    for (const w of blockingCommits) {
      writeLValue(w.target, w.value, this.values, this.elaborated.signals, this.elaborated.params);
    }
    for (const w of nbaCommits) {
      writeLValue(w.target, w.value, this.values, this.elaborated.signals, this.elaborated.params);
    }

    // Post-edge combinational convergence so outputs reflect newly committed registers.
    const postLoop = this.runCombinational();

    const currentCycle = this.cycle;
    this.cycle += 1;

    const outputs: BoardOutputs = {
      led: maskWidth(this.values.get('led') ?? 0, 8),
      traffic: maskWidth(this.values.get('traffic') ?? 0, 3),
      seg: maskWidth(this.values.get('seg') ?? 0, 16),
    };

    const internals: Record<string, number> = {};
    for (const [name, meta] of this.elaborated.signals) {
      if (!meta.isPort) {
        internals[name] = this.values.get(name) ?? 0;
      }
    }

    return {
      sample: {
        cycle: currentCycle,
        inputs: sanitizedInputs,
        outputs,
        internals,
      },
      combLoopDetected: preLoop || postLoop,
    };
  }

  private applyInputs(inputs: BoardInputs): void {
    this.values.set('rst_n', inputs.rst_n);
    this.values.set('key', inputs.key);
    this.values.set('sw', inputs.sw);
  }

  private runCombinational(): boolean {
    const { assigns, alwaysBlocks } = this.elaborated.ast;
    const { wireInits } = this.elaborated;
    const combBlocks = alwaysBlocks.filter((b) => b.sensitivity === 'comb');
    if (assigns.length === 0 && wireInits.length === 0 && combBlocks.length === 0) return false;

    for (let iter = 0; iter < MAX_COMB_ITERATIONS; iter++) {
      const before = new Map(this.values);

      for (const wi of wireInits) {
        const rhs = evalExpr(
          wi.value,
          this.values,
          this.elaborated.signals,
          this.elaborated.params
        );
        const meta = this.elaborated.signals.get(wi.name);
        const next = meta ? maskWidth(rhs.value, meta.width) : rhs.value >>> 0;
        this.values.set(wi.name, next);
      }

      for (const a of assigns) {
        const rhs = evalExpr(
          a.value,
          this.values,
          this.elaborated.signals,
          this.elaborated.params
        );
        writeLValue(a.target, rhs.value, this.values, this.elaborated.signals, this.elaborated.params);
      }

      for (const block of combBlocks) this.execCombStmt(block.body);

      // A block may override its own default write before the iteration settles.
      if ([...this.values].every(([name, value]) => before.get(name) === value)) return false;
    }

    return true;
  }

  private execCombStmt(stmt: Stmt): void {
    switch (stmt.type) {
      case 'empty':
        return;

      case 'block':
        for (const child of stmt.statements) this.execCombStmt(child);
        return;

      case 'assign': {
        const rhs = evalExpr(
          stmt.value,
          this.values,
          this.elaborated.signals,
          this.elaborated.params
        );
        writeLValue(stmt.target, rhs.value, this.values, this.elaborated.signals, this.elaborated.params);
        return;
      }

      case 'if': {
        const cond = evalExpr(
          stmt.condition,
          this.values,
          this.elaborated.signals,
          this.elaborated.params
        );
        if (cond.value !== 0) this.execCombStmt(stmt.thenBranch);
        else if (stmt.elseBranch) this.execCombStmt(stmt.elseBranch);
        return;
      }

      case 'case': {
        const target = evalExpr(
          stmt.expr,
          this.values,
          this.elaborated.signals,
          this.elaborated.params
        );
        for (const item of stmt.items) {
          for (const pat of item.patterns) {
            const patEv = evalExpr(
              pat,
              this.values,
              this.elaborated.signals,
              this.elaborated.params
            );
            if (matchCasePattern(stmt.kind, target.value, pat, patEv.value)) {
              this.execCombStmt(item.body);
              return;
            }
          }
        }
        if (stmt.defaultBranch) this.execCombStmt(stmt.defaultBranch);
        return;
      }

      case 'for': {
        const initEv = evalExpr(
          stmt.init,
          this.values,
          this.elaborated.signals,
          this.elaborated.params
        );
        writeLValue(
          { type: 'ident', name: stmt.varName, loc: stmt.loc },
          initEv.value,
          this.values,
          this.elaborated.signals,
          this.elaborated.params
        );
        for (let iter = 0; iter < MAX_FOR_ITERATIONS; iter++) {
          const cond = evalExpr(
            stmt.condition,
            this.values,
            this.elaborated.signals,
            this.elaborated.params
          );
          if (cond.value === 0) break;
          this.execCombStmt(stmt.body);
          this.execCombStmt(stmt.step);
        }
        return;
      }
    }
  }

  private execSeqBlock(
    block: AlwaysBlock,
    preEdgeSnapshot: Map<string, number>,
    blockingCommits: PendingWrite[],
    nbaCommits: PendingWrite[]
  ): void {
    const localEnv = new Map(preEdgeSnapshot);
    this.execSeqStmt(block.body, localEnv, blockingCommits, nbaCommits);
  }

  private execSeqStmt(
    stmt: Stmt,
    localEnv: Map<string, number>,
    blockingCommits: PendingWrite[],
    nbaCommits: PendingWrite[]
  ): void {
    switch (stmt.type) {
      case 'empty':
        return;

      case 'block':
        for (const s of stmt.statements) {
          this.execSeqStmt(s, localEnv, blockingCommits, nbaCommits);
        }
        return;

      case 'assign': {
        const rhs = evalExpr(
          stmt.value,
          localEnv,
          this.elaborated.signals,
          this.elaborated.params
        );
        if (stmt.kind === 'nonblocking') {
          nbaCommits.push({ target: stmt.target, value: rhs.value });
        } else {
          writeLValue(
            stmt.target,
            rhs.value,
            localEnv,
            this.elaborated.signals,
            this.elaborated.params
          );
          blockingCommits.push({ target: stmt.target, value: rhs.value });
        }
        return;
      }

      case 'if': {
        const cond = evalExpr(
          stmt.condition,
          localEnv,
          this.elaborated.signals,
          this.elaborated.params
        );
        if (cond.value !== 0) {
          this.execSeqStmt(stmt.thenBranch, localEnv, blockingCommits, nbaCommits);
        } else if (stmt.elseBranch) {
          this.execSeqStmt(stmt.elseBranch, localEnv, blockingCommits, nbaCommits);
        }
        return;
      }

      case 'case': {
        const target = evalExpr(
          stmt.expr,
          localEnv,
          this.elaborated.signals,
          this.elaborated.params
        );
        for (const item of stmt.items) {
          for (const pat of item.patterns) {
            const patEv = evalExpr(
              pat,
              localEnv,
              this.elaborated.signals,
              this.elaborated.params
            );
            if (matchCasePattern(stmt.kind, target.value, pat, patEv.value)) {
              this.execSeqStmt(item.body, localEnv, blockingCommits, nbaCommits);
              return;
            }
          }
        }
        if (stmt.defaultBranch) {
          this.execSeqStmt(stmt.defaultBranch, localEnv, blockingCommits, nbaCommits);
        }
        return;
      }

      case 'for': {
        const initEv = evalExpr(
          stmt.init,
          localEnv,
          this.elaborated.signals,
          this.elaborated.params
        );
        writeLValue(
          { type: 'ident', name: stmt.varName, loc: stmt.loc },
          initEv.value,
          localEnv,
          this.elaborated.signals,
          this.elaborated.params
        );
        for (let iter = 0; iter < MAX_FOR_ITERATIONS; iter++) {
          const cond = evalExpr(
            stmt.condition,
            localEnv,
            this.elaborated.signals,
            this.elaborated.params
          );
          if (cond.value === 0) break;
          this.execSeqStmt(stmt.body, localEnv, blockingCommits, nbaCommits);
          this.execSeqStmt(stmt.step, localEnv, blockingCommits, nbaCommits);
        }
        return;
      }
    }
  }
}
