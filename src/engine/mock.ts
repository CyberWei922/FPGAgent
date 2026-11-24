// M0 占位实现：不解析 Verilog，只按固定交通灯行为模拟，供前端联调。队友 1 用真实引擎替换。
import type {
  BoardInputs,
  BoardOutputs,
  CompileResult,
  GateKind,
  LintIssue,
  NetlistEdge,
  NetlistGraph,
  NetlistNode,
  RtlEngine,
  SelfTestFailure,
  SelfTestResult,
  SignalSample,
  TestVectorStep,
} from '../types/contracts';

const S_RED = 0;
const S_GREEN = 1;
const S_YELLOW = 2;
const DURATION = { [S_RED]: 5, [S_GREEN]: 4, [S_YELLOW]: 1 } as Record<number, number>;
const NEXT = { [S_RED]: S_GREEN, [S_GREEN]: S_YELLOW, [S_YELLOW]: S_RED } as Record<number, number>;
const STATE_NAME = ['RED', 'GREEN', 'YELLOW'];

interface MockState {
  state: number;
  timer: number;
  heartbeat: number;
}

const resetState = (): MockState => ({ state: S_RED, timer: DURATION[S_RED], heartbeat: 0 });

type NodeSpec = [id: string, label: string, kind: GateKind, width: number, level: number];
const NODE_SPECS: NodeSpec[] = [
  ['key0', 'KEY0', 'INPUT', 1, 0],
  ['rst_n', 'RST_N', 'INPUT', 1, 0],
  ['not_key0', 'NOT_key0', 'NOT', 1, 1],
  ['dff_state', 'DFF_state', 'DFF', 2, 1],
  ['dff_timer', 'DFF_timer', 'DFF', 4, 1],
  ['cmp_red', 'CMP_is_red', 'CMP', 1, 2],
  ['cmp_green', 'CMP_is_green', 'CMP', 1, 2],
  ['cmp_yellow', 'CMP_is_yellow', 'CMP', 1, 2],
  ['cmp_last', 'CMP_timer_last', 'CMP', 1, 2],
  ['add_dec', 'ADD_timer_dec', 'ADD', 4, 2],
  ['or_red', 'OR_red', 'OR', 1, 3],
  ['and_green', 'AND_green', 'AND', 1, 3],
  ['and_yellow', 'AND_yellow', 'AND', 1, 3],
  ['mux_next', 'MUX_next_state', 'MUX', 2, 3],
  ['out_red', 'RED_LED', 'OUTPUT', 1, 4],
  ['out_green', 'GREEN_LED', 'OUTPUT', 1, 4],
  ['out_yellow', 'YELLOW_LED', 'OUTPUT', 1, 4],
  ['out_seg', 'SEG', 'OUTPUT', 16, 4],
];

const EDGE_SPECS: [from: string, to: string][] = [
  ['key0', 'not_key0'],
  ['key0', 'or_red'],
  ['rst_n', 'dff_state'],
  ['rst_n', 'dff_timer'],
  ['dff_state', 'cmp_red'],
  ['dff_state', 'cmp_green'],
  ['dff_state', 'cmp_yellow'],
  ['dff_state', 'mux_next'],
  ['dff_timer', 'cmp_last'],
  ['dff_timer', 'add_dec'],
  ['dff_timer', 'out_seg'],
  ['cmp_last', 'mux_next'],
  ['cmp_red', 'or_red'],
  ['cmp_green', 'and_green'],
  ['cmp_yellow', 'and_yellow'],
  ['not_key0', 'and_green'],
  ['not_key0', 'and_yellow'],
  ['or_red', 'out_red'],
  ['and_green', 'out_green'],
  ['and_yellow', 'out_yellow'],
  ['mux_next', 'dff_state'],
  ['add_dec', 'dff_timer'],
];

function nodeValues(s: MockState, inputs: BoardInputs): Record<string, number> {
  const key0 = inputs.key & 1;
  const isRed = +(s.state === S_RED);
  const isGreen = +(s.state === S_GREEN);
  const isYellow = +(s.state === S_YELLOW);
  const last = +(s.timer === 1);
  return {
    key0,
    rst_n: inputs.rst_n,
    not_key0: 1 - key0,
    dff_state: s.state,
    dff_timer: s.timer,
    cmp_red: isRed,
    cmp_green: isGreen,
    cmp_yellow: isYellow,
    cmp_last: last,
    add_dec: (s.timer - 1) & 0xf,
    or_red: key0 | isRed,
    and_green: isGreen & (1 - key0),
    and_yellow: isYellow & (1 - key0),
    mux_next: last ? NEXT[s.state] : s.state,
    out_red: key0 | isRed,
    out_green: isGreen & (1 - key0),
    out_yellow: isYellow & (1 - key0),
    out_seg: s.timer,
  };
}

function outputsOf(s: MockState, inputs: BoardInputs): BoardOutputs {
  const key0 = inputs.key & 1;
  const traffic = key0 || s.state === S_RED ? 0b100 : s.state === S_GREEN ? 0b001 : 0b010;
  return { led: (s.heartbeat << 7) | (inputs.sw & 0x7f), traffic, seg: s.timer & 0xf };
}

