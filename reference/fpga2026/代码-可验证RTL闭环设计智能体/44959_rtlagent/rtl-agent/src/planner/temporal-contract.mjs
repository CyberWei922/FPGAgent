import { invariant } from '../dual/snapshot.mjs';
import { planProse } from './prose.mjs';

// Method adaptation, not an imported Python runtime or an LTL/SVA solver.
// nl2spec @ 1765c9cd1069ee560ae67ea71e67c8fa134b3d14 (MIT).
// See third_party/nl2spec/NOTICE.md for provenance and intentional differences.
export const TEMPORAL_VERSION = 'rtl2llm.nl2spec-temporal.v1';
export const TIMING_POINTER = 'See Temporal contract.';
const KEYS = ['requirements', 'status', 'sample', 'when', 'relation', 'cycles', 'then', 'unless', 'boundary'];
const RELATIONS = ['same_sample', 'after_samples', 'until', 'always', 'unspecified'];
const check = (condition, message) => invariant(condition, 'PLAN_TEMPORAL_INVALID', message);
const boundedProse = value => {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= 600 && !/[\r\n\u0000-\u001f]/u.test(value), 'Each temporal text field must be one nonempty line of at most 600 characters.');
  planProse(value);
};

export const TEMPORAL_INSTRUCTIONS = `
NL2SPEC-INSPIRED TEMPORAL ADAPTATION (not an RTL generator or proof engine):
Translate source fragments into small, source-linked temporal requirements. Return only the public contract, not a thinking transcript. Use the existing Requirements R IDs as the source-fragment dictionary; prioritize BEHAVIOR over repeating interface declarations. A matching quotation is provenance, not proof of your interpretation.
Keep the existing headings, but insert exactly one ## Temporal contract immediately AFTER ## Timing. Under ## Timing write only: ${TIMING_POINTER}
The new section has exactly this form (one JSON object per rule line, no code fences):
risk: low|high|uncertain
reason: task-specific reason for temporal risk, independent of size and decomposition
- T1: {"requirements":["R1"],"status":"specified","sample":"explicit clock edge and observation phase, or unspecified","when":"trigger in words","relation":"after_samples","cycles":1,"then":"required behavior in words","unless":"source-backed exception, or unspecified","boundary":"a source-backed boundary scenario to check, NOT an observed result"}
Use 1-8 rules for sequential behavior; only purely combinational tasks may replace all rule lines with rules: none. Do not include other fields. Reference only accepted source excerpts in Requirements. Text fields are single-line prose of at most 600 characters. No HDL statements, SVA, executable tests or shell commands.
status is specified or unresolved. relation is same_sample, after_samples, until, always or unspecified. cycles is 0 for same_sample, a positive integer for after_samples, and null otherwise. If the timing meaning is unresolved, use status unresolved, relation unspecified, cycles null; do not choose a convenient default. Unresolved rules are questions, never implementation requirements. Never silently add a clock, reset, latency, handshake, packet gap or output value absent from the source.
Sampling MUST distinguish which clock/edge is used and whether values mean before the edge or after sequential updates; if the original leaves this ambiguous, say so. Include source-backed reset polarity/kind/priority, hold behavior, count inclusion/exclusion, simultaneous events and continuous traffic where relevant. Until/always are prose relations in this adapter, not executable LTL semantics.
risk high: simultaneous events, inclusive/exclusive count boundaries, interacting histories, pipeline alignment, backpressure, nontrivial reset priority or multiple clocks require special care even in a tiny FSM. low: explicit straightforward timing or combinational behavior. uncertain: unresolved temporal meaning. High risk does NOT require physical/logical splitting. A high-risk small task may stay moderate with decomposition none.
For high risk, make boundary concrete: name the competing events or the boundary sample and required behavior. Do not write only 'check timing'. For low risk, keep the contract short. An unresolved rule requires risk uncertain (the program also enforces this).
SYNTHETIC TEACHING EXAMPLES ONLY, never requirements for the current task:
Source 'On a rising edge of clk, a request requires a grant at the next rising edge, unless reset intervenes.' => after_samples / 1, with the stated reset exception. It does NOT specify the grant value at all other times.
Source 'Accept the next transaction on the same sampling edge as completion.' => same_sample / 0; do not insert an idle sample. Conversely 'after two samples' is not 'same sample'.
Source with no reset polarity => unspecified, not an invented active-high reset.
Check each subtranslation against its own source fragment and any supplied waveform before submitting. These examples teach the mapping, not a solution template. Preserve the original 12000-byte total plan target; omit redundant prose, never the original task from a handoff.
`;

