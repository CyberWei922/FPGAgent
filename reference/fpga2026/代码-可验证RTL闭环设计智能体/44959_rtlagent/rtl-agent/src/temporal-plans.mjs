// Bounded verification interpreters derived only from explicit specification
// text and resolved ports. They produce stimuli/expectations, never a DUT.
const hex = n => '0x' + BigInt(n).toString(16);
const word = value => ({ one: 1, two: 2, three: 3, four: 4, first: 1, second: 2, third: 3, fourth: 4 }[value.toLowerCase()] ?? Number(value));
const ready = (family, version, behavior, claim, steps) => steps.length <= 96
  ? { family, version, plan: { schema_version: 1, status: 'ready', constraints: [{ id: 'C1', quote: behavior, claim }], steps } } : null;
const step = (drive, expect = {}) => ({ drive, expect, because: Object.keys(expect).length ? ['C1'] : [] });

function clocked({ clock, reset, data, cycles, update }) {
  const steps = []; let previous = null;
  for (const cycle of cycles) {
    steps.push(step({ [clock.name]: '0', [reset.name]: cycle.reset ? '1' : '0', ...(data ? { [data.name]: hex(cycle.data ?? 0) } : {}) }, previous ?? {}));
    previous = update(cycle);
    steps.push(step({ [clock.name]: '1' }, previous));
  }
  return steps;
}

function registerPlan(behavior, expected, version) {
  const inputs = expected.ports.filter(p => p.direction === 'input'), outputs = expected.ports.filter(p => p.direction === 'output');
  const clock = inputs.find(p => /^(clk|clock)$/i.test(p.name) && p.width === 1);
  const reset = inputs.find(p => /^(reset|rst|areset)$/i.test(p.name) && p.width === 1);
  const data = inputs.filter(p => p !== clock && p !== reset), output = outputs[0];
  if (!clock || outputs.length !== 1 || data.length !== 1 || inputs.length !== (reset ? 3 : 2)
      || data[0].width !== output.width || output.width > 64) return null;
  if (!/\bD\s+flip-flops?\b/i.test(behavior) || /\b(?:enable|byte|shift|pipeline|latch|invert|complement|priority|load)\b/i.test(behavior)) return null;
  const count = /\b(?:include|includes)\s+(\d+)\s+D\s+flip-flops?\b/i.exec(behavior);
  if (!count || Number(count[1]) !== output.width) return null;
  const edge = /\b(?:DFFs?|flip-flops?)\b[\s\S]{0,90}?\b(positive|negative)\s+edge\b/i.exec(behavior);
  if (!edge || /\b(?:positive|rising)\s+edge\b/i.test(behavior) && /\b(?:negative|falling)\s+edge\b/i.test(behavior)) return null;
  const asynchronous = /\basynchronous\s+reset\b/i.test(behavior);
  if (asynchronous && /\bsynchronous\s+reset\b/i.test(behavior)) return null;
  let seed = 0n;
  if (reset) {
    if (!/\bactive(?:\s+|-)high\s+(?:synchronous|asynchronous)\s+reset\b/i.test(behavior)) return null;
    const value = /\breset(?:ting)?\b[\s\S]{0,90}?\bto\s+(0x[\da-f]+|\d+|zero)\b/i.exec(behavior);
    if (!value) return null;
    seed = value[1].toLowerCase() === 'zero' ? 0n : BigInt(value[1]);
    if (seed >= 1n << BigInt(output.width)) return null;
  } else if (/\breset|initial|preset\b/i.test(behavior)) return null;
  const max = (1n << BigInt(output.width)) - 1n;
  let alternating = 0n; for (let i = 0; i < output.width; i += 2) alternating |= 1n << BigInt(i);
  const cycles = [{ reset: !!reset, data: max ^ seed }, ...[max, 0n, alternating, max ^ alternating, 1n, max].map(data => ({ reset: false, data }))];
  if (reset) cycles.push({ reset: true, data: max ^ seed }, { reset: true, data: seed }, { reset: false, data: max ^ seed }, { reset: false, data: 0n });
  const steps = [], active = edge[1].toLowerCase() === 'positive' ? '1' : '0'; let previous = null;
  for (const cycle of cycles) {
    const setupExpected = previous === null ? {} : { [output.name]: hex(asynchronous && cycle.reset ? seed : previous) };
    steps.push(step({ [clock.name]: active === '1' ? '0' : '1', [data[0].name]: hex(cycle.data), ...(reset ? { [reset.name]: cycle.reset ? '1' : '0' } : {}) }, setupExpected));
    previous = cycle.reset ? seed : cycle.data;
    steps.push(step({ [clock.name]: active }, { [output.name]: hex(previous) }));
  }
  return ready('edge_triggered_register', version, behavior,
    `Each ${edge[1]} clock edge samples ${data[0].name} into ${output.name}, with no additional cycle. ${reset ? `Active-high ${asynchronous ? 'asynchronous' : 'synchronous'} reset sets ${output.name} to ${seed}; ${asynchronous ? 'assertion takes effect between clock edges' : 'assertion between active edges must not change the output until the active edge'}.` : 'No reset or initial value is specified; check outputs only after the first sampling edge.'}`, steps);
}

