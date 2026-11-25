import type {
  BoardInputs,
  CircuitMetadata,
  CompileResult,
  NetlistGraph,
  RtlEngine,
  RtlEngineFactory,
  SelfTestResult,
  SignalDescriptor,
  SignalSample,
  TestVectorStep,
} from '../types/contracts';
import type { Expr, LValue, Stmt } from './ast';
import { lintVerilog } from './linter';
import { buildNetlist, CompiledNetlist } from './netlist';
import { parseVerilog } from './parser';
import { exportVerilogTestbench, runDeterministicSelfTest } from './selftest';
import { elaborate, type ElaboratedModule, SimulationSession } from './simulator';

function collectExprIdentReads(expr: Expr, out: Set<string>): void {
  switch (expr.type) {
    case 'number':
      return;
    case 'ident':
      out.add(expr.name);
      return;
    case 'index':
      collectExprIdentReads(expr.target, out);
      collectExprIdentReads(expr.index, out);
      return;
    case 'slice':
      collectExprIdentReads(expr.target, out);
      collectExprIdentReads(expr.msb, out);
      collectExprIdentReads(expr.lsb, out);
      return;
    case 'concat':
      for (const it of expr.items) collectExprIdentReads(it, out);
      return;
    case 'repeat':
      collectExprIdentReads(expr.count, out);
      for (const it of expr.items) collectExprIdentReads(it, out);
      return;
    case 'unary':
      collectExprIdentReads(expr.operand, out);
      return;
    case 'binary':
      collectExprIdentReads(expr.left, out);
      collectExprIdentReads(expr.right, out);
      return;
    case 'ternary':
      collectExprIdentReads(expr.condition, out);
      collectExprIdentReads(expr.thenExpr, out);
      collectExprIdentReads(expr.elseExpr, out);
      return;
    case 'sysfn':
      collectExprIdentReads(expr.arg, out);
      return;
  }
}

function collectLValueTargets(lv: LValue, reads: Set<string>, writes: Set<string>): void {
  switch (lv.type) {
    case 'ident':
      writes.add(lv.name);
      return;
    case 'index':
      writes.add(lv.name);
      collectExprIdentReads(lv.index, reads);
      return;
    case 'slice':
      writes.add(lv.name);
      collectExprIdentReads(lv.msb, reads);
      collectExprIdentReads(lv.lsb, reads);
      return;
    case 'concat':
      for (const item of lv.items) collectLValueTargets(item, reads, writes);
      return;
  }
}

function collectStmtUsage(stmt: Stmt, reads: Set<string>, writes: Set<string>): void {
  switch (stmt.type) {
    case 'empty':
      return;
    case 'block':
      for (const s of stmt.statements) collectStmtUsage(s, reads, writes);
      return;
    case 'assign':
      collectLValueTargets(stmt.target, reads, writes);
      collectExprIdentReads(stmt.value, reads);
      return;
    case 'if':
      collectExprIdentReads(stmt.condition, reads);
      collectStmtUsage(stmt.thenBranch, reads, writes);
      if (stmt.elseBranch) collectStmtUsage(stmt.elseBranch, reads, writes);
      return;
    case 'case':
      collectExprIdentReads(stmt.expr, reads);
      for (const item of stmt.items) {
        for (const p of item.patterns) collectExprIdentReads(p, reads);
        collectStmtUsage(item.body, reads, writes);
      }
      if (stmt.defaultBranch) collectStmtUsage(stmt.defaultBranch, reads, writes);
      return;
    case 'for':
      collectExprIdentReads(stmt.init, reads);
      collectExprIdentReads(stmt.condition, reads);
      collectStmtUsage(stmt.step, reads, writes);
      collectStmtUsage(stmt.body, reads, writes);
      return;
  }
}

