// Conservative, specification-derived verification only. No task IDs, answers,
// files, model calls or DUT implementations are used by this optional fast path.
import { compileLfsrPlan } from './lfsr-plan.mjs';
import { compileTemporalPlan } from './temporal-plans.mjs';
export const COMPILED_PLAN_VERSION = 'bounded-specification-patterns-v4';
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

function capturePlan(behavior, expected) {
  if (expected.ports.length !== 4) return null;
  const inputs = expected.ports.filter(p => p.direction === 'input'), outputs = expected.ports.filter(p => p.direction === 'output');
  const clock = inputs.find(p => /^(clk|clock)$/i.test(p.name) && p.width === 1), reset = inputs.find(p => /^(reset|rst)$/i.test(p.name) && p.width === 1);
  const data = inputs.find(p => p !== clock && p !== reset), output = outputs[0];
  if (inputs.length !== 3 || outputs.length !== 1 || !clock || !reset || !data || output.width !== data.width) return null;
  if (!/\bchanges?\s+from\s+1\b[\s\S]{0,60}\bto\s+0\b/i.test(behavior)
      || !/\b(?:remain|stay|hold)[\s\S]{0,30}\b(?:1|set)\b[\s\S]{0,40}\buntil\b[\s\S]{0,40}\breset\b/i.test(behavior)
      || !/\bactive[ -]high\b/i.test(behavior) || !/\bsynchronous\s+reset\b/i.test(behavior)
      || !/\b(?:positive|rising)\s+edge\b|\bposedge\b/i.test(behavior)) return null;
  if (/\b(?:only|except|unless|ignore|enable|mask|toggle|asynchronous|negative|negedge|preset|invert|complement|latency|delay|pipeline)\b|single[ -]cycle|one[ -]cycle pulse|reset\s+to\s+1|previous[\s\S]{0,40}(?:clear|reset)|reset[\s\S]{0,40}(?:history|previous)/i.test(behavior)) return null;
  const width = data.width, max = (1n << BigInt(width)) - 1n;
  let alternating = 0n; for (let i = 0; i < width; i += 2) alternating |= 1n << BigInt(i);
  const cycles = [[max, true], [0n, false], [max, false], [alternating, false], [0n, true],
    [alternating, false], [max, false], [alternating, false], [0n, false], [max, false], [max, true], [0n, false]];
  // All-zero/all-one/alternating patterns alone cannot distinguish bits with
  // equal parity. Binary index patterns distinguish every bit with O(log width)
  // reset/transition pairs instead of an unbounded one-hot sweep.
  for (let bit = 0; bit < Math.ceil(Math.log2(width)); bit++) {
    let falling = 0n;
    for (let index = 0; index < width; index++) if (index & (2 ** bit)) falling |= 1n << BigInt(index);
    cycles.push([max, true], [max ^ falling, false]);
  }
  let previous = 0n, captured = 0n, initialized = false;
  const steps = [], hex = n => '0x' + n.toString(16);
  for (const [value, asserted] of cycles) {
    steps.push({ drive: { [clock.name]: '0', [reset.name]: asserted ? '1' : '0', [data.name]: hex(value) }, expect: initialized ? { [output.name]: hex(captured) } : {}, because: initialized ? ['C1'] : [] });
    captured = asserted ? 0n : captured | (previous & (max ^ value));
    previous = value; initialized = true;
    steps.push({ drive: { [clock.name]: '1' }, expect: { [output.name]: hex(captured) }, because: ['C1'] });
  }
  return { family: 'sticky_falling_capture', version: COMPILED_PLAN_VERSION, plan: { schema_version: 1, status: 'ready',
    constraints: [{ id: 'C1', quote: behavior, claim: `On each rising edge, capture bits whose sampled input changed from 1 to 0. Captured output bits remain set until active-high synchronous reset clears them. Input history follows every clock sample, including samples during output reset; do not discard that input observation.` }], steps } };
}

