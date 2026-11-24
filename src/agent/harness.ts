// 队友 2：Harness 可验证闭环状态机。
// 规划 → 生成 → 注入引擎做 Lint/确定性自测 → 失败最多 2 轮自动修复 → 无回退择优。
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
  LintIssue,
  SelfTestResult,
  SignalSample,
} from '../types/contracts';
import { LLMError } from '../types/contracts';
import { requestInjectedBug } from './bugClinic';
import { PRESETS } from './presets';
import {
  buildDiagnoseMessages,
  buildGenerateMessages,
  buildPlanMessages,
  buildRepairMessages,
  parseCodeResponse,
  parseDiagnosisResponse,
  parsePlanResponse,
} from './prompts';

const MAX_REPAIR_ROUNDS = 2;
const WAVEFORM_RADIUS = 4;

interface Candidate {
  code: string;
  issues: LintIssue[];
  compiledOk: boolean;
  selfTest?: SelfTestResult;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LLMError('ABORTED', '调用已取消');
}

function countLines(code: string): number {
  return code.split('\n').length;
}

function sliceWaveform(waveform: SignalSample[], cycle: number): SignalSample[] {
  return waveform.filter((sample) => Math.abs(sample.cycle - cycle) <= WAVEFORM_RADIUS);
}

function describeSelfTest(result: SelfTestResult): string {
  if (result.firstUnstableCycle !== undefined) return `第 ${result.firstUnstableCycle} 拍组合逻辑未收敛`;
  const failure = result.firstFailure;
  if (!failure) return `${result.passedChecks}/${result.totalChecks} 项断言通过`;
  return `${result.passedChecks}/${result.totalChecks} 项通过；首个失败在第 ${failure.cycle} 拍：${failure.signal} 期望 ${failure.expected}，实际 ${failure.actual}`;
}

/** 无回退择优：优先通过，其次少回退，再次更多断言通过，最后更少告警。 */
function isBetter(candidate: Candidate, best: Candidate | null): boolean {
  if (!best) return true;
  const candidateOk = candidate.compiledOk && !!candidate.selfTest?.passed;
  const bestOk = best.compiledOk && !!best.selfTest?.passed;
  if (candidateOk !== bestOk) return candidateOk;
  const candidateRegressed = candidate.selfTest?.regressedCycles.length ?? 0;
  const bestRegressed = best.selfTest?.regressedCycles.length ?? 0;
  if (candidateRegressed !== bestRegressed) return candidateRegressed < bestRegressed;
  const candidatePassed = candidate.selfTest?.passedChecks ?? -1;
  const bestPassed = best.selfTest?.passedChecks ?? -1;
  if (candidatePassed !== bestPassed) return candidatePassed > bestPassed;
  return candidate.issues.length < best.issues.length;
}

