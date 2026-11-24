// M0 占位实现：不调用大模型，按固定节奏回放闭环步骤，供前端联调。队友 2 用真实 Harness 替换。
import type {
  AgentRuntime,
  AgentRuntimeDeps,
  BugClinicCase,
  DiagnoseInput,
  DiagnosisResponse,
  HarnessResult,
  HarnessRunOptions,
  HarnessStage,
  HarnessTraceEvent,
} from '../types/contracts';
import { MOCK_PRESETS } from './mockPresets';

const STEP_DELAY_MS = 350;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export function createMockAgentRuntime({ engine }: AgentRuntimeDeps): AgentRuntime {
  const preset = MOCK_PRESETS[0];

  return {
    presets: MOCK_PRESETS,

    async runHarness(prompt: string, { onTrace, signal }: HarnessRunOptions): Promise<HarnessResult> {
      const emit = (stage: HarnessStage, status: HarnessTraceEvent['status'], title: string, detail: string) =>
        onTrace({ stage, status, title, detail, timestamp: Date.now() });

      emit('planning', 'running', '拆解需求', `Mock：收到需求「${prompt}」`);
      await wait(STEP_DELAY_MS, signal);
      emit('planning', 'pass', '蓝图完成', `${preset.blueprint.behaviors.length} 条行为要点，${preset.testVectors.length} 拍自测向量`);

      emit('coding', 'running', '生成 Verilog', 'Mock：直接复用交通灯预置代码');
      await wait(STEP_DELAY_MS, signal);
      emit('coding', 'pass', '代码生成完成', `${preset.verilogCode.split('\n').length} 行`);

      emit('linting', 'running', 'Lint 体检', '调用 RtlEngine.compile');
      await wait(STEP_DELAY_MS, signal);
      const compiled = engine.compile(preset.verilogCode);
      emit('linting', compiled.ok ? 'pass' : 'fail', 'Lint 体检', `${compiled.issues.length} 条告警`);

      emit('simulating', 'running', '确定性自测', '调用 RtlEngine.runSelfTest');
      await wait(STEP_DELAY_MS, signal);
      const selfTest = engine.runSelfTest(preset.verilogCode, preset.testVectors);
      emit('simulating', selfTest.passed ? 'pass' : 'fail', '确定性自测', `${selfTest.passedChecks}/${selfTest.totalChecks} 项断言通过`);

      const ok = compiled.ok && selfTest.passed;
      emit(ok ? 'done' : 'failed', ok ? 'pass' : 'fail', ok ? '验证通过，可上板' : '验证未通过', '');

      return {
        ok,
        blueprint: preset.blueprint,
        verilogCode: preset.verilogCode,
        testVectors: preset.testVectors,
        issues: compiled.issues,
        selfTest,
        repairRounds: 0,
      };
    },

    async diagnose(input: DiagnoseInput): Promise<DiagnosisResponse> {
      await wait(STEP_DELAY_MS);
      const f = input.failure;
      return {
        level1Hint: f ? `第 ${f.cycle} 拍的 ${f.signal} 和你预期的一样吗？` : '先看看 Lint 告警指向的那一行。',
        level2Cause: f
          ? `第 ${f.cycle} 拍 ${f.signal} 期望 ${f.expected}，实际 ${f.actual}（Mock 诊断）。`
          : `共有 ${input.issues.length} 条 Lint 告警（Mock 诊断）。`,
        level3PatchCode: preset.verilogCode,
        highlightLine: input.issues[0]?.line,
        highlightCycle: f?.cycle,
      };
    },

    async injectBug(): Promise<BugClinicCase> {
      await wait(STEP_DELAY_MS);
      return preset.bugs[0];
    },
  };
}
