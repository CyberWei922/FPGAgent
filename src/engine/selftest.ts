import {
  BOARD_SCREEN_CELLS,
  BOARD_SCREEN_COLS,
  BOARD_SCREEN_ROWS,
  type BoardOutputs,
  type SelfTestFailure,
  type SelfTestResult,
  type SignalSample,
  type TestVectorStep,
} from '../types/contracts';
import { parseVerilog } from './parser';
import { elaborate, SimulationSession } from './simulator';

const OUTPUT_KEYS: Array<keyof BoardOutputs> = ['led', 'traffic', 'seg'];

function countTotalChecks(vectors: TestVectorStep[]): number {
  let total = 0;
  for (const vec of vectors) {
    if (vec.expect) {
      for (const key of OUTPUT_KEYS) {
        if (vec.expect[key] !== undefined) total += 1;
      }
    }
    if (vec.expectTone !== undefined) total += 1;
    if (vec.expectScreen && vec.expectScreen.length > 0) {
      total += vec.expectScreen.length;
    }
  }
  return total;
}

export function runDeterministicSelfTest(
  code: string,
  vectors: TestVectorStep[],
  previousPassedCycles?: number[]
): SelfTestResult {
  const parsed = parseVerilog(code);
  if (!parsed.ast || parsed.errors.length > 0) {
    return {
      passed: false,
      totalChecks: countTotalChecks(vectors),
      passedChecks: 0,
      passedCycles: [],
      regressedCycles: previousPassedCycles ? [...previousPassedCycles] : [],
      waveform: [],
    };
  }

  try {
    const elaborated = elaborate(parsed.ast);
    const session = new SimulationSession(elaborated);
    const waveform: SignalSample[] = [];

    let totalChecks = 0;
    let passedChecks = 0;
    let firstFailure: SelfTestFailure | undefined;
    let firstUnstableCycle: number | undefined;
    const passedCycles: number[] = [];
    const failedCycles = new Set<number>();

    for (const vec of vectors) {
      const { sample, combLoopDetected } = session.step(vec.inputs);
      waveform.push(sample);
      if (combLoopDetected) {
        firstUnstableCycle ??= vec.cycle;
        failedCycles.add(vec.cycle);
      }

      const hasClassicExpect = Boolean(
        vec.expect && OUTPUT_KEYS.some((signal) => vec.expect?.[signal] !== undefined)
      );
      const hasToneExpect = vec.expectTone !== undefined;
      const hasScreenExpect = Boolean(vec.expectScreen && vec.expectScreen.length > 0);
      if (!hasClassicExpect && !hasToneExpect && !hasScreenExpect) continue;

      let cycleAllPassed = !combLoopDetected;

      if (vec.expect) {
        for (const signal of OUTPUT_KEYS) {
          const expected = vec.expect[signal];
          if (expected === undefined) continue;
          totalChecks += 1;
          const actual = sample.outputs[signal];
          if (actual === expected) {
            if (!combLoopDetected) passedChecks += 1;
          } else {
            cycleAllPassed = false;
            failedCycles.add(vec.cycle);
            if (!combLoopDetected && !firstFailure) {
              firstFailure = {
                cycle: vec.cycle,
                signal,
                expected,
                actual,
                note: vec.note,
              };
            }
          }
        }
      }

      if (vec.expectTone !== undefined) {
        totalChecks += 1;
        const actual = sample.extendedOutputs?.tone ?? 0;
        if (actual === vec.expectTone) {
          if (!combLoopDetected) passedChecks += 1;
        } else {
          cycleAllPassed = false;
          failedCycles.add(vec.cycle);
          if (!combLoopDetected && !firstFailure) {
            firstFailure = {
              cycle: vec.cycle,
              signal: 'tone',
              expected: vec.expectTone,
              actual,
              note: vec.note,
            };
          }
        }
      }

      if (vec.expectScreen && vec.expectScreen.length > 0) {
        for (const cell of vec.expectScreen) {
          totalChecks += 1;
          const inBounds =
            cell.x >= 0 &&
            cell.x < BOARD_SCREEN_COLS &&
            cell.y >= 0 &&
            cell.y < BOARD_SCREEN_ROWS;
          const raw =
            inBounds && sample.screenBuffer
              ? sample.screenBuffer[cell.y * BOARD_SCREEN_COLS + cell.x] ?? 0
              : 0;
          // 显存单元高 4 位为颜色（0 = 单色默认），断言只比较低 8 位内容编码
          const actual = raw & 0xff;
          if (inBounds && actual === cell.code) {
            if (!combLoopDetected) passedChecks += 1;
          } else {
            cycleAllPassed = false;
            failedCycles.add(vec.cycle);
            if (!combLoopDetected && !firstFailure) {
              firstFailure = {
                cycle: vec.cycle,
                signal: 'screen',
                expected: cell.code,
                actual,
                screenCoord: { x: cell.x, y: cell.y },
                note: vec.note,
              };
            }
          }
        }
      }

      if (cycleAllPassed) {
        passedCycles.push(vec.cycle);
      }
    }

    const regressedCycles = (previousPassedCycles ?? []).filter((c) => failedCycles.has(c));

    return {
      passed: firstUnstableCycle === undefined && passedChecks === totalChecks,
      totalChecks,
      passedChecks,
      firstFailure,
      ...(firstUnstableCycle !== undefined && { firstUnstableCycle }),
      passedCycles,
      regressedCycles,
      waveform,
    };
  } catch {
    return {
      passed: false,
      totalChecks: countTotalChecks(vectors),
      passedChecks: 0,
      passedCycles: [],
      regressedCycles: previousPassedCycles ? [...previousPassedCycles] : [],
      waveform: [],
    };
  }
}

