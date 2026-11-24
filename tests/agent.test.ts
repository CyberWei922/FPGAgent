// 队友 2：AgentRuntime 单元测试。全部使用 Mock LLM 与 RtlEngine 替身，不依赖队友 1 的真实引擎。
import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/agent';
import {
  ACTION_SYSTEM_PROMPTS,
  buildGenerateMessages,
  buildPlanMessages,
  buildRepairMessages,
  parseCodeResponse,
  parseDiagnosisResponse,
  parsePlanResponse,
} from '../src/agent/prompts';
import { LLMError } from '../src/types/contracts';
import type {
  HarnessTraceEvent,
  LLMCallOptions,
  LLMClient,
  LintIssue,
  RtlEngine,
  SelfTestResult,
  SignalSample,
  TestVectorStep,
} from '../src/types/contracts';

// ============================================================
// 测试替身
// ============================================================

type Action = LLMCallOptions['action'];

function createStubLLM(handlers: Partial<Record<Action, (options: LLMCallOptions) => string | Promise<string>>>) {
  const calls: LLMCallOptions[] = [];
  const llm: LLMClient = {
    async chat(options: LLMCallOptions) {
      calls.push(options);
      const handler = handlers[options.action];
      if (!handler) throw new Error(`测试未提供 ${options.action} 的响应`);
      return { text: await handler(options) };
    },
  };
  return { llm, calls };
}

interface EngineScript {
  compileOk?: (code: string) => boolean;
  issues?: (code: string) => LintIssue[];
  selfTest?: (code: string, vectors: TestVectorStep[], previous?: number[]) => Partial<SelfTestResult>;
}

function createStubEngine(script: EngineScript): RtlEngine {
  return {
    compile(code: string) {
      const issues = script.issues?.(code) ?? [];
      const ok = script.compileOk ? script.compileOk(code) : true;
      return { ok, issues };
    },
    reset() {
      // 测试替身无需复位
    },
    step() {
      throw new Error('测试引擎不负责单步仿真');
    },
    runSelfTest(code, vectors, previousPassedCycles) {
      const expectCount = vectors.filter((v) => v.expect).length;
      const partial = script.selfTest?.(code, vectors, previousPassedCycles) ?? { passed: true };
      const passedCycles =
        partial.passedCycles ?? (partial.passed ? vectors.filter((v) => v.expect).map((v) => v.cycle) : []);
      return {
        passed: partial.passed ?? false,
        totalChecks: partial.totalChecks ?? expectCount,
        passedChecks: partial.passedChecks ?? (partial.passed ? expectCount : 0),
        firstFailure: partial.firstFailure,
        passedCycles,
        regressedCycles: partial.regressedCycles ?? [],
        waveform: partial.waveform ?? [],
      };
    },
  };
}

// ============================================================
// 固定数据
// ============================================================

const BLUEPRINT = {
  title: '测试电路',
  summary: '用于单元测试的蓝图',
  behaviors: ['复位后输出清零', '按下 KEY0 后 LED0 点亮'],
  pinMappings: [{ port: 'key[0]', role: '测试按键' }],
  mermaidFsm: 'stateDiagram-v2\n    [*] --> IDLE\n    IDLE --> RUN: KEY0',
};

const VECTORS: TestVectorStep[] = [
  { cycle: 0, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0 }, note: '复位' },
  { cycle: 1, inputs: { rst_n: 1, key: 1, sw: 0 }, expect: { led: 1 }, note: '按键' },
];

const PLAN_JSON = JSON.stringify({ blueprint: BLUEPRINT, testVectors: VECTORS });
const PLAN_FENCED = `好的，规划如下：\n\`\`\`json\n${PLAN_JSON}\n\`\`\``;

const CODE_A = 'module top();\n  // candidate A\nendmodule';
const CODE_B = 'module top();\n  // candidate B\nendmodule';
const CODE_BAD_1 = 'module top();\n  // BAD1\nendmodule';
const CODE_BAD_2 = 'module top();\n  // BAD2\nendmodule';
const CODE_BAD_3 = 'module top();\n  // BAD3\nendmodule';
const badCode = (code: string) => /BAD/.test(code);