function narrate(s: MockState, inputs: BoardInputs): string {
  if (inputs.rst_n === 0) return 'RST_N=0 → DFF_state/DFF_timer 复位 → RED_LED 点亮，倒计时回到 5';
  if (inputs.key & 1) return 'KEY0=1 → OR_red 被直接选通 → RED_LED 点亮（紧急全红），NOT_key0 关断绿/黄灯';
  const name = STATE_NAME[s.state];
  return `DFF_state=${name} → CMP_is_${name.toLowerCase()} 输出 1 → ${name}_LED 点亮；DFF_timer=${s.timer} → 数码管显示 ${s.timer}`;
}

function buildNetlist(values: Record<string, number>, prev: Record<string, number> | null, narration: string): NetlistGraph {
  const nodes: NetlistNode[] = NODE_SPECS.map(([id, label, kind, width, level]) => ({
    id,
    label,
    kind,
    width,
    level,
    value: values[id],
    changed: prev !== null && prev[id] !== values[id],
  }));
  const edges: NetlistEdge[] = EDGE_SPECS.map(([from, to]) => ({
    id: `${from}->${to}`,
    from,
    to,
    signalName: from,
    value: values[from],
    changed: prev !== null && prev[from] !== values[from],
  }));
  return { nodes, edges, maxLevel: 4, narration };
}

function mockLint(code: string): LintIssue[] {
  if (!code.trim()) {
    return [{ code: 'PARSE_ERROR', severity: 'error', line: 1, message: '代码为空', hint: '请输入 module top 定义' }];
  }
  if (!/module\s+top\b/.test(code)) {
    return [
      {
        code: 'PORT_MISMATCH',
        severity: 'error',
        line: 1,
        message: '未找到顶层模块 top',
        hint: '顶层模块必须命名为 top 并使用统一板卡端口',
      },
    ];
  }
  return [];
}

export function createMockRtlEngine(): RtlEngine {
  let s = resetState();
  let cycle = 0;
  let prevValues: Record<string, number> | null = null;

  const engine: RtlEngine = {
    compile(code: string): CompileResult {
      const issues = mockLint(code);
      const ok = !issues.some((i) => i.severity === 'error');
      engine.reset();
      const idle: BoardInputs = { rst_n: 1, key: 0, sw: 0 };
      return {
        ok,
        issues,
        netlist: ok ? buildNetlist(nodeValues(s, idle), null, '电路已加载，等待时钟') : undefined,
      };
    },

    reset() {
      s = resetState();
      cycle = 0;
      prevValues = null;
    },

    step(inputs: BoardInputs) {
      if (inputs.rst_n === 0) {
        s = resetState();
      } else {
        const next: MockState = { ...s, heartbeat: s.heartbeat ^ 1 };
        if (inputs.key & 1) {
          next.state = S_RED;
          next.timer = DURATION[S_RED];
        } else if (s.timer === 1) {
          next.state = NEXT[s.state];
          next.timer = DURATION[next.state];
        } else {
          next.timer = s.timer - 1;
        }
        s = next;
      }
      const sample: SignalSample = {
        cycle: cycle++,
        inputs: { ...inputs },
        outputs: outputsOf(s, inputs),
        internals: { state: s.state, timer: s.timer },
      };
      const values = nodeValues(s, inputs);
      const netlist = buildNetlist(values, prevValues, narrate(s, inputs));
      prevValues = values;
      return { sample, netlist };
    },

    runSelfTest(code: string, vectors: TestVectorStep[], previousPassedCycles: number[] = []): SelfTestResult {
      const sim = createMockRtlEngine();
      const compiled = sim.compile(code);
      if (!compiled.ok) {
        return { passed: false, totalChecks: 0, passedChecks: 0, passedCycles: [], regressedCycles: [], waveform: [] };
      }
      const waveform: SignalSample[] = [];
      const passedCycles: number[] = [];
      const failedCycles = new Set<number>();
      let totalChecks = 0;
      let passedChecks = 0;
      let firstFailure: SelfTestFailure | undefined;

      for (const vec of vectors) {
        const { sample } = sim.step(vec.inputs);
        waveform.push(sample);
        if (!vec.expect) continue;
        let cycleOk = true;
        for (const [signal, expected] of Object.entries(vec.expect) as [keyof BoardOutputs, number][]) {
          totalChecks++;
          const actual = sample.outputs[signal];
          if (actual === expected) {
            passedChecks++;
          } else {
            cycleOk = false;
            firstFailure ??= { cycle: sample.cycle, signal, expected, actual, note: vec.note };
          }
        }
        if (cycleOk) passedCycles.push(sample.cycle);
        else failedCycles.add(sample.cycle);
      }

      return {
        passed: totalChecks === passedChecks,
        totalChecks,
        passedChecks,
        firstFailure,
        passedCycles,
        regressedCycles: previousPassedCycles.filter((c) => failedCycles.has(c)),
        waveform,
      };
    },
  };
  return engine;
}
