export const REASONING_GUIDANCE_VERSION = 'rtl-convergence-v1';

export const AUTHOR_STAGE_POLICY_VERSION = 'rtl-author-stages-v1';
// The controller enforces separate calls, not the contents of hidden reasoning.
export function authorStageGuidance(stage) {
  if (!['generate', 'repair'].includes(stage)) throw new Error('Unknown author stage');
  return `Author stage policy: ${AUTHOR_STAGE_POLICY_VERSION}.\n` + (stage === 'generate'
    ? 'This conversation is GENERATION ONLY. Think as needed to understand the requirements and design one implementation, then write and submit the complete requested RTL. Do not run a mental simulation, enumerate test vectors, write a test report, or start a self-review/debug/rewrite cycle after drafting the code. Do not output intermediate drafts. Once the complete implementation is written, close the answer and end your turn immediately. The controller performs checks AFTER submission; any evidence-based repair is a separate conversation. No previous candidate means this is generation, including recovery from an incomplete response, not circuit repair.'
    : 'This conversation is REPAIR ONLY, after external checks. Use the supplied current candidate, observed evidence and authorized edit scope. Think through the necessary change, then submit one corrected artifact in the required protocol. Do not run a mental test suite, claim unexecuted tests passed, or enter repeated self-review/rewrite cycles. The controller performs the next check in a separate stage after you submit.');
}

const CORE = `RTL reasoning discipline:
Use enough reasoning to implement the exact behavior correctly; scale the depth to the actual uncertainty in this task.
Settle the interface, state updates, reset/initialization requirements, widths and output timing before choosing an implementation.
Choose one simple implementation that satisfies those constraints. Revisit a settled decision only when the specification or concrete diagnostic evidence contradicts it.
Keep verification focused on the relevant reset/load/enable priorities, signed arithmetic, boundary values and cycle transitions. Reuse established conclusions instead of re-deriving them or repeatedly comparing equivalent designs.
Treat skills as reference material: apply the relevant rules without summarizing every skill or copying unrelated examples.
Once the implementation satisfies the explicit constraints and a focused consistency check finds no discrepancy, emit the complete RTL. Do not start another review merely for reassurance.
The generation limit is a ceiling, not a target. Leave enough capacity to finish all module declarations and implementation code. Follow the existing code-only output contract; do not expose a reasoning transcript.`;

export function reasoningGuidance({ enabled, level, attempts = [] }) {
  if (!enabled) return '';
  const parts = [CORE];
  if (level === 'xhigh') parts.push('Critical effort: investigate the specific unresolved behavior or first failing case in depth, while preserving already-established correct behavior. Extra effort does not require restarting the entire design analysis.');
  else parts.push('Ordinary effort: for direct combinational expressions, registers, counters or standard state machines, proceed to implementation after resolving their explicit constraints.');
  if (attempts.length) parts.push('Repair scope: prioritize the earliest concrete diagnostic. Preserve unaffected logic. If only syntax or declaration errors are reported, correct those directly before considering a redesign. Do not invent a test failure that was not reported.');
  if (attempts.at(-1)?.failureKind === 'MODEL_TRUNCATED') parts.push('Truncation recovery: the previous response ended at its generation limit; this is not itself evidence of an RTL defect. Start a fresh, compact derivation from the specification and any actual tool feedback. Do not reconstruct the interrupted reasoning or enumerate the same alternatives again. Produce the complete implementation in this request.');
  return parts.join('\n');
}
