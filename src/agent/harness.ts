// 队友 2：Harness 可验证闭环状态机。
// 规划 →（可选联网查阅）→ 生成 → 注入引擎做 Lint/确定性自测 → 失败最多 2 轮自动修复 → 无回退择优。
import type {
  AgentActionOptions,
  AgentRuntime,
  AgentRuntimeDeps,
  BugClinicCase,
  ChatMessage,
  DiagnoseInput,
  DiagnosisResponse,
  HarnessResult,
  HarnessRunOptions,
  HarnessStage,
  HarnessTraceEvent,
  HarnessTraceMeta,
  LintIssue,
  SelfTestResult,
  SignalSample,
  WebReference,
} from '../types/contracts';
import { LLMError } from '../types/contracts';
import { extractPartialJsonStringField } from '../engine/streamTokenizer';
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
const RESEARCH_LIMIT = 4;
const RESEARCH_MAX_CHARS = 1800;
// 代码类动作压低随机性以稳定 JSON 与综合语义，诊断类允许更灵活的表达。
const TEMPERATURE = { plan: 0.3, generate: 0.2, repair: 0.2, diagnose: 0.5 } as const;

// 仅在需求明确涉及外部规范/协议/参考实现时联网，避免每次生成都产生检索开销。
const RESEARCH_TRIGGER = /规范|标准|协议|手册|参考实现|示例电路|查阅|搜索|AXI|APB|AHB|SPI|I2C|UART|CDC|跨时钟/i;

const FILENAME_HINTS: Array<[RegExp, string]> = [
  [/交通|红绿|路口|traffic|intersection/i, 'traffic_light'],
  [/密码|锁|password|lock/i, 'password_lock'],
  [/序列|sequence|detector/i, 'sequence_detector'],
  [/秒表|计时|stopwatch/i, 'stopwatch'],
  [/抢答|buzzer|quiz/i, 'buzzer'],
  [/计数器|counter/i, 'counter'],
  [/分频|divider/i, 'clock_divider'],
  [/PWM/i, 'pwm'],
  [/ALU/i, 'alu'],
];

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