export function parseTemporalContract(text, constraints) {
  const lines = text.split('\n').filter(line => line.trim());
  check(/^risk: (low|high|uncertain)$/.test(lines[0] ?? ''), 'Temporal contract must start with risk: low|high|uncertain.');
  check(/^reason: .+/.test(lines[1] ?? ''), 'Temporal contract needs one reason line after risk.');
  const requestedRisk = lines[0].slice(6), reason = lines[1].slice(8);
  boundedProse(reason);
  const empty = lines.length === 3 && lines[2] === 'rules: none';
  check(!empty || requestedRisk === 'low', 'Only low-risk combinational plans may use rules: none.');
  const rows = empty ? [] : lines.slice(2);
  check(empty || (rows.length > 0 && rows.length <= 8), 'Temporal contract requires 1-8 rule lines, or rules: none for combinational tasks.');
  const sources = new Map(constraints.map(c => [c.id, c]));
  const seen = new Set();
  const rules = rows.map(line => {
    const match = /^- (T[1-9]\d*): (\{.*\})$/.exec(line);
    check(match && !seen.has(match[1]), 'Each temporal rule needs a unique T ID and one JSON object.');
    seen.add(match[1]);
    let rule;
    try { rule = JSON.parse(match[2]); } catch { check(false, 'Temporal rule JSON is invalid.'); }
    check(rule && !Array.isArray(rule) && Object.keys(rule).length === KEYS.length && KEYS.every(k => Object.hasOwn(rule, k)), 'Temporal rule has missing or unknown fields.');
    check(Array.isArray(rule.requirements) && rule.requirements.length > 0 && rule.requirements.length <= 4 && new Set(rule.requirements).size === rule.requirements.length && rule.requirements.every(id => sources.has(id)), 'Temporal rule must reference 1-4 distinct source-matched Requirement R IDs; fabricated/rejected quotes cannot be used.');
    check(['specified', 'unresolved'].includes(rule.status) && RELATIONS.includes(rule.relation), 'Unknown temporal status or relation.');
    for (const key of ['sample', 'when', 'then', 'unless', 'boundary']) boundedProse(rule[key]);
    check(rule.relation === 'same_sample' ? rule.cycles === 0
      : rule.relation === 'after_samples' ? Number.isSafeInteger(rule.cycles) && rule.cycles > 0
      : rule.cycles === null, 'Temporal relation and cycles disagree: same_sample=0, after_samples=positive integer, others=null.');
    check((rule.status === 'unresolved') === (rule.relation === 'unspecified'), 'Unresolved timing requires relation unspecified; specified timing must not use unspecified.');
    return {id: match[1], ...rule, sources: rule.requirements.map(id => ({...sources.get(id)}))};
  });
  const risk = rules.some(r => r.status === 'unresolved') ? 'uncertain' : requestedRisk;
  return {version: TEMPORAL_VERSION, status: 'advisory', requested_risk: requestedRisk, risk,
    routing_guard: risk !== requestedRisk ? 'unresolved_timing_requires_uncertain' : null,
    reason, rules, validation: 'structure_and_source_provenance_only', semantic_verified: false};
}

export function temporalMarkdown(contract) {
  if (!contract || contract.status !== 'advisory') return 'Temporal planning unavailable. Use the original specification; do not invent timing constraints.';
  const out = [`Temporal risk: ${contract.risk}`, `Reason: ${contract.reason}`,
    'ADVISORY source-linked interpretation, NOT a proof, executable assertion, observed waveform or test result. Original specification always wins.'];
  if (!contract.rules.length) out.push('No temporal rules proposed (planner classified this as combinational).');
  for (const r of contract.rules) {
    out.push(`\n### ${r.id} — ${r.status === 'unresolved' ? 'UNRESOLVED QUESTION — do not implement as a requirement' : 'proposed temporal requirement'}`);
    for (const s of r.sources) out.push(`Source ${s.id} [${s.source}]: ${JSON.stringify(s.quote)}`);
    out.push(`Sampling: ${r.sample}`, `When: ${r.when}`, `Relation: ${r.relation}; samples: ${r.cycles ?? 'not specified as a count'}`,
      `Required behavior${r.status === 'unresolved' ? ' (unresolved)' : ''}: ${r.then}`, `Exception: ${r.unless}`, `Boundary proposal: ${r.boundary}`);
  }
  return out.join('\n');
}