function counterPlan(behavior, expected, version) {
  const inputs = expected.ports.filter(p => p.direction === 'input'), outputs = expected.ports.filter(p => p.direction === 'output');
  const clock = inputs.find(p => /^(clk|clock)$/i.test(p.name) && p.width === 1), reset = inputs.find(p => /^(reset|rst)$/i.test(p.name) && p.width === 1);
  if (!clock || !reset || inputs.length !== 2 || outputs.length !== 1 || outputs[0].width > 16) return null;
  if (!/\bcounter\b/i.test(behavior) || !/\bcounts?\s+(?:from\s+)?\d+\s+through\s+\d+\s*,?\s*inclusive\b/i.test(behavior)
      || !/\bactive(?:\s+|-)high\s+synchronous\b/i.test(behavior) || !/\bpositive\s+edge\b/i.test(behavior)
      || /\b(?:enable|load|down|decrement|asynchronous|saturat\w*|BCD|binary-coded|preset|pause)\b/i.test(behavior)) return null;
  const range = /\bcounts?\s+(?:from\s+)?(\d+)\s+through\s+(\d+)\s*,?\s*inclusive\b/i.exec(behavior);
  const resetValue = /\breset\s+the\s+counter\s+to\s+(\d+)\b/i.exec(behavior);
  if (!range || !resetValue) return null;
  const low = Number(range[1]), high = Number(range[2]), seed = Number(resetValue[1]);
  const period = /\bperiod\s+of\s+(\d+)\b/i.exec(behavior);
  if (low >= high || high >= 2 ** outputs[0].width || high - low > 30 || seed < low || seed > high
      || period && Number(period[1]) !== high - low + 1) return null;
  const cycles = [{ reset: true }, ...Array.from({ length: high - low + 3 }, () => ({ reset: false })), { reset: true }, { reset: false }];
  let value = seed;
  const steps = clocked({ clock, reset, cycles, update: cycle => {
    value = cycle.reset ? seed : value === high ? low : value + 1; return { [outputs[0].name]: hex(value) };
  } });
  return ready('bounded_range_counter', version, behavior,
    `At each rising edge, active-high synchronous reset sets ${outputs[0].name} to ${seed}; otherwise increment by one, wrapping ${high} to ${low}. The interval is inclusive. Preserve the output between rising edges; do not add an extra endpoint cycle.`, steps);
}

