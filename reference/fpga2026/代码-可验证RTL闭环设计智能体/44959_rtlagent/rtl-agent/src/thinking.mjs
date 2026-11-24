export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const TRIGGERS = ['simulation_failure', 'duplicate_candidate', 'repeated_failure', 'truncated_output'];

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function profile(value, name, model) {
  object(value, name);
  if (!THINKING_LEVELS.includes(value.level)) throw new Error(`${name}.level is invalid`);
  if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0 || value.maxTokens >= model.contextWindow) {
    throw new Error(`${name}.maxTokens must be positive and leave room for input in model.contextWindow`);
  }
  if (!Number.isSafeInteger(value.requestTimeoutMs) || value.requestTimeoutMs <= 0 || value.requestTimeoutMs > 2147483647) {
    throw new Error(`${name}.requestTimeoutMs is invalid`);
  }
  if (model.thinking.format !== 'qwen-template' && !model.thinking.effortMap?.[value.level]) {
    throw new Error(`model.thinking.effortMap must explicitly map ${value.level}`);
  }
  return { level: value.level, maxTokens: value.maxTokens, requestTimeoutMs: value.requestTimeoutMs };
}

export function validateModelThinking(model) {
  if (typeof model.reasoning !== 'boolean') throw new Error('model.reasoning must be boolean');
  if (!model.reasoning) return;
  object(model.thinking, 'model.thinking');
  if (!['reasoning_effort', 'qwen-template', 'qwen-template-graded'].includes(model.thinking.format)) throw new Error('Invalid model.thinking.format');
  if (!['graded', 'binary'].includes(model.thinking.capability)) throw new Error('Invalid model.thinking.capability');
  if (model.thinking.format === 'qwen-template' && model.thinking.capability !== 'binary') {
    throw new Error('qwen-template requires binary capability; it cannot select native thinking levels');
  }
  if (model.thinking.format === 'qwen-template-graded' && model.thinking.capability !== 'graded') throw new Error('qwen-template-graded requires graded capability');
  if (model.thinking.format !== 'qwen-template') {
    object(model.thinking.effortMap, 'model.thinking.effortMap');
    for (const [level, wireValue] of Object.entries(model.thinking.effortMap)) {
      if (!THINKING_LEVELS.includes(level) || !THINKING_LEVELS.includes(wireValue)) throw new Error('Invalid model.thinking.effortMap');
    }
  }
  const thinkingFields = new Set(['think', 'thinking', 'reasoning', 'enable_thinking', 'preserve_thinking', 'clear_thinking']);
  const conflicts = value => value && typeof value === 'object' && Object.entries(value).some(([key, nested]) =>
    thinkingFields.has(key.toLowerCase()) || /^(thinking|reasoning)[_-]/i.test(key) || conflicts(nested));
  if (conflicts(model.extraBody)) throw new Error('model.extraBody conflicts with model.thinking');
}

export function normalizeThinkingPolicy(raw, model) {
  if (raw === undefined) return { enabled: false };
  object(raw, 'agent.thinking');
  if (typeof raw.enabled !== 'boolean') throw new Error('agent.thinking.enabled must be boolean');
  if (!raw.enabled) return { enabled: false };
  if (!model.reasoning) throw new Error('agent.thinking.enabled requires model.reasoning=true');
  validateModelThinking(model);
  const normal = profile(raw.normal, 'agent.thinking.normal', model);
  const critical = profile(raw.critical, 'agent.thinking.critical', model);
  const inputReserveTokens = raw.inputReserveTokens ?? 1;
  if (!Number.isSafeInteger(inputReserveTokens) || inputReserveTokens < 1 || inputReserveTokens >= model.contextWindow) {
    throw new Error('agent.thinking.inputReserveTokens must be a positive integer below model.contextWindow');
  }
  if ([normal, critical].some(p => p.maxTokens + inputReserveTokens > model.contextWindow)) {
    throw new Error('Thinking output budget must leave agent.thinking.inputReserveTokens available for input');
  }
  if (critical.maxTokens < normal.maxTokens || critical.requestTimeoutMs < normal.requestTimeoutMs ||
      THINKING_LEVELS.indexOf(critical.level) < THINKING_LEVELS.indexOf(normal.level)) {
    throw new Error('agent.thinking.critical must not reduce the normal level, token budget or timeout');
  }
  if (model.thinking.format !== 'qwen-template' && model.thinking.capability === 'graded' &&
      THINKING_LEVELS.indexOf(model.thinking.effortMap[critical.level]) < THINKING_LEVELS.indexOf(model.thinking.effortMap[normal.level])) {
    throw new Error('agent.thinking.critical must not reduce the mapped provider effort');
  }
  const escalateOn = raw.escalateOn ?? TRIGGERS;
  if (!Array.isArray(escalateOn) || new Set(escalateOn).size !== escalateOn.length || escalateOn.some(key => !TRIGGERS.includes(key))) {
    throw new Error('Invalid agent.thinking.escalateOn');
  }
  return { enabled: true, normal, critical, inputReserveTokens, escalateOn: [...escalateOn] };
}

// Decisions use tool outcomes, never a model's self-reported confidence.
export function selectThinking(policy, attempts) {
  if (!policy?.enabled) return null;
  const enabled = new Set(policy.escalateOn ?? TRIGGERS);
  const previous = attempts.find(attempt => attempt.thinkingPolicy?.tier === 'critical');
  let trigger = previous ? 'critical_latched' : 'normal';
  if (!previous) {
    if (enabled.has('truncated_output') && attempts.some(a => a.failureKind === 'MODEL_TRUNCATED')) trigger = 'truncated_output';
    else if (enabled.has('simulation_failure') && attempts.some(a => a.validation?.stages?.some(s => s.name === 'simulate' && ['fail', 'failed'].includes(s.status)))) trigger = 'simulation_failure';
    else if (enabled.has('duplicate_candidate') && attempts.some(a => a.failureKind === 'duplicate_failed_candidate')) trigger = 'duplicate_candidate';
    else if (enabled.has('repeated_failure') && attempts.filter(a => !a.passed).length >= 2) trigger = 'repeated_failure';
  }
  const tier = trigger === 'normal' ? 'normal' : 'critical';
  return { tier, trigger, ...policy[tier] };
}
