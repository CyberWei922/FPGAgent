// 队友 2：这里是 M0 的契约冒烟测试，替换为真实 Harness 后请保留并扩充。
import { describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/agent';
import { createRtlEngine } from '../src/engine';
import type { HarnessTraceEvent, LLMClient } from '../src/types/contracts';

const stubLLM: LLMClient = {
  async chat() {
    return { text: '{}' };
  },
};

function runtime() {
  return createAgentRuntime({ llm: stubLLM, engine: createRtlEngine() });
}

describe('AgentRuntime 契约', () => {
  it('提供至少 1 个预置案例，且字段完整', () => {
    const { presets } = runtime();
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      expect(p.verilogCode).toMatch(/module\s+top\b/);
      expect(p.blueprint.mermaidFsm).toMatch(/^stateDiagram-v2/);
      p.testVectors.forEach((v, i) => expect(v.cycle).toBe(i));
    }
  });

  it('故障关卡的 buggyCode 与原代码不同，修复代码可通过自测', () => {
    const engine = createRtlEngine();
    for (const p of runtime().presets) {
      for (const bug of p.bugs) {
        expect(bug.buggyCode).not.toBe(p.verilogCode);
        expect(engine.runSelfTest(bug.diagnosis.level3PatchCode, p.testVectors).passed).toBe(true);
      }
    }
  });

  it('runHarness 依次吐出 trace，并以 done 结束', async () => {
    const events: HarnessTraceEvent[] = [];
    const result = await runtime().runHarness('交通灯', { onTrace: (e) => events.push(e) });
    expect(result.ok).toBe(true);
    expect(events[0].stage).toBe('planning');
    expect(events.at(-1)?.stage).toBe('done');
  });

  it('runHarness 支持中途取消', async () => {
    const controller = new AbortController();
    const pending = runtime().runHarness('交通灯', { onTrace: () => {}, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
