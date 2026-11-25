// 真实模型评测：会消耗 Token，仅在 EVAL_REAL=1 且提供 LLM_API_KEY 时执行。
// 普通 npm test / npm run test:agent 会自动跳过本文件。
import { describe, expect, it } from 'vitest';
import type { HarnessPreviousContext, HarnessResult } from '../src/types/contracts';
import { createAgentRuntime } from '../src/agent';
import { createRtlEngine } from '../src/engine';
import { createLLMClient } from '../src/services/llmClient';

const enabled = process.env.EVAL_REAL === '1' && Boolean(process.env.LLM_API_KEY);
const MODEL = process.env.LLM_MODEL || undefined;

interface EvalCase {
  name: string;
  prompt: string;
  followUp: string;
}

const CASES: EvalCase[] = [
  {
    name: 'PWM 调光灯',
    prompt:
      '做一个 PWM 调光灯：sw[1:0] 选择 25%/50%/75%/100% 四档占空比，led[0] 输出 PWM 波，led[7:4] 显示当前档位编号（0-3），复位后默认 50% 档',
    followUp: '把默认档位从 50% 改成 25%，并让 traffic[0] 在占空比为 100% 时一直亮，其余档位熄灭',
  },
  {
    name: '按键长短按检测器',
    prompt:
      '做一个按键长短按检测器：KEY0 连续按住 8 个时钟判为长按；短按（松开时不足 8 拍）让 LED0 亮 2 拍，长按让 LED1 亮 3 拍；seg 显示当前已按住的拍数（最大 15）',
    followUp: '把长按阈值从 8 拍改成 4 拍，短按提示灯从 LED0 改到 LED2，其余行为保持不变',
  },
  {
    name: '两位 BCD 加减计数器',
    prompt:
      '做一个两位 BCD 加减计数器：KEY0 每按一次加一，KEY1 每按一次减一；sw[0]=1 时 99 再加回到 00，sw[0]=0 时 00 再减回到 99；seg[7:0] 显示两位 BCD，led[0] 在数值为 99 时常亮',
    followUp: '增加 KEY2 清零功能，并把 led[0] 常亮条件从 99 改成数值大于等于 90',
  },
];

function previousContextOf(prompt: string, result: HarnessResult): HarnessPreviousContext {
  return {
    blueprint: result.blueprint,
    verilogCode: result.verilogCode,
    testVectors: result.testVectors,
    history: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: result.assistantSummary ?? '' },
    ],
  };
}

function formatRun(label: string, result: HarnessResult, elapsedMs: number): string {
  const checks = `${result.selfTest?.passedChecks ?? 0}/${result.selfTest?.totalChecks ?? 0}`;
  return `[eval] ${label} ok=${result.ok} 修复=${result.repairRounds} 断言=${checks} 耗时=${elapsedMs}ms 文件=${result.suggestedFilename ?? '?'} 模型=${result.modelUsed ?? MODEL ?? '客户端默认'}`;
}

describe.skipIf(!enabled)('真实模型闭环评测', () => {
  const runtime = createAgentRuntime({
    llm: createLLMClient({ mode: 'node' }),
    engine: createRtlEngine(),
  });

  for (const evalCase of CASES) {
    it(evalCase.name, async () => {
      const initialStages: string[] = [];
      const initialStarted = Date.now();
      const initial = await runtime.runHarness(evalCase.prompt, {
        onTrace: (event) => initialStages.push(`${event.stage}:${event.status}`),
        ...(MODEL ? { model: MODEL } : {}),
      });
      console.log(formatRun(`${evalCase.name}·初始`, initial, Date.now() - initialStarted));

      expect(initial.ok, `初始生成未通过：${initial.assistantSummary}`).toBe(true);
      expect(initialStages).toContain('planning:pass');
      expect(initialStages).toContain('coding:pass');
      expect(initialStages).toContain('done:pass');
      expect(initial.blueprint.behaviors.length).toBeGreaterThan(0);
      expect(initial.testVectors.length).toBeGreaterThan(0);
      expect(initial.assistantSummary ?? '').not.toBe('');
      expect(initial.suggestedFilename ?? '').toMatch(/\.v$/);

      const followStages: string[] = [];
      const followStarted = Date.now();
      const followed = await runtime.runHarness(evalCase.followUp, {
        onTrace: (event) => followStages.push(`${event.stage}:${event.status}`),
        previousContext: previousContextOf(evalCase.prompt, initial),
        ...(MODEL ? { model: MODEL } : {}),
      });
      console.log(formatRun(`${evalCase.name}·追改`, followed, Date.now() - followStarted));

      expect(followed.ok, `追改未通过：${followed.assistantSummary}`).toBe(true);
      expect(followStages).toContain('planning:pass');
      expect(followStages).toContain('done:pass');
      expect(followed.assistantSummary ?? '').not.toBe('');
      expect(followed.suggestedFilename ?? '').toMatch(/\.v$/);
    }, 420_000);
  }
});