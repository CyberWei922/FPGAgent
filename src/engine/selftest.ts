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
}
