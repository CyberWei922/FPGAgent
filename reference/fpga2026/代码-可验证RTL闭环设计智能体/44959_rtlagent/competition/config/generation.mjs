import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const BASELINE_MAX_TOKENS = 16384;

// The official baseline reads the manifest beside baseline.py. Keep the same
// request fields on generation, repair and semantic routing calls.
export function generationSettings(file = new URL('../manifest.json', import.meta.url)) {
  const declared = JSON.parse(readFileSync(file, 'utf8')).generation;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('manifest.json must declare generation settings');
  const kwargs = declared.chat_template_kwargs;
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs) ||
      Object.values(kwargs).some(value => !['boolean', 'number', 'string'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) {
    throw new Error('generation.chat_template_kwargs must contain scalar values');
  }
  // A candidate chooses its binary mode in the exported manifest. Environment
  // variables cannot silently override it for just one comparison lane.
  if (typeof kwargs.enable_thinking !== 'boolean' || (declared.reasoning_effort !== undefined && declared.reasoning_effort !== null && declared.reasoning_effort !== '')) {
    throw new Error('This Qwen deployment requires an explicit boolean enable_thinking and no reasoning_effort override');
  }
  return { chat_template_kwargs: { ...kwargs } };
}

export function modelGenerationSettings(expected = generationSettings()) {
  if (!expected.chat_template_kwargs.enable_thinking) return { reasoning: false, extraBody: expected };
  const { enable_thinking: _enabled, ...kwargs } = expected.chat_template_kwargs;
  return { reasoning: true, thinking: { format: 'qwen-template', capability: 'binary' },
    extraBody: Object.keys(kwargs).length ? { chat_template_kwargs: kwargs } : {} };
}

export function requireSharedGeneration(model, expected = generationSettings()) {
  const enabled = expected.chat_template_kwargs.enable_thinking;
  const native = model.reasoning && model.thinking?.format === 'qwen-template' && model.thinking?.capability === 'binary';
  const kwargs = native
    ? { ...model.extraBody?.chat_template_kwargs, enable_thinking: true } : model.extraBody?.chat_template_kwargs;
  if (Boolean(model.reasoning) !== enabled || enabled && !native || native && Object.hasOwn(model.extraBody?.chat_template_kwargs ?? {}, 'enable_thinking')
      || !isDeepStrictEqual(kwargs, expected.chat_template_kwargs)
      || model.extraBody?.reasoning_effort !== undefined || model.reasoningBudget !== undefined) {
    throw new Error('Agent thinking settings differ from the official baseline manifest generation');
  }
}
