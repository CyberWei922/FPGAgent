// 冻结契约：字段变更须在群内同步，由队长统一修改本文件。

// ============================================================
// 1. 虚拟 FPGA 开发板硬件接口（队长 UI <-> 队友 1 仿真器）
// ============================================================

export interface BoardInputs {
  rst_n: 0 | 1;        // 1=正常工作, 0=低电平复位
  key: number;         // 4-bit (0..15), bit0=KEY0 .. bit3=KEY3
  sw: number;          // 8-bit (0..255), bit0=SW0 .. bit7=SW7
}

export interface BoardOutputs {
  led: number;         // 8-bit (0..255), bit0=LED0 .. bit7=LED7
  traffic: number;     // 3-bit, bit2=红灯, bit1=黄灯, bit0=绿灯
  seg: number;         // 16-bit, 4个4-bit BCD/Hex数码管（高位在左）
}

export interface SignalSample {
  cycle: number;
  inputs: BoardInputs;
  outputs: BoardOutputs;
  internals: Record<string, number>; // 关键内部寄存器/状态机当前值（供示波器展示）
}

// ============================================================
// 2. 教学级 RTL-门混合网表（队友 1 生成 -> 队长 GateCanvas 渲染）
// ============================================================

export type GateKind =
  | 'INPUT'
  | 'OUTPUT'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'XOR'
  | 'MUX'
  | 'CMP'
  | 'ADD'
  | 'DFF';

export interface NetlistNode {
  id: string;
  label: string;       // 显示名，如 "KEY0" / "MUX_emergency" / "DFF_state" / "RED_LED"
  kind: GateKind;
  width: number;       // 位宽，如 1 / 4 / 8
  level: number;       // 拓扑层级：0=输入端口，逐级向右递增，用于慢动作逐级发光
  value: number;       // 当前拍数值
  changed: boolean;    // 相比上一拍是否发生跳变（驱动慢动作高光）
  sourceLine?: number; // 对应 Verilog 代码行号（点击门可高亮对应代码）
}

export interface NetlistEdge {
  id: string;
  from: string;        // 源节点 id
  to: string;          // 目标节点 id
  signalName: string;  // 导线信号名
  value: number;       // 当前导线逻辑值（>0 视为高电平发光）
  changed: boolean;    // 是否跳变（用于播放电流脉冲动画）
}

export interface NetlistGraph {
  nodes: NetlistNode[];
  edges: NetlistEdge[];
  maxLevel: number;
  narration: string;   // 底部白话信号流播报，例如："KEY0=1 → 选通紧急MUX → 触发RED_LED点亮"
}

// ============================================================
// 3. 静态 Lint 体检与确定性自测（队友 1 引擎 -> 队长 UI & 队友 2 Harness）
// ============================================================

export type LintRuleCode =
  | 'PARSE_ERROR'
  | 'PORT_MISMATCH'
  | 'SEQ_BLOCKING_ASSIGN'
  | 'COMB_NONBLOCKING_ASSIGN'
  | 'INFERRED_LATCH'
  | 'UNDRIVEN_OR_UNASSIGNED'
  | 'MULTI_DRIVER'
  | 'UNSIGNED_ARITH_SHIFT';

export interface LintIssue {
  code: LintRuleCode;
  severity: 'error' | 'warning';
  line: number;
  column?: number;
  message: string;     // 中文清晰解释
  hint: string;        // 修复建议
}

// 自测语义：先 compile + reset，再按数组顺序每条执行一次 step(inputs)（一个上升沿），
// 用该次 step 返回的 outputs 比对 expect。cycle 必须等于数组下标（从 0 开始），与 SignalSample.cycle 一致。
export interface TestVectorStep {
  cycle: number;
  inputs: BoardInputs;
  expect?: Partial<BoardOutputs>; // 只检查关心的输出字段
  note?: string;                  // 该拍检查意图，如 "按下KEY0后应强制红灯亮"
}

export interface SelfTestFailure {
  cycle: number;
  signal: keyof BoardOutputs;
  expected: number;
  actual: number;
  note?: string;
}

export interface SelfTestResult {
  passed: boolean;
  totalChecks: number;
  passedChecks: number;
  firstFailure?: SelfTestFailure;     // 首个输出失配
  firstUnstableCycle?: number;        // 首个未收敛周期，即使输出碰巧符合断言
  passedCycles: number[];             // 本次带 expect 且全部通过的周期（作为下一轮的 previousPassedCycles）
  regressedCycles: number[];          // 上一版通过、本版失败的周期（无回退警报）
  waveform: SignalSample[];           // 本次自测完整波形
}

// ============================================================
// 4. 仿真引擎统一对外接口（队友 1 在 src/engine/index.ts 导出）
// ============================================================

export interface CompileResult {
  ok: boolean;
  issues: LintIssue[];
  netlist?: NetlistGraph;
}

// compile 成功后 reset，step 的 sample.cycle 从 0 开始递增；reset 后重新从 0 计数。
// runSelfTest 必须使用独立实例，不影响当前板卡上正在运行的电路状态。
export interface RtlEngine {
  compile(code: string): CompileResult;
  reset(): void;
  step(inputs: BoardInputs): {
    sample: SignalSample;
    netlist: NetlistGraph;
  };
  runSelfTest(
    code: string,
    vectors: TestVectorStep[],
    previousPassedCycles?: number[]
  ): SelfTestResult;
}

