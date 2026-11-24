// Verification vectors for an explicitly described right-shifting Galois LFSR.
// This module never emits a DUT and never reads task IDs, answers or fixtures.
export function compileLfsrPlan(behavior, expected, version) {
  const inputs = expected.ports.filter(p => p.direction === 'input'), outputs = expected.ports.filter(p => p.direction === 'output');
  const clock = inputs.find(p => /^(clk|clock)$/i.test(p.name) && p.width === 1);
  const reset = inputs.find(p => /^(reset|rst)$/i.test(p.name) && p.width === 1), output = outputs[0];
  if (inputs.length !== 2 || outputs.length !== 1 || !clock || !reset || output.width < 2 || output.width > 64) return null;
  if (!/\bGalois\s+LFSR\b/i.test(behavior) || !/\bshifts?\s+right\b/i.test(behavior)
      || !/\bLSB\b/i.test(behavior) || !/\bXOR(?:ed)?\b/i.test(behavior)
      || !/\btap["']?\s+is\s+XORed[\s\S]{0,80}\bLSB\b/i.test(behavior)
      || !/\bwithout\s+(?:a\s+)?tap\b[\s\S]{0,40}\bshift\s+right\s+unchanged\b/i.test(behavior)
      || !/\bactive[ -]high\s+synchronous\s+reset\b/i.test(behavior)
      || !/\b(?:positive|rising)\s+edge\b|\bposedge\b/i.test(behavior)) return null;
  if (/\b(?:Fibonacci|left|asynchronous|negedge|enable|load|reseed|inverted|XNOR)\b|active[ -]low/i.test(behavior)) return null;
  const list = /\btaps?\s+at\s+(?:bit\s+)?positions?\s+(\d+(?:\s*(?:,\s*(?:and\s+)?|and\s+)\d+){0,15})\s*[.;]/i.exec(behavior);
  const initial = /\breset[\s\S]{0,100}?\b(?:output|state|register)\s+to\s+(\d+)\b/i.exec(behavior);
  if (!list || !initial) return null;
  const taps = list[1].match(/\d+/g).map(Number), width = output.width, seed = BigInt(initial[1]);
  const declared = [...behavior.matchAll(/\b(\d+)[ -]bit\b[^.]{0,60}?\bGalois\s+LFSR\b/ig)];
  if (declared.some(match => Number(match[1]) !== width) || [...behavior.matchAll(/\btaps?\s+at\s+(?:bit\s+)?positions?\s+\d+/ig)].length !== 1) return null;
  // A tap at N disambiguates one-based stage numbering from q[N-1:0].
  if (new Set(taps).size !== taps.length || Math.max(...taps) !== width || Math.min(...taps) < 1 || seed < 1n || seed >= 1n << BigInt(width)) return null;
  const mask = taps.reduce((value, stage) => value | 1n << BigInt(stage - 1), 0n);
  const advance = state => state >> 1n ^ (state & 1n ? mask : 0n);
  if (width <= 8 && /\bmaxim(?:um|al)[ -]length\b/i.test(behavior)) {
    let state = seed; const seen = new Set();
    do { if (!state || seen.has(state)) return null; seen.add(state); state = advance(state); } while (state !== seed);
    if (seen.size !== 2 ** width - 1) return null;
  }
  const hex = value => '0x' + value.toString(16), steps = [];
  let previous = null;
  const cycle = (asserted, next) => {
    steps.push({ drive: { [clock.name]: '0', [reset.name]: asserted ? '1' : '0' },
      expect: previous === null ? {} : { [output.name]: hex(previous) }, because: previous === null ? [] : ['C1'] });
    steps.push({ drive: { [clock.name]: '1' }, expect: { [output.name]: hex(next) }, because: ['C1'] });
    previous = next;
  };
  cycle(true, seed);
  let state = seed;
  for (let i = 0; i < Math.min(2 ** width - 1, 40); i++) { state = advance(state); cycle(false, state); }
  cycle(true, seed); state = seed;
  for (let i = 0; i < 2; i++) { state = advance(state); cycle(false, state); }
  return { family: 'right_galois_lfsr', version, plan: { schema_version: 1, status: 'ready',
    constraints: [{ id: 'C1', quote: behavior,
      claim: `Use the explicitly specified right-shifting Galois recurrence with OLD ${output.name}[0] as feedback. Tap positions ${taps.join(', ')} are one-based stages: stage k denotes destination bit k-1, not the source bit. Every untapped bit receives the OLD bit immediately above it. The shifted-in top bit is zero before XOR feedback is applied. All next-state bits update together on the rising edge; active-high synchronous reset sets the state to ${seed}. Trace the first non-reset transition before emitting RTL; preserve this convention for every bit.` }], steps } };
}