export function exportVerilogTestbench(code: string, vectors: TestVectorStep[]): string {
  const parsed = parseVerilog(code);
  const regexMatch = code.match(/\bmodule\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
  const moduleName = parsed.ast?.name ?? regexMatch?.[1] ?? 'top';

  const portNames = new Set(parsed.ast?.ports.map((p) => p.name) ?? []);
  const hasTone = portNames.has('tone') || /\boutput\b[^;)]*\btone\b/.test(code);
  const hasScreen =
    (portNames.has('screen_x') &&
      portNames.has('screen_y') &&
      portNames.has('screen_data') &&
      portNames.has('screen_cmd')) ||
    (/\bscreen_x\b/.test(code) &&
      /\bscreen_y\b/.test(code) &&
      /\bscreen_data\b/.test(code) &&
      /\bscreen_cmd\b/.test(code));

  const wireDecls: string[] = [
    '  wire [7:0] led;',
    '  wire [2:0] traffic;',
    '  wire [15:0] seg;',
  ];
  const dutConnections: string[] = [
    '    .clk(clk),',
    '    .rst_n(rst_n),',
    '    .key(key),',
    '    .sw(sw),',
    '    .led(led),',
    '    .traffic(traffic),',
    '    .seg(seg)',
  ];

  if (hasTone) {
    wireDecls.push('  wire [3:0] tone;');
    dutConnections[dutConnections.length - 1] += ',';
    dutConnections.push('    .tone(tone)');
  }
  if (hasScreen) {
    wireDecls.push(
      '  wire [3:0] screen_x;',
      '  wire [2:0] screen_y;',
      '  wire [7:0] screen_data;',
      '  wire [1:0] screen_cmd;',
      `  reg [7:0] screen_mem [0:${BOARD_SCREEN_CELLS - 1}];`,
      '  integer scr_i;'
    );
    dutConnections[dutConnections.length - 1] += ',';
    dutConnections.push(
      '    .screen_x(screen_x),',
      '    .screen_y(screen_y),',
      '    .screen_data(screen_data),',
      '    .screen_cmd(screen_cmd)'
    );
  }

  const lines: string[] = [
    '`timescale 1ns/1ps',
    '',
    'module tb_top;',
    '  reg clk = 1\'b0;',
    '  reg rst_n = 1\'b0;',
    '  reg [3:0] key = 4\'h0;',
    '  reg [7:0] sw = 8\'h00;',
    ...wireDecls,
    '',
    `  ${moduleName} dut (`,
    ...dutConnections,
    '  );',
    '',
    '  always #5 clk = ~clk;',
    '',
    '  integer errors = 0;',
    '',
    '  initial begin',
    '    $dumpfile("tb_top.vcd");',
    '    $dumpvars(0, tb_top);',
  ];

  if (hasScreen) {
    lines.push(
      `    for (scr_i = 0; scr_i < ${BOARD_SCREEN_CELLS}; scr_i = scr_i + 1) screen_mem[scr_i] = 8'h00;`
    );
  }

  for (const step of vectors) {
    const rstVal = step.inputs.rst_n ? 1 : 0;
    const keyHex = (step.inputs.key & 0xf).toString(16);
    const swHex = (step.inputs.sw & 0xff).toString(16).padStart(2, '0');
    const noteSuffix = step.note ? `: ${step.note.replace(/[\r\n]+/g, ' ')}` : '';
    lines.push(
      `    // Cycle ${step.cycle}${noteSuffix}`,
      `    rst_n = 1'b${rstVal}; key = 4'h${keyHex}; sw = 8'h${swHex};`,
      '    @(posedge clk); #1;'
    );

    if (hasScreen) {
      lines.push(
        `    if (screen_cmd == 2'b10 || screen_cmd == 2'b11) for (scr_i = 0; scr_i < ${BOARD_SCREEN_CELLS}; scr_i = scr_i + 1) screen_mem[scr_i] = 8'h00;`,
        `    if (screen_cmd == 2'b01 || screen_cmd == 2'b11) screen_mem[screen_y * ${BOARD_SCREEN_COLS} + screen_x] = screen_data;`
      );
    }

    if (step.expect?.led !== undefined) {
      const expHex = (step.expect.led & 0xff).toString(16).padStart(2, '0');
      lines.push(
        `    if (led !== 8'h${expHex}) begin $display("FAIL cycle ${step.cycle}: led expected=8'h${expHex} actual=8'h%02h", led); errors = errors + 1; end`
      );
    }
    if (step.expect?.traffic !== undefined) {
      const expBin = (step.expect.traffic & 0x7).toString(2).padStart(3, '0');
      lines.push(
        `    if (traffic !== 3'b${expBin}) begin $display("FAIL cycle ${step.cycle}: traffic expected=3'b${expBin} actual=3'b%03b", traffic); errors = errors + 1; end`
      );
    }
    if (step.expect?.seg !== undefined) {
      const expHex = (step.expect.seg & 0xffff).toString(16).padStart(4, '0');
      lines.push(
        `    if (seg !== 16'h${expHex}) begin $display("FAIL cycle ${step.cycle}: seg expected=16'h${expHex} actual=16'h%04h", seg); errors = errors + 1; end`
      );
    }
    if (hasTone && step.expectTone !== undefined) {
      const expHex = (step.expectTone & 0xf).toString(16);
      lines.push(
        `    if (tone !== 4'h${expHex}) begin $display("FAIL cycle ${step.cycle}: tone expected=4'h${expHex} actual=4'h%01h", tone); errors = errors + 1; end`
      );
    }
    if (hasScreen && step.expectScreen && step.expectScreen.length > 0) {
      for (const cell of step.expectScreen) {
        const idx = cell.y * BOARD_SCREEN_COLS + cell.x;
        const expHex = (cell.code & 0xff).toString(16).padStart(2, '0');
        lines.push(
          `    if (screen_mem[${idx}] !== 8'h${expHex}) begin $display("FAIL cycle ${step.cycle}: screen(${cell.x},${cell.y}) expected=8'h${expHex} actual=8'h%02h", screen_mem[${idx}]); errors = errors + 1; end`
        );
      }
    }
  }

  lines.push(
    '    if (errors == 0) $display("ALL TESTS PASSED");',
    '    else $display("FAILED WITH %0d ERRORS", errors);',
    '    $finish;',
    '  end',
    'endmodule',
    ''
  );

  return lines.join('\n');
}
