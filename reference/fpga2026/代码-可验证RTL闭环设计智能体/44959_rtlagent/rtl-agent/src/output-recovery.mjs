import { ModelGenerationError } from './model.mjs';

export function normalizeOutputRecovery(raw) {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('agent.outputRecovery must be an object');
  const result = { retryNormalEmpty: false, regenerateWithoutRtl: false, ...raw };
  for (const key of ['retryNormalEmpty', 'regenerateWithoutRtl']) {
    if (typeof result[key] !== 'boolean') throw new Error(`agent.outputRecovery.${key} must be boolean`);
  }
  return result;
}

export function recoverableNormalEmpty(error) {
  // Missing assistant responses and transport / server failures are terminal.
  // A normal, fully received response with no visible RTL may consume another
  // existing attempt. No extra attempts, network retries or token limits here.
  return error instanceof ModelGenerationError && error.code === 'MODEL_EMPTY'
    && error.stopReason === 'stop' && error.responseReceived === true;
}

export function regenerationPrompt(spec, index, feedback, maxChars) {
  return `${spec}\n\nREGENERATION_ATTEMPT ${index}\nNO_COMPLETE_RTL: No complete RTL candidate is available. Generate a complete implementation from the full specification. Resolve the previous output failure; return the entire module(s).\n\nPREVIOUS OUTPUT DIAGNOSTIC:\n${feedback.slice(0, maxChars)}\n\nReturn one complete fenced SystemVerilog implementation.`;
}
