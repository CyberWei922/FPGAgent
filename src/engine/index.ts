import type {
  BoardInputs,
  CompileResult,
  NetlistGraph,
  RtlEngine,
  RtlEngineFactory,
  SelfTestResult,
  SignalSample,
  TestVectorStep,
} from '../types/contracts';
import { lintVerilog } from './linter';
import { buildNetlist, CompiledNetlist } from './netlist';
import { parseVerilog } from './parser';
import { runDeterministicSelfTest } from './selftest';
import { elaborate, SimulationSession } from './simulator';

function createEmptyNetlist(narration = '等待编译有效 Verilog 代码'): NetlistGraph {
  return {
    nodes: [],
    edges: [],
    maxLevel: 0,
    narration,
  };
}

export const createRtlEngine: RtlEngineFactory = (): RtlEngine => {
  let session: SimulationSession | null = null;
  let compiledNetlist: CompiledNetlist | null = null;

  return {
    compile(code: string): CompileResult {
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
        };
      }

      session = nextSession;
      compiledNetlist = nextNetlist;

      return {
        ok: true,
        issues,
        netlist: initialGraph,
      };
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
  };
};

export const rtlEngine: RtlEngine = createRtlEngine();

export { parseVerilog } from './parser';
export { elaborate, SimulationSession } from './simulator';
export { buildNetlist, CompiledNetlist } from './netlist';
export { lintVerilog, BOARD_PORT_SPECS } from './linter';
export { runDeterministicSelfTest } from './selftest';
export type * from './ast';
