// 队友 1：这里是 M0 的契约冒烟测试，替换为真实引擎后请保留并扩充到 50+ 条。
import { describe, expect, it } from 'vitest';
import { createRtlEngine } from '../src/engine';
import { MOCK_PRESETS } from '../src/agent/mockPresets';

const preset = MOCK_PRESETS[0];
const idle = { rst_n: 1 as const, key: 0, sw: 0 };

describe('RtlEngine 契约', () => {
  it('compile 合法代码返回 ok 与网表', () => {
    const result = createRtlEngine().compile(preset.verilogCode);
    expect(result.ok).toBe(true);
    expect(result.netlist?.nodes.length).toBeGreaterThan(0);
  });

  it('compile 空代码返回 PARSE_ERROR', () => {
    const result = createRtlEngine().compile('');
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe('PARSE_ERROR');
  });

  it('step 的 cycle 从 0 开始，reset 后重新计数', () => {
    const engine = createRtlEngine();
    engine.compile(preset.verilogCode);
    expect(engine.step(idle).sample.cycle).toBe(0);
    expect(engine.step(idle).sample.cycle).toBe(1);
    engine.reset();
    expect(engine.step(idle).sample.cycle).toBe(0);
  });

  it('网表的边只引用存在的节点，level 不超过 maxLevel', () => {
    const engine = createRtlEngine();
    engine.compile(preset.verilogCode);
    const { netlist } = engine.step(idle);
    const ids = new Set(netlist.nodes.map((n) => n.id));
    for (const e of netlist.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    }
    for (const n of netlist.nodes) expect(n.level).toBeLessThanOrEqual(netlist.maxLevel);
  });

  it('交通灯预置案例自测全部通过', () => {
    const result = createRtlEngine().runSelfTest(preset.verilogCode, preset.testVectors);
    expect(result.passed).toBe(true);
    expect(result.totalChecks).toBeGreaterThan(0);
    expect(result.waveform).toHaveLength(preset.testVectors.length);
  });

  it('错误期望会给出首个反例与回退周期', () => {
    const vectors = preset.testVectors.map((v) => ({ ...v }));
    const firstGreen = vectors.findIndex((vector) => vector.expect?.traffic === 0b001);
    vectors[firstGreen].expect = { traffic: 0b100 };
    const previous = createRtlEngine().runSelfTest(preset.verilogCode, preset.testVectors).passedCycles;
    const result = createRtlEngine().runSelfTest(preset.verilogCode, vectors, previous);
    expect(result.passed).toBe(false);
    expect(result.firstFailure).toMatchObject({ cycle: firstGreen, signal: 'traffic', expected: 0b100, actual: 0b001 });
    expect(result.regressedCycles).toEqual([firstGreen]);
  });

  it('runSelfTest 不影响当前运行实例', () => {
    const engine = createRtlEngine();
    engine.compile(preset.verilogCode);
    engine.step(idle);
    engine.runSelfTest(preset.verilogCode, preset.testVectors);
    expect(engine.step(idle).sample.cycle).toBe(1);
  });
});