export function createHarnessAgentRuntime({ llm, engine }: AgentRuntimeDeps): AgentRuntime {
  async function runHarness(prompt: string, { onTrace, signal }: HarnessRunOptions): Promise<HarnessResult> {
    const emit = (stage: HarnessStage, status: HarnessTraceEvent['status'], title: string, detail: string): void => {
      onTrace({ stage, status, title, detail, timestamp: Date.now() });
    };

    try {
      ensureNotAborted(signal);
      emit('planning', 'running', '拆解需求', `收到需求「${prompt}」`);
      const planResponse = await llm.chat({
        action: 'plan',
        messages: buildPlanMessages(prompt),
        jsonMode: true,
        signal,
      });
      ensureNotAborted(signal);
      const plan = parsePlanResponse(planResponse.text);
      emit(
        'planning',
        'pass',
        '蓝图完成',
        `${plan.blueprint.behaviors.length} 条行为要点、${plan.blueprint.pinMappings.length} 个引脚映射、${plan.testVectors.length} 拍自测向量`,
      );

      emit('coding', 'running', '生成 Verilog', '按蓝图与自测向量生成 top 模块');
      const generateResponse = await llm.chat({
        action: 'generate',
        messages: buildGenerateMessages(plan.blueprint, plan.testVectors),
        jsonMode: true,
        signal,
      });
      ensureNotAborted(signal);
      const generated = parseCodeResponse(generateResponse.text);
      emit(
        'coding',
        'pass',
        '代码生成完成',
        `${countLines(generated.code)} 行 Verilog${generated.explanation ? `：${generated.explanation}` : ''}`,
      );

      let currentCode = generated.code;
      let best: Candidate | null = null;
      let repairRounds = 0;

      for (let round = 0; ; round += 1) {
        ensureNotAborted(signal);
        emit('linting', 'running', 'Lint 体检', `第 ${round + 1} 版代码，${countLines(currentCode)} 行`);
        const compiled = engine.compile(currentCode);
        const errorCount = compiled.issues.filter((issue) => issue.severity === 'error').length;
        emit(
          'linting',
          compiled.ok ? 'pass' : 'fail',
          'Lint 体检',
          compiled.issues.length === 0 ? '未发现告警' : `${compiled.issues.length} 条告警（${errorCount} 条 error）`,
        );

        let selfTest: SelfTestResult | undefined;
        if (compiled.ok) {
          emit('simulating', 'running', '确定性自测', `${plan.testVectors.length} 拍自测向量`);
          selfTest = engine.runSelfTest(currentCode, plan.testVectors, best?.selfTest?.passedCycles);
          emit('simulating', selfTest.passed ? 'pass' : 'fail', '确定性自测', describeSelfTest(selfTest));
        } else {
          emit('simulating', 'fail', '确定性自测', '编译未通过，跳过仿真，直接进入修复');
        }

        const candidate: Candidate = { code: currentCode, issues: compiled.issues, compiledOk: compiled.ok, selfTest };
        if (isBetter(candidate, best)) best = candidate;

        const passed = compiled.ok && !!selfTest?.passed;
        if (passed || round >= MAX_REPAIR_ROUNDS) break;

        repairRounds = round + 1;
        const failureCycle = selfTest?.firstUnstableCycle ?? selfTest?.firstFailure?.cycle;
        const waveformSlice = selfTest && failureCycle !== undefined ? sliceWaveform(selfTest.waveform, failureCycle) : undefined;
        emit(
          'repairing',
          'running',
          `第 ${repairRounds} 轮自动修复`,
          selfTest
            ? `按自测结果修复：${describeSelfTest(selfTest)}`
            : `按 ${errorCount} 条 Lint error 修复`,
        );
        try {
          const repairResponse = await llm.chat({
            action: 'repair',
            messages: buildRepairMessages({
              code: currentCode,
              issues: compiled.issues,
              selfTest,
              blueprint: plan.blueprint,
              testVectors: plan.testVectors,
              waveformSlice,
            }),
            jsonMode: true,
            signal,
          });
          ensureNotAborted(signal);
          const repaired = parseCodeResponse(repairResponse.text);
          currentCode = repaired.code;
          emit(
            'repairing',
            'pass',
            `第 ${repairRounds} 轮修复`,
            `候选代码 ${countLines(currentCode)} 行${repaired.explanation ? `：${repaired.explanation}` : ''}`,
          );
        } catch (error) {
          ensureNotAborted(signal);
          if (!(error instanceof LLMError) || error.code === 'ABORTED') throw error;
          emit('repairing', 'fail', `第 ${repairRounds} 轮修复中断`, error.message);
          break;
        }
      }

      if (!best) throw new LLMError('BAD_RESPONSE', '闭环没有产生任何候选代码');
      const winner = best;
      const ok = winner.compiledOk && !!winner.selfTest?.passed;
      emit(
        ok ? 'done' : 'failed',
        ok ? 'pass' : 'fail',
        ok ? '验证通过，可上板' : '验证未通过',
        ok
          ? `${winner.selfTest?.passedChecks ?? 0}/${winner.selfTest?.totalChecks ?? 0} 项断言通过，共修复 ${repairRounds} 轮`
          : `最佳候选剩余 ${winner.issues.length} 条告警、${
              winner.selfTest ? winner.selfTest.totalChecks - winner.selfTest.passedChecks : plan.testVectors.length
            } 项断言未通过`,
      );

      return {
        ok,
        blueprint: plan.blueprint,
        verilogCode: winner.code,
        testVectors: plan.testVectors,
        issues: winner.issues,
        selfTest: winner.selfTest,
        repairRounds,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('failed', 'fail', '闭环中断', message);
      throw error;
    }
  }

  async function diagnose(input: DiagnoseInput): Promise<DiagnosisResponse> {
    const response = await llm.chat({
      action: 'diagnose',
      messages: buildDiagnoseMessages(input),
      jsonMode: true,
    });
    return parseDiagnosisResponse(response.text);
  }

  async function injectBug(code: string): Promise<BugClinicCase> {
    return requestInjectedBug(llm, code);
  }

  return {
    presets: PRESETS,
    runHarness,
    diagnose,
    injectBug,
  };
}