const LINT_ERROR: LintIssue = {
  code: 'SEQ_BLOCKING_ASSIGN',
  severity: 'error',
  line: 12,
  message: '时序块使用了阻塞赋值',
  hint: '改为非阻塞赋值 <=',
};

function sample(cycle: number): SignalSample {
  return {
    cycle,
    inputs: { rst_n: 1, key: 0, sw: 0 },
    outputs: { led: 0, traffic: 0, seg: 0 },
    internals: {},
  };
}

function failingSelfTest(failureCycle: number, passedCycles: number[], regressedCycles: number[] = []) {
  return {
    passed: false,
    totalChecks: 2,
    passedChecks: passedCycles.length,
    passedCycles,
    regressedCycles,
    firstFailure: { cycle: failureCycle, signal: 'led' as const, expected: 1, actual: 0 },
    waveform: Array.from({ length: 12 }, (_, index) => sample(index)),
  };
}

function expectBadResponse(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).code).toBe('BAD_RESPONSE');
    return;
  }
  throw new Error('预期抛出 LLMError(BAD_RESPONSE)，但没有抛出');
}

// ============================================================
// 预置案例
// ============================================================

describe('预置案例', () => {
  const runtime = createAgentRuntime({ llm: createStubLLM({}).llm, engine: createStubEngine({}) });

  it('提供 5 个零 Token 案例，字段完整且互不重复', () => {
    expect(runtime.presets).toHaveLength(5);
    expect(new Set(runtime.presets.map((p) => p.id)).size).toBe(5);
    for (const preset of runtime.presets) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.prompt.length).toBeGreaterThan(0);
      expect(preset.verilogCode).toMatch(/module\s+top\b/);
      expect(preset.blueprint.mermaidFsm).toMatch(/^stateDiagram-v2/);
      expect(preset.blueprint.behaviors.length).toBeGreaterThan(0);
      expect(preset.blueprint.pinMappings.length).toBeGreaterThan(0);
      expect(preset.testVectors.length).toBeGreaterThanOrEqual(6);
      preset.testVectors.forEach((vector, index) => {
        expect(vector.cycle).toBe(index);
        expect([0, 1]).toContain(vector.inputs.rst_n);
        expect(vector.inputs.key).toBeGreaterThanOrEqual(0);
        expect(vector.inputs.key).toBeLessThanOrEqual(15);
        expect(vector.inputs.sw).toBeGreaterThanOrEqual(0);
        expect(vector.inputs.sw).toBeLessThanOrEqual(255);
      });
      expect(preset.testVectors[0].inputs.rst_n).toBe(0);
    }
  });

  it('每个案例都有 1-2 个故障关卡，修复代码等于标准代码', () => {
    const allBugs = runtime.presets.flatMap((p) => p.bugs);
    expect(allBugs.length).toBeGreaterThanOrEqual(6);
    expect(allBugs.length).toBeLessThanOrEqual(8);
    expect(new Set(allBugs.map((b) => b.id)).size).toBe(allBugs.length);
    for (const preset of runtime.presets) {
      expect(preset.bugs.length).toBeGreaterThanOrEqual(1);
      for (const bug of preset.bugs) {
        expect(bug.title.length).toBeGreaterThan(0);
        expect(bug.pitfallTag.length).toBeGreaterThan(0);
        expect(bug.symptom.length).toBeGreaterThan(0);
        expect(bug.buggyCode).toMatch(/module\s+top\b/);
        expect(bug.buggyCode).not.toBe(preset.verilogCode);
        expect(bug.diagnosis.level1Hint.length).toBeGreaterThan(0);
        expect(bug.diagnosis.level2Cause.length).toBeGreaterThan(0);
        expect(bug.diagnosis.level3PatchCode).toMatch(/module\s+top\b/);
        if (bug.diagnosis.highlightLine !== undefined) {
          expect(bug.diagnosis.highlightLine).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});

// ============================================================
// JSON 解析与容错
// ============================================================

describe('提示词与 JSON 解析', () => {
  it('五个动作都有 System Prompt', () => {
    expect(Object.keys(ACTION_SYSTEM_PROMPTS).sort()).toEqual([
      'diagnose',
      'generate',
      'inject_bug',
      'plan',
      'repair',
    ]);
  });

  it('plan / generate 提示词包含板卡接口与 Verilog 子集约束', () => {
    const planMessages = buildPlanMessages('做个交通灯');
    expect(planMessages[0].content).toContain('testVectors');
    expect(planMessages[0].content).toContain('module top');
    expect(planMessages[1].content).toContain('做个交通灯');

    const generateMessages = buildGenerateMessages(BLUEPRINT, VECTORS);
    expect(generateMessages[0].content).toContain('非阻塞');
    expect(generateMessages[1].content).toContain('测试电路');
  });

  it('解析带 Markdown 围栏和解释文字的规划 JSON', () => {
    const parsed = parsePlanResponse(PLAN_FENCED);
    expect(parsed.blueprint.title).toBe('测试电路');
    expect(parsed.testVectors).toHaveLength(2);
    expect(parsed.testVectors[1].cycle).toBe(1);
  });

  it('规划结果允许直接返回 blueprint 字段（无外层包装）', () => {
    const parsed = parsePlanResponse(JSON.stringify({ ...BLUEPRINT, testVectors: VECTORS }));
    expect(parsed.blueprint.behaviors).toHaveLength(2);
  });

  it('自测向量 cycle 归一化为数组下标，输入范围被裁剪', () => {
    const parsed = parsePlanResponse(
      JSON.stringify({
        blueprint: BLUEPRINT,
        testVectors: [
          { cycle: 99, inputs: { rst_n: 0, key: 99, sw: 300 }, expect: { led: 999 } },
          { cycle: 7, inputs: {}, expect: { traffic: 9 } },
        ],
      }),
    );
    expect(parsed.testVectors[0].cycle).toBe(0);
    expect(parsed.testVectors[0].inputs.key).toBe(15);
    expect(parsed.testVectors[0].inputs.sw).toBe(255);
    expect(parsed.testVectors[0].expect?.led).toBe(255);
    expect(parsed.testVectors[1].inputs.rst_n).toBe(1);
    expect(parsed.testVectors[1].expect?.traffic).toBe(7);
  });

  it('生成结果可解析 JSON、围栏与纯 Verilog 文本', () => {
    expect(parseCodeResponse(JSON.stringify({ code: CODE_A })).code).toBe(CODE_A);
    expect(parseCodeResponse(`\`\`\`verilog\n${CODE_B}\n\`\`\``).code).toBe(CODE_B);
    expect(parseCodeResponse(CODE_BAD_1).code).toBe(CODE_BAD_1);
  });

  it('生成结果没有 module 声明时抛出 BAD_RESPONSE', () => {
    expectBadResponse(() => parseCodeResponse(JSON.stringify({ code: '这不是 Verilog' })));
  });

  it('规划输出无法解析时抛出 BAD_RESPONSE', () => {
    expectBadResponse(() => parsePlanResponse('抱歉，我无法完成这个需求。'));
  });

  it('诊断结果缺少三档字段时抛出 BAD_RESPONSE', () => {
    expectBadResponse(() => parseDiagnosisResponse(JSON.stringify({ level1Hint: '再看一眼' })));
  });

  it('repair 提示词携带首个反例与波形切片', () => {
    const messages = buildRepairMessages({
      code: CODE_A,
      issues: [LINT_ERROR],
      selfTest: failingSelfTest(1, [0]),
      blueprint: BLUEPRINT,
      testVectors: VECTORS,
    });
    expect(messages[1].content).toContain('"firstFailure"');
    expect(messages[1].content).toContain('"cycle": 1');
    expect(messages[1].content).toContain('candidate A');
  });
});

// ============================================================
// Harness 闭环
// ============================================================

describe('Harness 闭环', () => {
  it('规划→生成→体检→自测一次通过，不触发修复', async () => {
    const { llm, calls } = createStubLLM({
      plan: () => PLAN_FENCED,
      generate: () => JSON.stringify({ code: CODE_A }),
    });
    const engine = createStubEngine({ selfTest: () => ({ passed: true }) });
    const events: HarnessTraceEvent[] = [];

    const result = await createAgentRuntime({ llm, engine }).runHarness('做个 LED 测试电路', {
      onTrace: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.repairRounds).toBe(0);
    expect(result.verilogCode).toBe(CODE_A);
    expect(calls.map((call) => call.action)).toEqual(['plan', 'generate']);
    expect(calls.every((call) => call.jsonMode === true)).toBe(true);
    expect(result.blueprint.title).toBe('测试电路');
    expect(result.selfTest?.passed).toBe(true);

    const stages = events.map((event) => event.stage);
    expect(stages[0]).toBe('planning');
    expect(stages).toContain('coding');
    expect(stages).toContain('linting');
    expect(stages).toContain('simulating');
    expect(stages.at(-1)).toBe('done');
    for (const event of events) {
      expect(typeof event.title).toBe('string');
      expect(typeof event.detail).toBe('string');
      expect(typeof event.timestamp).toBe('number');
    }
  });

  it('Lint 失败后修复一轮并通过', async () => {
    const { llm, calls } = createStubLLM({
      plan: () => PLAN_JSON,
      generate: () => JSON.stringify({ code: CODE_BAD_1 }),
      repair: () => JSON.stringify({ code: CODE_A, explanation: '改成了非阻塞赋值' }),
    });
    const engine = createStubEngine({ compileOk: (code) => !badCode(code), issues: () => [LINT_ERROR] });
    const events: HarnessTraceEvent[] = [];

    const result = await createAgentRuntime({ llm, engine }).runHarness('做个测试电路', {
      onTrace: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.repairRounds).toBe(1);
    expect(result.verilogCode).toBe(CODE_A);
    expect(calls.map((call) => call.action)).toEqual(['plan', 'generate', 'repair']);
    expect(events.some((event) => event.stage === 'repairing' && event.status === 'pass')).toBe(true);
  });

  it('连续失败时最多修复 2 轮，返回无回退的最佳候选', async () => {
    const repairs = [CODE_BAD_2, CODE_BAD_3];
    const { llm, calls } = createStubLLM({
      plan: () => PLAN_JSON,
      generate: () => JSON.stringify({ code: CODE_BAD_1 }),
      repair: () => JSON.stringify({ code: repairs.shift() ?? CODE_BAD_3 }),
    });
    const engine = createStubEngine({ compileOk: (code) => !badCode(code), issues: () => [LINT_ERROR] });
    const events: HarnessTraceEvent[] = [];

    const result = await createAgentRuntime({ llm, engine }).runHarness('做个测试电路', {
      onTrace: (event) => events.push(event),
    });

    expect(result.ok).toBe(false);
    expect(result.repairRounds).toBe(2);
    expect(result.verilogCode).toBe(CODE_BAD_1);
    expect(result.issues).toHaveLength(1);
    expect(result.selfTest).toBeUndefined();
    expect(calls.filter((call) => call.action === 'repair')).toHaveLength(2);
    expect(events.at(-1)?.stage).toBe('failed');
  });

  it('无回退择优：保留先前通过周期更多的候选，并把 passedCycles 传给下一轮', async () => {
    const previousValues: (number[] | undefined)[] = [];
    const { llm } = createStubLLM({
      plan: () => PLAN_JSON,
      generate: () => JSON.stringify({ code: CODE_A }),
      repair: () => JSON.stringify({ code: CODE_B }),
    });
    const engine = createStubEngine({
      selfTest: (code, _vectors, previous) => {
        previousValues.push(previous);
        return code.includes('candidate A') ? failingSelfTest(1, [0]) : failingSelfTest(0, [1], [0]);
      },
    });

    const result = await createAgentRuntime({ llm, engine }).runHarness('做个测试电路', {
      onTrace: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.repairRounds).toBe(2);
    expect(result.verilogCode).toBe(CODE_A);
    expect(result.selfTest?.passedCycles).toEqual([0]);
    expect(previousValues[0]).toBeUndefined();
    expect(previousValues[1]).toEqual([0]);
    expect(previousValues[2]).toEqual([0]);
  });

  it('修复额度耗尽时保留候选和反例供用户检查', async () => {
    const { llm } = createStubLLM({
      plan: () => PLAN_JSON,
      generate: () => JSON.stringify({ code: CODE_A }),
      repair: () => { throw new LLMError('QUOTA_EXCEEDED', '今日免费额度已用完'); },
    });
    const events: HarnessTraceEvent[] = [];
    const engine = createStubEngine({ selfTest: () => failingSelfTest(1, [0]) });
    const result = await createAgentRuntime({ llm, engine }).runHarness('做个测试电路', { onTrace: (event) => events.push(event) });

    expect(result).toMatchObject({ ok: false, verilogCode: CODE_A, selfTest: { firstFailure: { cycle: 1 } } });
    expect(events).toContainEqual(expect.objectContaining({ stage: 'repairing', status: 'fail', detail: '今日免费额度已用完' }));
  });

  it('开始前已取消：抛出 ABORTED 且不调用模型', async () => {
    const { llm, calls } = createStubLLM({});
    const controller = new AbortController();
    controller.abort();

    await expect(
      createAgentRuntime({ llm, engine: createStubEngine({}) }).runHarness('做个测试电路', {
        onTrace: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(calls).toHaveLength(0);
  });

  it('规划阶段被取消：停止后续生成', async () => {
    const controller = new AbortController();
    const { llm, calls } = createStubLLM({
      plan: () => {
        controller.abort();
        return PLAN_JSON;
      },
    });

    await expect(
      createAgentRuntime({ llm, engine: createStubEngine({}) }).runHarness('做个测试电路', {
        onTrace: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(calls.map((call) => call.action)).toEqual(['plan']);
  });
});

// ============================================================
// 教学诊断与故障注入
// ============================================================

describe('诊断与故障注入', () => {
  it('diagnose 解析三档苏格拉底提示', async () => {
    const { llm, calls } = createStubLLM({
      diagnose: () =>
        `\`\`\`json\n${JSON.stringify({
          level1Hint: '这个寄存器在复位时是什么值？',
          level2Cause: '第 12 行的时序块用了阻塞赋值。',
          level3PatchCode: CODE_A,
          highlightLine: 12,
          highlightCycle: 3,
        })}\n\`\`\``,
    });

    const diagnosis = await createAgentRuntime({ llm, engine: createStubEngine({}) }).diagnose({
      code: CODE_BAD_1,
      issues: [LINT_ERROR],
      failure: { cycle: 3, signal: 'led', expected: 1, actual: 0 },
    });

    expect(diagnosis.level1Hint).toContain('复位');
    expect(diagnosis.level3PatchCode).toBe(CODE_A);
    expect(diagnosis.highlightLine).toBe(12);
    expect(diagnosis.highlightCycle).toBe(3);
    expect(calls[0].action).toBe('diagnose');
    expect(calls[0].jsonMode).toBe(true);
  });

  it('injectBug 生成故障关卡，缺失的修复代码回退为原始代码', async () => {
    const { llm, calls } = createStubLLM({
      inject_bug: () =>
        JSON.stringify({
          title: '隐蔽故障：时序块混用阻塞赋值',
          pitfallTag: 'blocking-in-sequential',
          symptom: '倒计时偶发错拍',
          buggyCode: CODE_BAD_2,
          diagnosis: { level1Hint: '时序块里的赋值符号对吗？', level2Cause: '误用 = 破坏了并发语义。' },
        }),
    });

    const bug = await createAgentRuntime({ llm, engine: createStubEngine({}) }).injectBug(CODE_A);

    expect(bug.id).toMatch(/^bug-/);
    expect(bug.buggyCode).toBe(CODE_BAD_2);
    expect(bug.diagnosis.level3PatchCode).toBe(CODE_A);
    expect(calls.map((call) => call.action)).toEqual(['inject_bug']);
  });
});