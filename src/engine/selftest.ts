import type {
  BoardOutputs,
  SelfTestFailure,
  SelfTestResult,
  SignalSample,
  TestVectorStep,
} from '../types/contracts';
import { parseVerilog } from './parser';
import { elaborate, SimulationSession } from './simulator';

const OUTPUT_KEYS: Array<keyof BoardOutputs> = ['led', 'traffic', 'seg'];

function countTotalChecks(vectors: TestVectorStep[]): number {
  let total = 0;
  for (const vec of vectors) {
    if (!vec.expect) continue;
    for (const key of OUTPUT_KEYS) {
      if (vec.expect[key] !== undefined) total += 1;
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
      if (!vec.expect) continue;

      let hasExpectKey = false;
      let cycleAllPassed = !combLoopDetected;

      for (const signal of OUTPUT_KEYS) {
        const expected = vec.expect[signal];
        if (expected === undefined) continue;
        hasExpectKey = true;
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

      if (hasExpectKey && cycleAllPassed) {
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

  const lines: string[] = [
    '`timescale 1ns/1ps',
    '',
    'module tb_top;',
    '  reg clk = 1\'b0;',
    '  reg rst_n = 1\'b0;',
    '  reg [3:0] key = 4\'h0;',
    '  reg [7:0] sw = 8\'h00;',
    '  wire [7:0] led;',
    '  wire [2:0] traffic;',
    '  wire [15:0] seg;',
    '',
    `  ${moduleName} dut (`,
    '    .clk(clk),',
    '    .rst_n(rst_n),',
    '    .key(key),',
    '    .sw(sw),',
    '    .led(led),',
    '    .traffic(traffic),',
    '    .seg(seg)',
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