function describeSelfTest(result: SelfTestResult, locale: 'zh' | 'en' = 'zh'): string {
  if (locale === 'en') {
    if (result.firstUnstableCycle !== undefined) {
      return `Combinational logic unstable at cycle ${result.firstUnstableCycle}`;
    }
    const failure = result.firstFailure;
    if (!failure) return `${result.passedChecks}/${result.totalChecks} assertions passed`;
    return `${result.passedChecks}/${result.totalChecks} passed; first failure at cycle ${failure.cycle}: ${failure.signal} expected ${failure.expected}, got ${failure.actual}`;
  }
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

function buildResearchQuery(prompt: string, failureDetail?: string): string {
  const base = prompt.replace(/\s+/g, ' ').trim().slice(0, 120);
  return failureDetail ? `${base} Verilog 实现 规范 ${failureDetail}` : `${base} Verilog 实现 规范 参考`;
}

function describeFailureForResearch(selfTest: SelfTestResult | undefined, issues: LintIssue[]): string | undefined {
  if (selfTest?.firstFailure) {
    const failure = selfTest.firstFailure;
    return `第 ${failure.cycle} 拍 ${failure.signal} 期望 ${failure.expected} 实际 ${failure.actual}`;
  }
  if (selfTest?.firstUnstableCycle !== undefined) return `第 ${selfTest.firstUnstableCycle} 拍组合逻辑未收敛`;
  return issues.find((issue) => issue.severity === 'error')?.message;
}

function suggestFilename(title: string, prompt: string): string {
  const source = `${title} ${prompt}`;
  for (const [pattern, name] of FILENAME_HINTS) {
    if (pattern.test(source)) return `${name}.v`;
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${slug || 'circuit'}.v`;
}

interface SummaryInput {
  ok: boolean;
  title: string;
  repairRounds: number;
  selfTest?: SelfTestResult;
  issues: LintIssue[];
  references: WebReference[];
  modelUsed?: string;
  filename: string;
  locale?: 'zh' | 'en';
}

function buildAssistantSummary(input: SummaryInput): string {
  if (input.locale === 'en') {
    const parts: string[] = [
      `"${input.title}" ${input.ok ? 'passed local verification.' : 'did not pass all local checks.'}`,
    ];
    if (input.selfTest) {
      parts.push(`${input.selfTest.passedChecks}/${input.selfTest.totalChecks} assertions passed.`);
      const failure = input.selfTest.firstFailure;
      if (failure) {
        parts.push(
          `First failure at cycle ${failure.cycle}: ${failure.signal} expected ${failure.expected}, got ${failure.actual}.`,
        );
      }
      if (input.selfTest.firstUnstableCycle !== undefined) {
        parts.push(`Combinational logic did not converge at cycle ${input.selfTest.firstUnstableCycle}.`);
      }
    } else {
      const errors = input.issues.filter((issue) => issue.severity === 'error').length;
      if (errors > 0) parts.push(`${errors} compile error(s) remaining.`);
    }
    if (input.repairRounds > 0) parts.push(`Auto-repaired in ${input.repairRounds} round(s).`);
    if (input.references.length > 0) parts.push(`Referenced ${input.references.length} web source(s).`);
    if (input.modelUsed) parts.push(`Model: ${input.modelUsed}.`);
    parts.push(`Downloadable file: ${input.filename}.`);
    return parts.join(' ');
  }

  const parts: string[] = [`「${input.title}」${input.ok ? '已通过本地验证' : '尚未完全通过本地验证'}。`];
  if (input.selfTest) {
    parts.push(`断言 ${input.selfTest.passedChecks}/${input.selfTest.totalChecks} 项通过。`);
    const failure = input.selfTest.firstFailure;
    if (failure) {
      parts.push(`首个失败在第 ${failure.cycle} 拍：${failure.signal} 期望 ${failure.expected}，实际 ${failure.actual}。`);
    }
    if (input.selfTest.firstUnstableCycle !== undefined) {
      parts.push(`第 ${input.selfTest.firstUnstableCycle} 拍组合逻辑未收敛。`);
    }
  } else {
    const errors = input.issues.filter((issue) => issue.severity === 'error').length;
    if (errors > 0) parts.push(`编译仍有 ${errors} 条 error 待修复。`);
  }
  if (input.repairRounds > 0) parts.push(`共自动修复 ${input.repairRounds} 轮。`);
  if (input.references.length > 0) parts.push(`参考了 ${input.references.length} 条联网资料。`);
  if (input.modelUsed) parts.push(`使用模型 ${input.modelUsed}。`);
  parts.push(`可下载文件：${input.filename}。`);
  return parts.join('');
}

function chunkText(text: string, size = 24): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

export function createHarnessAgentRuntime({ llm, engine, research }: AgentRuntimeDeps): AgentRuntime {
  async function runHarness(prompt: string, options: HarnessRunOptions): Promise<HarnessResult> {
    const {
      onTrace,
      onAssistantDelta,
      onBlueprint,
      onCodeDelta,
      onReasoningDelta,
      signal,
      model,
      previousContext,
      enableWebResearch,
      clockIntervalMs,
      locale = 'zh',
    } = options;
    const tr = (zh: string, en: string) => (locale === 'en' ? en : zh);
    const researchEnabled = Boolean(research) && enableWebResearch === true;

    let activeModel = model;
    let remainingQuota: number | undefined;
    let references: WebReference[] = [];
    let researchNotes: string | undefined;
    let researchAttempted = false;

    const traceMeta = (extra?: HarnessTraceMeta): HarnessTraceMeta | undefined => {
      const merged: HarnessTraceMeta = {
        ...(activeModel ? { model: activeModel } : {}),
        ...(references.length > 0 ? { sources: references } : {}),
        ...extra,
      };
      return Object.keys(merged).length > 0 ? merged : undefined;
    };
    const emit = (
      stage: HarnessStage,
      status: HarnessTraceEvent['status'],
      title: string,
      detail: string,
      extra?: HarnessTraceMeta,
    ): void => {
      const event: HarnessTraceEvent = { stage, status, title, detail, timestamp: Date.now() };
      const meta = traceMeta(extra);
      if (meta) event.meta = meta;
      onTrace(event);
    };

    const callModel = async (
      action: 'plan' | 'generate' | 'repair',
      messages: ChatMessage[],
      temperature: number,
      streamOpts?: {
        stage: HarnessStage;
        round?: number;
        streamCode?: boolean;
      },
    ) => {
      let rawStream = '';
      let reasoningStream = '';
      let lastEmittedCodeLen = 0;

      const wantsStream = Boolean(streamOpts && (onCodeDelta || onReasoningDelta));
      const response = await llm.chat({
        action,
        messages,
        temperature,
        jsonMode: true,
        model: activeModel,
        signal,
        ...(wantsStream
          ? {
              onReasoningDelta: (chunk: string) => {
                reasoningStream += chunk;
                if (streamOpts) onReasoningDelta?.(streamOpts.stage, reasoningStream, streamOpts.round);
              },
              onDelta: (chunk: string) => {
                rawStream += chunk;
                if (streamOpts?.streamCode && onCodeDelta) {
                  const extracted = extractPartialJsonStringField(rawStream, 'code');
                  if (extracted && extracted.value.length > lastEmittedCodeLen) {
                    lastEmittedCodeLen = extracted.value.length;
                    onCodeDelta(extracted.value, {
                      stage: streamOpts.stage === 'repairing' ? 'repairing' : 'coding',
                      round: streamOpts.round,
                      final: extracted.complete,
                    });
                  }
                }
              },
            }
          : {}),
      });
      if (response.model) activeModel = response.model;
      if (response.remainingQuota !== undefined) remainingQuota = response.remainingQuota;
      return { ...response, reasoning: reasoningStream || undefined };
    };

    const runResearch = async (query: string, reason: string): Promise<void> => {
      if (!research || !researchEnabled || researchAttempted) return;
      researchAttempted = true;
      emit('researching', 'running', tr('联网查阅', 'Web Lookup'), reason);
      try {
        const found = await research.search(query, { limit: RESEARCH_LIMIT, signal });
        ensureNotAborted(signal);
        const candidates = (found ?? [])
          .filter((reference) => typeof reference?.url === 'string' && reference.url.length > 0)
          .slice(0, RESEARCH_LIMIT);
        if (candidates.length === 0) {
          emit(
            'researching',
            'fail',
            tr('联网查阅', 'Web Lookup'),
            tr('未检索到可用参考资料，继续纯本地闭环', 'No usable web sources found — continuing locally'),
          );
          return;
        }
        references = candidates;
        let excerpt = '';
        if (research.fetchPage) {
          try {
            const page = await research.fetchPage(candidates[0].url, { maxChars: RESEARCH_MAX_CHARS, signal });
            ensureNotAborted(signal);
            if (page?.excerpt) {
              excerpt = `《${page.title || candidates[0].title}》${page.url}\n${page.excerpt.slice(0, RESEARCH_MAX_CHARS)}`;
            }
          } catch {
            ensureNotAborted(signal);
          }
        }
        researchNotes = [
          '联网检索参考（仅作规范提示，仍须落在可综合 Verilog 教学子集内）：',
          ...candidates.map((reference) => `- ${reference.title}：${reference.snippet}（${reference.url}）`),
          ...(excerpt ? [excerpt] : []),
        ].join('\n');
        emit(
          'researching',
          'pass',
          tr('联网查阅', 'Web Lookup'),
          tr(
            `检索到 ${candidates.length} 条参考资料${excerpt ? '，已读取首个网页正文' : ''}`,
            `Found ${candidates.length} reference(s)${excerpt ? ' and fetched top page' : ''}`,
          ),
          { sources: references },
        );
      } catch (error) {
        ensureNotAborted(signal);
        const message = error instanceof Error ? error.message : String(error);
        emit(
          'researching',
          'fail',
          tr('联网查阅', 'Web Lookup'),
          tr(
            `联网查阅不可用，已降级为纯模型闭环：${message}`,
            `Web lookup unavailable, falling back to model only: ${message}`,
          ),
        );
      }
    };

    try {
      ensureNotAborted(signal);
      if (researchEnabled && RESEARCH_TRIGGER.test(prompt)) {
        await runResearch(
          buildResearchQuery(prompt),
          tr('需求涉及规范或参考实现，先联网查阅资料', 'Looking up Verilog reference specifications'),
        );
        ensureNotAborted(signal);
      }

      emit(
        'planning',
        'running',
        tr('规划电路蓝图', 'Plan Circuit Blueprint'),
        tr(
          `分析需求「${prompt}」并拆解端口、状态机与自测向量`,
          `Analyzing "${prompt}" into ports, FSM states, and test vectors`,
        ),
      );
      const planResponse = await callModel(
        'plan',
        buildPlanMessages(prompt, { previousContext, researchNotes, clockIntervalMs, locale }),
        TEMPERATURE.plan,
        { stage: 'planning' },
      );
      ensureNotAborted(signal);
      const plan = parsePlanResponse(planResponse.text);
      onBlueprint?.(plan.blueprint);
      const planCheckpoints = [
        ...plan.blueprint.behaviors.slice(0, 4).map((b, i) => `${i + 1}. ${b}`),
        tr(
          `端口映射：${plan.blueprint.pinMappings.map((p) => p.port).slice(0, 5).join(' / ')}`,
          `Pin map: ${plan.blueprint.pinMappings.map((p) => p.port).slice(0, 5).join(' / ')}`,
        ),
      ];
      emit(
        'planning',
        'pass',
        tr('规划电路蓝图', 'Plan Circuit Blueprint'),
        tr(
          `${plan.blueprint.behaviors.length} 条行为要点 · ${plan.blueprint.pinMappings.length} 个引脚映射 · ${plan.testVectors.length} 拍自测向量`,
          `${plan.blueprint.behaviors.length} behaviors · ${plan.blueprint.pinMappings.length} pin mappings · ${plan.testVectors.length} test cycles`,
        ),
        {
          checkpoints: planCheckpoints,
          ...(planResponse.reasoning ? { reasoning: planResponse.reasoning } : {}),
        },
      );

      emit(
        'coding',
        'running',
        tr('编写 Verilog 源码', 'Generate Verilog RTL'),
        tr(
          '按蓝图规格与端口约束生成可综合 top 模块',
          'Generating synthesizable top module aligned to board ports',
        ),
      );
      const generateResponse = await callModel(
        'generate',
        buildGenerateMessages(plan.blueprint, plan.testVectors, {
          previousCode: previousContext?.verilogCode,
          researchNotes,
          clockIntervalMs,
          locale,
        }),
        TEMPERATURE.generate,
        { stage: 'coding', streamCode: true },
      );
      ensureNotAborted(signal);
      const generated = parseCodeResponse(generateResponse.text);
      const generatedLines = countLines(generated.code);
      onCodeDelta?.(generated.code, { stage: 'coding', final: true });
      emit(
        'coding',
        'pass',
        tr('编写 Verilog 源码', 'Generate Verilog RTL'),
        tr(
          `${generatedLines} 行可综合 Verilog${generated.explanation ? ` · ${generated.explanation}` : ''}`,
          `${generatedLines} lines of synthesizable Verilog${generated.explanation ? ` · ${generated.explanation}` : ''}`,
        ),
        {
          codeLines: generatedLines,
          ...(generated.explanation ? { checkpoints: [generated.explanation] } : {}),
          ...(generateResponse.reasoning ? { reasoning: generateResponse.reasoning } : {}),
        },
      );

      const previousVectors = previousContext?.testVectors;
      const sameVectors =
        !!previousVectors &&
        previousVectors.length > 0 &&
        JSON.stringify(previousVectors) === JSON.stringify(plan.testVectors);
      let inheritedPassedCycles: number[] | undefined;
      if (sameVectors && previousVectors && previousContext?.verilogCode) {
        try {
          inheritedPassedCycles = engine.runSelfTest(previousContext.verilogCode, previousVectors).passedCycles;
        } catch {
          inheritedPassedCycles = undefined;
        }
      }

      let currentCode = generated.code;
      let best: Candidate | null = null;
      let repairRounds = 0;

      for (let round = 0; ; round += 1) {
        ensureNotAborted(signal);
        emit(
          'linting',
          'running',
          tr('Lint 静态体检', 'Static Lint Check'),
          tr(
            `检查第 ${round + 1} 版代码（${countLines(currentCode)} 行）的语法与可综合规则`,
            `Checking v${round + 1} RTL (${countLines(currentCode)} lines) against synthesizable rules`,
          ),
          { round },
        );
        const compiled = engine.compile(currentCode);
        const errorCount = compiled.issues.filter((issue) => issue.severity === 'error').length;
        const lintCheckpoints =
          compiled.issues.length === 0
            ? [
                tr('端口声明与位宽对齐通过', 'Port declarations & bit-widths verified'),
                tr(
                  '0 阻塞/非阻塞混用错误 · 0 推断锁存器告警',
                  '0 blocking/non-blocking mix-ups · 0 inferred latches',
                ),
              ]
            : compiled.issues
                .slice(0, 4)
                .map((issue) => tr(`第 ${issue.line} 行 [${issue.code}] ${issue.message}`, `L${issue.line} [${issue.code}] ${issue.message}`));
        emit(
          'linting',
          compiled.ok ? 'pass' : 'fail',
          tr('Lint 静态体检', 'Static Lint Check'),
          compiled.issues.length === 0
            ? tr('0 错误 · 0 告警', '0 errors · 0 warnings')
            : tr(
                `${compiled.issues.length} 条告警（${errorCount} 条 error）`,
                `${compiled.issues.length} issues (${errorCount} errors)`,
              ),
          {
            round,
            checkpoints: lintCheckpoints,
            ...(compiled.issues[0]?.line ? { highlightLine: compiled.issues[0].line } : {}),
          },
        );

        let selfTest: SelfTestResult | undefined;
        if (compiled.ok) {
          emit(
            'simulating',
            'running',
            tr('确定性仿真自测', 'Deterministic Self-Test'),
            tr(
              `运行 ${plan.testVectors.length} 拍测试向量并校验板卡输出`,
              `Executing ${plan.testVectors.length} test vectors and checking board outputs`,
            ),
            { round },
          );
          selfTest = engine.runSelfTest(
            currentCode,
            plan.testVectors,
            best?.selfTest?.passedCycles ?? inheritedPassedCycles,
          );
          const simCheckpoints = plan.testVectors
            .filter((v) => v.note)
            .slice(0, 4)
            .map((v) => {
              const failedHere = selfTest?.firstFailure?.cycle === v.cycle || selfTest?.firstUnstableCycle === v.cycle;
              return tr(
                `${failedHere ? '✕' : '✓'} 第 ${v.cycle} 拍 · ${v.note}`,
                `${failedHere ? '✕' : '✓'} Cycle ${v.cycle} · ${v.note}`,
              );
            });
          emit(
            'simulating',
            selfTest.passed ? 'pass' : 'fail',
            tr('确定性仿真自测', 'Deterministic Self-Test'),
            describeSelfTest(selfTest, locale),
            {
              round,
              ...(simCheckpoints.length > 0 ? { checkpoints: simCheckpoints } : {}),
            },
          );
        } else {
          emit(
            'simulating',
            'fail',
            tr('确定性仿真自测', 'Deterministic Self-Test'),
            tr('编译未通过，跳过仿真，直接进入修复', 'Compile failed — skipping simulation and starting repair'),
            { round },
          );
        }

        const candidate: Candidate = { code: currentCode, issues: compiled.issues, compiledOk: compiled.ok, selfTest };
        if (isBetter(candidate, best)) best = candidate;

        const passed = compiled.ok && !!selfTest?.passed;
        if (passed || round >= MAX_REPAIR_ROUNDS) break;

        repairRounds = round + 1;
        if (researchEnabled && !researchAttempted && round >= 1) {
          await runResearch(
            buildResearchQuery(prompt, describeFailureForResearch(selfTest, compiled.issues)),
            tr('首轮修复受阻，联网查阅规范后再试', 'First repair stalled — looking up references online'),
          );
          ensureNotAborted(signal);
        }
        const failureCycle = selfTest?.firstUnstableCycle ?? selfTest?.firstFailure?.cycle;
        const waveformSlice = selfTest && failureCycle !== undefined ? sliceWaveform(selfTest.waveform, failureCycle) : undefined;
        const firstIssueLine = compiled.issues[0]?.line;
        emit(
          'repairing',
          'running',
          tr(`自动修复 #${repairRounds}`, `Auto-Repair #${repairRounds}`),
          selfTest
            ? tr(`按自测结果修复：${describeSelfTest(selfTest, locale)}`, `Repairing from self-test: ${describeSelfTest(selfTest, locale)}`)
            : tr(`按 ${errorCount} 条 Lint error 修复`, `Repairing ${errorCount} lint error(s)`),
          {
            round: repairRounds,
            ...(firstIssueLine ? { highlightLine: firstIssueLine } : {}),
          },
        );
        try {
          const repairResponse = await callModel(
            'repair',
            buildRepairMessages({
              code: currentCode,
              issues: compiled.issues,
              selfTest,
              blueprint: plan.blueprint,
              testVectors: plan.testVectors,
              waveformSlice,
              researchNotes,
              clockIntervalMs,
              locale,
            }),
            TEMPERATURE.repair,
            { stage: 'repairing', round: repairRounds, streamCode: true },
          );
          ensureNotAborted(signal);
          const repaired = parseCodeResponse(repairResponse.text);
          currentCode = repaired.code;
          const repairedLines = countLines(currentCode);
          onCodeDelta?.(currentCode, { stage: 'repairing', round: repairRounds, final: true });
          emit(
            'repairing',
            'pass',
            tr(`自动修复 #${repairRounds}`, `Auto-Repair #${repairRounds}`),
            tr(
              `候选代码 ${repairedLines} 行${repaired.explanation ? ` · ${repaired.explanation}` : ''}`,
              `Candidate ${repairedLines} lines${repaired.explanation ? ` · ${repaired.explanation}` : ''}`,
            ),
            {
              round: repairRounds,
              codeLines: repairedLines,
              ...(repaired.explanation ? { checkpoints: [repaired.explanation] } : {}),
              ...(repairResponse.reasoning ? { reasoning: repairResponse.reasoning } : {}),
            },
          );
        } catch (error) {
          ensureNotAborted(signal);
          if (!(error instanceof LLMError) || error.code === 'ABORTED') throw error;
          emit(
            'repairing',
            'fail',
            tr(`自动修复 #${repairRounds} 中断`, `Auto-Repair #${repairRounds} Interrupted`),
            error.message,
            { round: repairRounds },
          );
          break;
        }
      }

      if (!best) throw new LLMError('BAD_RESPONSE', tr('闭环没有产生任何候选代码', 'No candidate RTL was produced'));
      const winner = best;
      const ok = winner.compiledOk && !!winner.selfTest?.passed;
      const filename = suggestFilename(plan.blueprint.title, prompt);
      const summary = buildAssistantSummary({
        ok,
        title: plan.blueprint.title,
        repairRounds,
        selfTest: winner.selfTest,
        issues: winner.issues,
        references,
        modelUsed: activeModel,
        filename,
        locale,
      });
      if (onAssistantDelta) {
        for (const chunk of chunkText(summary)) onAssistantDelta(chunk);
      }
      emit(
        ok ? 'done' : 'failed',
        ok ? 'pass' : 'fail',
        ok ? tr('验证通过，可上板', 'Verified & Ready') : tr('验证未通过', 'Verification Failed'),
        ok
          ? tr(
              `${winner.selfTest?.passedChecks ?? 0}/${winner.selfTest?.totalChecks ?? 0} 项断言通过，共修复 ${repairRounds} 轮`,
              `${winner.selfTest?.passedChecks ?? 0}/${winner.selfTest?.totalChecks ?? 0} assertions passed (${repairRounds} repair round(s))`,
            )
          : tr(
              `最佳候选剩余 ${winner.issues.length} 条告警、${
                winner.selfTest ? winner.selfTest.totalChecks - winner.selfTest.passedChecks : plan.testVectors.length
              } 项断言未通过`,
              `Best candidate has ${winner.issues.length} issue(s) and ${
                winner.selfTest ? winner.selfTest.totalChecks - winner.selfTest.passedChecks : plan.testVectors.length
              } failing assertion(s)`,
            ),
        { round: repairRounds },
      );

      return {
        ok,
        blueprint: plan.blueprint,
        verilogCode: winner.code,
        testVectors: plan.testVectors,
        issues: winner.issues,
        selfTest: winner.selfTest,
        repairRounds,
        assistantSummary: summary,
        suggestedFilename: filename,
        ...(activeModel ? { modelUsed: activeModel } : {}),
        ...(remainingQuota !== undefined ? { remainingQuota } : {}),
        ...(references.length > 0 ? { references } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('failed', 'fail', '闭环中断', message);
      throw error;
    }
  }

  async function diagnose(input: DiagnoseInput, options: AgentActionOptions = {}): Promise<DiagnosisResponse> {
    const response = await llm.chat({
      action: 'diagnose',
      messages: buildDiagnoseMessages(input),
      temperature: TEMPERATURE.diagnose,
      jsonMode: true,
      model: options.model,
      signal: options.signal,
    });
    return parseDiagnosisResponse(response.text);
  }

  async function injectBug(code: string, options: AgentActionOptions = {}): Promise<BugClinicCase> {
    return requestInjectedBug(llm, code, options);
  }

  return {
    presets: PRESETS,
    runHarness,
    diagnose,
    injectBug,
  };
}