function protocolPlan(behavior, expected, version) {
  const inputs = expected.ports.filter(p => p.direction === 'input'), outputs = expected.ports.filter(p => p.direction === 'output');
  const clock = inputs.find(p => /^(clk|clock)$/i.test(p.name) && p.width === 1), reset = inputs.find(p => /^(reset|rst)$/i.test(p.name) && p.width === 1);
  const data = inputs.find(p => p !== clock && p !== reset);
  if (!clock || !reset || !data || inputs.length !== 3 || !outputs.length || outputs.some(p => p.width !== 1)
      || !/\b(?:active(?:\s+|-)high\s+synchronous|synchronous\s*,?\s*active(?:\s+|-)high)\s+reset\b|\breset\b[^.]{0,45}\bactive(?:\s+|-)high\s+synchronous\b/i.test(behavior)
      || !/\bpositive\s+edge\b/i.test(behavior) || /\b(?:asynchronous|negedge|negative edge|active(?:\s+|-)low|enable|parity|sticky|toggle|stretch)\b/i.test(behavior)) return null;
  if (outputs.length === 1 && data.width >= 2 && data.width <= 16 && /\bPS\/?2\b/i.test(behavior)) {
    const length = /\bmessages\s+that\s+are\s+(\w+)\s+bytes\s+long\b/i.exec(behavior);
    const marker = new RegExp(`\\b${data.name}\\[(\\d+)\\]\\s*=\\s*1`, 'i').exec(behavior);
    const timing = /\bcycle\s+immediately\s+after\s+the\s+(\w+)\s+byte\b/i.exec(behavior);
    const n = length && word(length[1]), bit = marker && Number(marker[1]);
    if (!length || !marker || !timing || ![2, 3, 4].includes(n) || word(timing[1]) !== n || bit >= data.width
        || !/\bdiscard\s+bytes\s+until\b/i.test(behavior)) return null;
    const mask = 1 << bit, max = 2 ** data.width - 1;
    const cycles = [{ reset: true, data: 0 }, { data: 0 }, { data: max ^ mask }];
    const packet = values => cycles.push(...[mask, ...values].map(data => ({ data })));
    packet(Array.from({ length: n - 1 }, (_, i) => i % 2 ? mask : 0));
    packet(Array.from({ length: n - 1 }, (_, i) => i % 2 ? 0 : max));
    cycles.push({ data: 0 }, { data: mask }, { reset: true, data: max }, { data: 0 });
    packet(Array(n - 1).fill(mask)); cycles.push({ data: 0 });
    let remaining = 0;
    const steps = clocked({ clock, reset, data, cycles, update: cycle => {
      let done = 0;
      if (cycle.reset) remaining = 0;
      else if (remaining) { remaining--; done = Number(remaining === 0); }
      else if (Number(cycle.data ?? 0) & mask) remaining = n - 1;
      return { [outputs[0].name]: String(done) };
    } });
    return ready('byte_packet_boundary', version, behavior,
      `Sample one byte per rising edge. While searching, ${data.name}[${bit}]=1 identifies byte 1; consume the following ${n - 1} bytes regardless of that marker. Assert ${outputs[0].name} for the cycle immediately following receipt of byte ${n}, then search for the next packet, including back-to-back packets. Synchronous reset abandons any partial packet.`, steps);
  }
  if (outputs.length === 1 && data.width === 1 && /\bserial\b/i.test(behavior)) {
    const format = /\bone\s+start\s+bit\s*\(0\)\s*,\s*(\d+)\s+data\s+bits\s*,\s*and\s+1\s+stop\s+bit\s*\(1\)/i.exec(behavior);
    const n = format && Number(format[1]);
    if (!format || n < 1 || n > 8 || !/\bstop\s+bit\s+does\s+not\s+appear[\s\S]{0,220}\bwait\b[\s\S]{0,100}\bstop\s+bit\b/i.test(behavior)) return null;
    const cycles = [{ reset: true, data: 1 }, { data: 1 }, { data: 1 }];
    const frame = (value, stop) => cycles.push(...[0, ...Array.from({ length: n }, (_, i) => value >> i & 1), stop].map(data => ({ data })));
    frame(0x96, 1); frame(0xa5, 1); frame(0x3c, 0);
    cycles.push({ data: 0 }, { data: 0 }, { data: 1 }); frame(0x69, 1);
    let phase = 'idle', remaining = 0;
    const steps = clocked({ clock, reset, data, cycles, update: cycle => {
      let done = 0; const value = cycle.data;
      if (cycle.reset) { phase = 'idle'; remaining = 0; }
      else if (phase === 'idle') { if (!value) { phase = 'data'; remaining = n; } }
      else if (phase === 'data') { if (--remaining === 0) phase = 'stop'; }
      else if (phase === 'stop') { if (value) { done = 1; phase = 'idle'; } else phase = 'wait'; }
      else if (value) phase = 'idle';
      return { [outputs[0].name]: String(done) };
    } });
    return ready('serial_frame_boundary', version, behavior,
      `Sample the start 0, exactly ${n} data bits, then stop 1 on successive rising edges. ${outputs[0].name} signals a correctly received byte after the stop bit has been sampled, not after the last data bit; clear it on the next cycle. A missing stop enters recovery: ignore further 0s until a 1 is seen, then search for a fresh start 0. Reset returns to idle.`, steps);
  }
  if (outputs.length === 3 && data.width === 1 && /\bHDLC\b/i.test(behavior) && /\bMoore-type\b/i.test(behavior)
      && /\bprevious\s+input\s+were\s+0\b/i.test(behavior) && /\bcomplete\s+cycle\b/i.test(behavior)) {
    const a = /\bafter\s+every\s+(\d+)\s+consecutive\s+1s\b/i.exec(behavior), b = /\bexactly\s+(\d+)\s+consecutive\s+1s\b/i.exec(behavior), c = /\b(\d+)\s+or\s+more\s+consecutive\s+1s\b/i.exec(behavior);
    const disc = /\(1\)[^\n]*discarded\s*\((\w+)\)/i.exec(behavior)?.[1], flag = /\(2\)[^\n]*frame\s*\((\w+)\)/i.exec(behavior)?.[1], err = /\(3\)[^\n]*\((\w+)\)\./i.exec(behavior)?.[1];
    if (!a || !b || !c || new Set([disc, flag, err]).size !== 3 || ![disc, flag, err].every(n => outputs.some(p => p.name === n))) return null;
    const discardN = Number(a[1]), flagN = Number(b[1]), errorN = Number(c[1]);
    if (discardN < 2 || discardN > 5 || flagN !== discardN + 1 || errorN !== flagN + 1) return null;
    // The completing zero is also the prefix zero of the next event. An extra
    // idle zero here used to hide implementations that drop that boundary.
    const cycles = [{ reset: true, data: 0 }], run = (n, end = 0) => cycles.push(...Array(n).fill(1).map(data => ({ data })), { data: end });
    run(discardN); run(flagN); run(errorN + 1); run(discardN - 1); run(flagN);
    cycles.push({ data: 1 }, { data: 1 }, { reset: true, data: 1 }, ...Array(discardN - 2).fill(1).map(data => ({ data })), { data: 0 });
    let ones = 0;
    const steps = clocked({ clock, reset, data, cycles, update: cycle => {
      const result = { [disc]: '0', [flag]: '0', [err]: '0' };
      if (cycle.reset) ones = 0;
      else if (cycle.data) { ones = Math.min(errorN, ones + 1); result[err] = String(Number(ones >= errorN)); }
      else { result[disc] = String(Number(ones === discardN)); result[flag] = String(Number(ones === flagN)); ones = 0; }
      return result;
    } });
    return ready('consecutive_one_framing', version, behavior,
      `Use the sampled consecutive-one history: ${discardN} ones followed by 0 produces ${disc}; ${flagN} followed by 0 produces ${flag}; ${errorN} or more consecutive ones asserts ${err} until a 0 arrives. Moore outputs describe the state after the edge that sampled the completing bit, remain stable between edges, and clear/reset as specified. Reset establishes previous input 0.`, steps);
  }
  return null;
}

export function compileTemporalPlan(behavior, expected, version) {
  return registerPlan(behavior, expected, version) ?? counterPlan(behavior, expected, version) ?? protocolPlan(behavior, expected, version);
}