function extractCircuitMetadata(elaborated: ElaboratedModule): CircuitMetadata {
  const reads = new Set<string>();
  const writes = new Set<string>();

  for (const wi of elaborated.wireInits) {
    writes.add(wi.name);
    collectExprIdentReads(wi.value, reads);
  }
  for (const ri of elaborated.regInits) {
    writes.add(ri.name);
    collectExprIdentReads(ri.value, reads);
  }
  for (const a of elaborated.ast.assigns) {
    collectLValueTargets(a.target, reads, writes);
    collectExprIdentReads(a.value, reads);
  }
  for (const block of elaborated.ast.alwaysBlocks) {
    if (block.resetSignal) reads.add(block.resetSignal);
    collectStmtUsage(block.body, reads, writes);
  }

  const inputOrder: Array<'rst_n' | 'key' | 'sw'> = ['rst_n', 'key', 'sw'];
  const outputOrder: Array<'led' | 'traffic' | 'seg'> = ['led', 'traffic', 'seg'];

  const usedInputs = inputOrder.filter((name) => reads.has(name));
  const usedOutputs = outputOrder.filter((name) => writes.has(name));

  const internalSignals: SignalDescriptor[] = [];
  for (const meta of elaborated.signals.values()) {
    if (!meta.isPort) {
      internalSignals.push({ name: meta.name, width: meta.width });
    }
  }

  return {
    moduleName: elaborated.ast.name,
    usedInputs,
    usedOutputs,
    internalSignals,
  };
}

function createEmptyNetlist(narration = '等待编译有效 Verilog 代码'): NetlistGraph {
  return {
    nodes: [],
    edges: [],
    maxLevel: 0,
    narration,
    levelNarrations: [narration],
  };
}

export const createRtlEngine: RtlEngineFactory = (): RtlEngine => {
  let session: SimulationSession | null = null;
  let compiledNetlist: CompiledNetlist | null = null;

  return {
    compile(code: string): CompileResult {
      try {
        const parsed = parseVerilog(code);
        if (!parsed.ast || parsed.errors.length > 0) {
          session = null;
          compiledNetlist = null;
          return {
            ok: false,
            issues: parsed.errors,
          };
        }

        const elaborated = elaborate(parsed.ast);
        const issues = lintVerilog(elaborated);
        const metadata = extractCircuitMetadata(elaborated);
        const hasBlockingError = issues.some((i) => i.severity === 'error');

        const nextSession = new SimulationSession(elaborated);
        const nextNetlist = buildNetlist(elaborated);
        const initialGraph = nextNetlist.evaluate(nextSession.getSignalsSnapshot());

        if (hasBlockingError) {
          session = null;
          compiledNetlist = null;
          return {
            ok: false,
            issues,
            netlist: initialGraph,
            metadata,
          };
        }

        session = nextSession;
        compiledNetlist = nextNetlist;

        return {
          ok: true,
          issues,
          netlist: initialGraph,
          metadata,
        };
      } catch (err) {
        session = null;
        compiledNetlist = null;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          issues: [
            {
              code: 'PARSE_ERROR',
              severity: 'error',
              line: 1,
              message: `编译异常：${msg}`,
              hint: '请检查 Verilog 语法及信号位宽声明是否完整。',
            },
          ],
        };
      }
    },

    reset(): void {
      session?.reset();
    },

    step(inputs: BoardInputs): { sample: SignalSample; netlist: NetlistGraph } {
      if (!session || !compiledNetlist) {
        return {
          sample: {
            cycle: 0,
            inputs,
            outputs: { led: 0, traffic: 0, seg: 0 },
            internals: {},
          },
          netlist: createEmptyNetlist('尚未编译有效模块'),
        };
      }

      const { sample, combLoopDetected } = session.step(inputs);
      const netlist = compiledNetlist.evaluate(session.getSignalsSnapshot());
      if (combLoopDetected) {
        netlist.narration = `[组合环路保护] ${netlist.narration}`;
      }

      return { sample, netlist };
    },

    runSelfTest(
      code: string,
      vectors: TestVectorStep[],
      previousPassedCycles?: number[]
    ): SelfTestResult {
      return runDeterministicSelfTest(code, vectors, previousPassedCycles);
    },

    exportTestbench(code: string, vectors: TestVectorStep[]): string {
      return exportVerilogTestbench(code, vectors);
    },
  };
};

export const rtlEngine: RtlEngine = createRtlEngine();

export { parseVerilog } from './parser';
export { elaborate, SimulationSession } from './simulator';
export { buildNetlist, CompiledNetlist } from './netlist';
export { lintVerilog, BOARD_PORT_SPECS } from './linter';
export { runDeterministicSelfTest, exportVerilogTestbench } from './selftest';
export {
  tokenizeVerilogForHighlight,
  type HighlightedLine,
  type HighlightToken,
  type HighlightTokenKind,
} from './highlight';
export type * from './ast';