export function compileVectorPlan({ spec, expected }) {
  if (typeof spec !== 'string' || spec.length > 6000 || expected.unresolved?.length || ![2, 3, 4, 5, 6].includes(expected.ports?.length)) return null;
  const inputs = expected.ports.filter(p => p.direction === 'input'), outputs = expected.ports.filter(p => p.direction === 'output');
  if (!outputs.length || expected.ports.some(p => !ID.test(p.name) || !Number.isSafeInteger(p.width) || p.width < 1 || p.width > 4096)) return null;
  // Require a resolved, matching bullet interface followed by the behavior.
  // Other input formats and prose before the interface use the model fallback.
  const bullets = [...spec.matchAll(/^\s*-\s*(input|output|inout)\s+([A-Za-z_][A-Za-z0-9_]*)[^\n]*$/gm)];
  if (bullets.length !== expected.ports.length || bullets.some(b => {
    const declaredWidth = /\(\s*(\d+)\s*bits?\s*\)/i.exec(b[0]);
    return !expected.ports.some(p => p.name === b[2] && p.direction === b[1] && p.width === Number(declaredWidth?.[1] ?? 1));
  })) return null;
  const prefix = spec.slice(0, bullets[0].index).replace(/unless\s+otherwise\s+specified/ig, '');
  if (/\b(?:revers\w*|population|popcount|if|when|unless|reset|enable|clock|latency|cycle)\b/i.test(prefix)) return null;
  const behavior = spec.slice(bullets.at(-1).index + bullets.at(-1)[0].length).trim();
  if (behavior.length < 6 || behavior.length > 2000) return null;
  const temporal = compileTemporalPlan(behavior, expected, COMPILED_PLAN_VERSION);
  if (temporal) return temporal;
  if (outputs.length !== 1) return null;
  const lfsr = compileLfsrPlan(behavior, expected, COMPILED_PLAN_VERSION);
  if (lfsr) return lfsr;
  const capture = capturePlan(behavior, expected);
  if (capture) return capture;
  if (inputs.length !== 1 || expected.ports.length !== 2) return null;
  if (behavior.length < 6 || behavior.length > 2000 || /\b(?:not|never|without|if|when|unless|except|only|instead|reset|enable|clock|cycle|latency|delay|edge|register|pipeline|consecutive|leading|trailing|mask|preserve|first|last|pair|group|subrange|rotate|shift|increment|decrement|complement|invert|plus|modulo|threshold|greater|less)\b/i.test(behavior)) return null;
  const reverse = /\brevers(?:e|es|ing|ed)\b[\s\S]{0,60}\bbit\s+(?:order(?:ing)?|positions?)|\bbit[- ]revers(?:e|al)\b|\brevers(?:e|es|ing|ed)\b[\s\S]{0,40}\bbits\b/i.test(behavior);
  const popcount = /\bpopulation\s+count\b|\bpopcount\b|\bcounts?\s+the\s+number\s+of\s+['"]?1['"]?s?\b/i.test(behavior);
  if (Number(reverse) + Number(popcount) !== 1) return null;
  const input = inputs[0], output = outputs[0], width = input.width;
  if (reverse && (output.width !== width || width > 8 && /\bbytes?\b/i.test(behavior))) return null;
  if (popcount && (output.width !== Math.ceil(Math.log2(width + 1)) || /\bzeros?\b/i.test(behavior))) return null;
  const max = (1n << BigInt(width)) - 1n;
  const values = new Set([0n, max]);
  for (const n of [0, 1, 2, Math.floor(width / 2), width - 3, width - 2, width - 1]) if (n >= 0 && n < width) values.add(1n << BigInt(n));
  let alternating = 0n;
  for (let i = 0; i < width; i += 2) alternating |= 1n << BigInt(i);
  values.add(alternating); values.add(max ^ alternating);
  // A fixed asymmetric pattern exercises interactions beyond single set bits.
  values.add(0x96n & max);
  const stimulus = [...values];
  if (stimulus.length < 3) stimulus.push(0n);
  const evaluate = value => {
    if (popcount) { let count = 0n; for (let x = value; x; x >>= 1n) count += x & 1n; return count; }
    let result = 0n;
    for (let i = 0; i < width; i++) result = (result << 1n) | ((value >> BigInt(i)) & 1n);
    return result;
  };
  const family = reverse ? 'bit_reversal' : 'population_count';
  return { family, version: COMPILED_PLAN_VERSION, plan: { schema_version: 1, status: 'ready',
    constraints: [{ id: 'C1', quote: behavior, claim: reverse
      ? `Combinationally reverse all ${width} packed bits from ${input.name} to ${output.name}; input bit k maps to output bit ${width}-1-k.`
      : `Combinationally count all set bits of ${input.name}; ${output.name} is the exact count from 0 through ${width}.` }],
    steps: stimulus.map(value => ({ drive: { [input.name]: '0x' + value.toString(16) }, expect: { [output.name]: '0x' + evaluate(value).toString(16) }, because: ['C1'] })) } };
}