// src/engine/index.ts 必须导出：export const createRtlEngine: RtlEngineFactory
export type RtlEngineFactory = () => RtlEngine;

// ============================================================
// 5. AI 智能体蓝图、闭环步骤与预置案例（队友 2 <-> 队长 UI）
// ============================================================

export interface PinMapping {
  port: string;        // 如 "key[0]" / "traffic[2]" / "seg"
  role: string;        // 中文功能说明，如 "紧急全红制动按钮"
}

export interface AgentBlueprint {
  title: string;
  summary: string;            // 一句话电路说明
  behaviors: string[];        // 编号行为要点列表
  pinMappings: PinMapping[];  // 虚拟板卡引脚映射表
  mermaidFsm: string;         // Mermaid stateDiagram-v2 代码
}

export type HarnessStage =
  | 'idle'
  | 'planning'
  | 'coding'
  | 'linting'
  | 'simulating'
  | 'repairing'
  | 'done'
  | 'failed';

export interface HarnessTraceEvent {
  stage: HarnessStage;
  status: 'running' | 'pass' | 'fail';
  title: string;
  detail: string;
  timestamp: number;
}

export interface DiagnosisResponse {
  level1Hint: string;         // 第1档：苏格拉底式线索（不直接给答案）
  level2Cause: string;        // 第2档：明确指出错因与对应行/波形拍
  level3PatchCode: string;    // 第3档：可一键应用的完整修复代码
  highlightLine?: number;
  highlightCycle?: number;
}

export interface BugClinicCase {
  id: string;
  title: string;              // 如 "隐蔽故障：时序块混用阻塞赋值"
  pitfallTag: string;         // 对应原项目 rtl-pitfalls 分类
  symptom: string;            // 板卡上观察到的异常现象
  buggyCode: string;          // 注入故障后的代码
  diagnosis: DiagnosisResponse;
}

export interface PresetProject {
  id: string;
  name: string;               // 如 "智能十字路口交通灯"
  prompt: string;             // 对应的自然语言描述
  blueprint: AgentBlueprint;
  verilogCode: string;
  testVectors: TestVectorStep[];
  bugs: BugClinicCase[];      // 该工程自带的故障诊所关卡
}

// ============================================================
// 6. 统一大模型调用接口（队长封装 -> 队友 2 消费）
// ============================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCallOptions {
  action: 'plan' | 'generate' | 'repair' | 'diagnose' | 'inject_bug';
  messages: ChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;       // 用户取消或超时中断
}

export interface LLMClient {
  chat(options: LLMCallOptions): Promise<{
    text: string;
    remainingQuota?: number;  // 剩余免费次数（供前端右上角提示）
  }>;
}

// ============================================================
// 7. 大模型调用统一错误（LLMClient.chat 只会抛出 LLMError）
// ============================================================

export type LLMErrorCode =
  | 'QUOTA_EXCEEDED'   // 免费额度/单 IP 每日次数用完 -> 提示改用预置案例或 BYOK
  | 'NOT_CONFIGURED'   // 服务端未配置 Key，或 BYOK/Node 模式缺少 Key
  | 'FORBIDDEN'        // 来源校验失败
  | 'TIMEOUT'          // 请求超时
  | 'ABORTED'          // 调用方主动取消
  | 'NETWORK'          // 断网 / 无法连接
  | 'UPSTREAM'         // 大模型服务端报错
  | 'BAD_RESPONSE';    // 返回内容不是预期格式

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly status?: number;

  constructor(code: LLMErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
  }
}

export function isLLMError(error: unknown): error is LLMError {
  return error instanceof LLMError;
}

// ============================================================
// 8. 智能体运行时（队友 2 在 src/agent/index.ts 导出 -> 队长 UI 消费）
// ============================================================

export interface HarnessRunOptions {
  onTrace: (event: HarnessTraceEvent) => void;
  signal?: AbortSignal;
}

export interface HarnessResult {
  ok: boolean;                     // 最终候选是否通过 Lint + 自测
  blueprint: AgentBlueprint;
  verilogCode: string;             // 无回退择优后的最佳候选
  testVectors: TestVectorStep[];
  issues: LintIssue[];
  selfTest?: SelfTestResult;       // 编译失败时为空
  repairRounds: number;            // 实际修复轮数（0..2）
}

export interface DiagnoseInput {
  code: string;
  issues: LintIssue[];
  failure?: SelfTestFailure;
  waveformSlice?: SignalSample[];  // 首个反例附近的波形切片
  blueprint?: AgentBlueprint;
}

export interface AgentRuntime {
  presets: PresetProject[];        // 零 Token 预置案例，离线可用
  runHarness(prompt: string, options: HarnessRunOptions): Promise<HarnessResult>;
  diagnose(input: DiagnoseInput): Promise<DiagnosisResponse>;
  injectBug(code: string): Promise<BugClinicCase>;
}

export interface AgentRuntimeDeps {
  llm: LLMClient;
  engine: RtlEngine;
}

// src/agent/index.ts 必须导出：export const createAgentRuntime: AgentRuntimeFactory
export type AgentRuntimeFactory = (deps: AgentRuntimeDeps) => AgentRuntime;
