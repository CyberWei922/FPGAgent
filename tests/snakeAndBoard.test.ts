import { describe, expect, it } from 'vitest';
import { PRESETS, SNAKE_CODE } from '../src/agent/presets';
import { resolveGlyphBitmap } from '../src/components/OledScreen';
import { createRtlEngine } from '../src/engine';
import {
  BOARD_PRESETS,
  DEFAULT_BOARD_PROFILE,
  toggleBoardPeripheral,
} from '../src/services/boardProfiles';
import { BOARD_SCREEN_COLS } from '../src/types/contracts';

function readRowAscii(buf: number[], y: number, xStart: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(buf[y * BOARD_SCREEN_COLS + xStart + i] ?? 0);
  }
  return out;
}

describe('OLED 贪吃蛇完整局内行为验证', () => {
  it('编译 0 错误 0 告警，并检测出 sx/sy 一维数组与 screen/tone 外设', () => {
    const engine = createRtlEngine();
    const compiled = engine.compile(SNAKE_CODE);
    expect(compiled.ok).toBe(true);
    expect(compiled.issues).toEqual([]);
    expect(compiled.metadata?.usedOutputs).toContain('screen');
    expect(compiled.metadata?.usedOutputs).toContain('tone');
    expect(compiled.metadata?.arrays?.map((a) => a.name).sort()).toEqual(['sx', 'sy']);
  });

  it('禁止 180° 直接掉头，撞墙后清屏输出 GAME OVER，且复位可重新开局', () => {
    const engine = createRtlEngine();
    expect(engine.compile(SNAKE_CODE).ok).toBe(true);
    engine.reset();

    // Reset + 4 init cycles
    engine.step({ rst_n: 0, key: 0, sw: 0 });
    for (let i = 0; i < 4; i++) engine.step({ rst_n: 1, key: 0, sw: 0 });

    // Snake is moving RIGHT at (6,3); pressing LEFT (key=4) must be ignored
    const afterReverseAttempt = engine.step({ rst_n: 1, key: 4, sw: 0 }).sample;
    expect(afterReverseAttempt.screenBuffer![3 * 16 + 7]).toBe(0x83);

    // Keep moving RIGHT until hitting right wall (x=15) and writing GAME OVER
    let lastSample = afterReverseAttempt;
    for (let i = 0; i < 80; i++) {
      lastSample = engine.step({ rst_n: 1, key: 0, sw: 0 }).sample;
    }

    expect(lastSample.outputs.led & 0x80).toBe(0x80);
    expect(lastSample.outputs.traffic).toBe(0b100);
    expect(readRowAscii(lastSample.screenBuffer!, 3, 3, 9)).toBe('GAME OVER');
    expect(readRowAscii(lastSample.screenBuffer!, 5, 5, 5)).toBe('R:RST');

    // Reset restarts cleanly
    const resetSample = engine.step({ rst_n: 0, key: 0, sw: 0 }).sample;
    expect(resetSample.screenBuffer!.every((v) => v === 0)).toBe(true);
    for (let i = 0; i < 4; i++) {
      lastSample = engine.step({ rst_n: 1, key: 0, sw: 0 }).sample;
    }
    expect(lastSample.outputs.led & 1).toBe(1);
    expect(lastSample.screenBuffer![3 * 16 + 6]).toBe(0x83);
    expect(lastSample.screenBuffer![3 * 16 + 10]).toBe(0x85);
  });

  it('贪吃蛇预设带有 arcade 板卡与 screen 外设元数据', () => {
    const snake = PRESETS.find((p) => p.id === 'snake');
    expect(snake).toBeDefined();
    expect(snake?.boardProfileId).toBe('arcade');
    expect(snake?.requiredPeripherals).toContain('screen');
  });
});

describe('单色 OLED 字模与板卡配置服务', () => {
  it('resolveGlyphBitmap 覆盖 ASCII 字符与 0x80..0x8F 全部 16 个 V3 图块', () => {
    expect(resolveGlyphBitmap(0x00)).toBeNull();
    expect(resolveGlyphBitmap(0x47)).toHaveLength(8); // 'G'
    expect(resolveGlyphBitmap(0x30)).toHaveLength(8); // '0'
    for (let code = 0x80; code <= 0x8f; code++) {
      expect(resolveGlyphBitmap(code)).toHaveLength(8);
    }
  });

  it('toggleBoardPeripheral 正确在预设与自定义板卡间切换且不清空全部外设', () => {
    expect(BOARD_PRESETS.map((b) => b.profile.id)).toEqual(['classic', 'display', 'arcade']);
    const withScreen = toggleBoardPeripheral(DEFAULT_BOARD_PROFILE, 'screen');
    expect(withScreen.id).toBe('custom');
    expect(withScreen.peripherals).toContain('screen');
    expect(withScreen.primaryView).toBe('screen');

    const withoutTraffic = toggleBoardPeripheral(withScreen, 'traffic');
    expect(withoutTraffic.id).toBe('display');
  });
});
