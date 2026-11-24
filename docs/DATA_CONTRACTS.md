# 统一数据契约（`src/types/contracts.ts` 设计稿）

> **协同铁律**：队长在 M0 阶段将本文件正式落盘为 `src/types/contracts.ts` 并合并进 `main` 后，三位成员围绕以下 TypeScript 接口完全并行开发。任何字段变更必须在群内同步并由队长统一修改 `contracts.ts`。

```ts
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
  firstFailure?: SelfTestFailure;     // 首个反例（用于波形红框标出 + 喂给 AI 诊断）
  regressedCycles: number[];          // 相比上一版发生“改坏”的周期（无回退警报）
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
}

export interface LLMClient {
  chat(options: LLMCallOptions): Promise<{
    text: string;
    remainingQuota?: number;  // 剩余免费次数（供前端右上角提示）
  }>;
}
```
