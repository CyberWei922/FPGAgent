import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { BASELINE_MAX_TOKENS, generationSettings, modelGenerationSettings } from './generation.mjs';
import { normalizeRag } from '../../rtl-agent/src/rag.mjs';
import { normalizeRtlLint } from '../../rtl-agent/src/rtl-lint.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DECLARATION = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const number = (env, name, fallback, min = 1) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}`);
  return value;
};

export function runtimeConfig(env = process.env, sharedGeneration = generationSettings()) {
  if (!env.MODEL_NAME) throw new Error('MODEL_NAME is required');
  const vivadoBin = env.VIVADO_BIN || (env.XILINX_VIVADO && path.join(env.XILINX_VIVADO, 'bin'))
    || (env.XILINX_VITIS && path.join(env.XILINX_VITIS, '..', 'Vivado', 'bin'));
  if (!vivadoBin) throw new Error('VIVADO_BIN, XILINX_VIVADO or the official XILINX_VITIS path is required');
  const context = number(env, 'MAX_MODEL_LEN', DECLARATION.context.max_model_len), maxTokens = number(env, 'LLM_MAX_TOKENS', DECLARATION.context.max_output_tokens);
  if (context <= BASELINE_MAX_TOKENS || maxTokens >= context) throw new Error('Context must fit input plus the fixed 16384-token baseline output, and exceed the Agent output limit');
  const promptProfile = env.AGENT_PROMPT_PROFILE || 'adaptive';
  if (!['compact', 'legacy', 'adaptive'].includes(promptProfile)) throw new Error('AGENT_PROMPT_PROFILE must be adaptive, compact or legacy');
  if (env.LLM_CACHE_PROMPT !== undefined && !['0', '1'].includes(env.LLM_CACHE_PROMPT)) throw new Error('LLM_CACHE_PROMPT must be 0 or 1');
  const selfTest = env.AGENT_SELF_TEST || 'off';
  if (!['off', 'vectors', 'templates'].includes(selfTest)) throw new Error('AGENT_SELF_TEST must be off, vectors or templates');
  if (env.AGENT_DIAGNOSTIC_ROLE !== undefined && !['0', '1'].includes(env.AGENT_DIAGNOSTIC_ROLE)) throw new Error('AGENT_DIAGNOSTIC_ROLE must be 0 or 1');
  if (selfTest === 'off' && env.AGENT_DIAGNOSTIC_ROLE === '1') throw new Error('Diagnostic role requires vector self-tests');
  if (env.AGENT_SELF_TEST_TEMPLATES !== undefined && !['0', '1'].includes(env.AGENT_SELF_TEST_TEMPLATES)) throw new Error('AGENT_SELF_TEST_TEMPLATES must be 0 or 1');
  if (selfTest === 'off' && env.AGENT_SELF_TEST_TEMPLATES === '1') throw new Error('Self-test templates require vector self-tests');
  const generation = modelGenerationSettings(sharedGeneration);
  const rtlPrecheck = env.AGENT_RTL_PRECHECK || 'off';
  const rtlLint = env.AGENT_RTL_LINT ?? 'off';
  if (!['off', 'slang'].includes(rtlLint)) throw new Error('AGENT_RTL_LINT must be off or slang');
  const rag = normalizeRag({ mode: env.AGENT_RAG || 'off', python: env.RAG_PYTHON || 'python3', root: env.RAG_ROOT || '',
    manifestSha256: env.RAG_MANIFEST_SHA256 || '', endpoint: env.RAG_ENDPOINT || 'http://127.0.0.1:18085' });
  if (!['off', 'slang'].includes(rtlPrecheck)) throw new Error('AGENT_RTL_PRECHECK must be off or slang');
  for (const key of ['AGENT_RETRY_NORMAL_EMPTY', 'AGENT_REGENERATE_WITHOUT_RTL']) {
    if (env[key] !== undefined && !['0', '1'].includes(env[key])) throw new Error(`${key} must be 0 or 1`);
  }
  return {
    model: { baseUrl: env.LLM_BASE_URL || 'http://127.0.0.1:8000/v1', id: env.MODEL_NAME,
      contextWindow: context, maxTokens, temperature: number(env, 'LLM_TEMPERATURE', 0.2, 0), topP: 0.95,
      ...generation, requestTimeoutMs: 600000,
      extraBody: { ...generation.extraBody, ...(env.SERVING_BACKEND !== 'vllm' ? { cache_prompt: env.LLM_CACHE_PROMPT !== '0' } : {}) },
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } },
    vivado: { binDir: path.resolve(vivadoBin), expectedVersion: '2026.1',
      part: 'xczu3eg-sbva484-1-e', maxThreads: number(env, 'EDA_THREADS', 2), stageTimeoutMs: 120000, synthesisTimeoutMs: 180000 },
    agent: { maxRepairs: number(env, 'AGENT_MAX_REPAIRS', 2, 0), totalTimeoutMs: 900000, maxPromptChars: 100000, maxFeedbackChars: 5000, promptProfile,
      rtlPrecheck: { mode: rtlPrecheck, python: env.SLANG_PYTHON || 'python3', timeoutMs: 5000, maxDiagnostics: 12 },
      rtlLint: normalizeRtlLint({ mode: rtlLint, python: env.SLANG_PYTHON || 'python3' }),
      rag,
      outputRecovery: { retryNormalEmpty: env.AGENT_RETRY_NORMAL_EMPTY === '1', regenerateWithoutRtl: env.AGENT_REGENERATE_WITHOUT_RTL === '1' },
      selfCheck: { mode: selfTest, diagnose: env.AGENT_DIAGNOSTIC_ROLE === '1', templateFastPath: env.AGENT_SELF_TEST_TEMPLATES === '1', timeoutMs: 150000, maxTokens: Math.min(8192, maxTokens) } },
    skills: { enabled: true, directory: path.resolve(env.SKILL_DIR || (existsSync(path.join(ROOT, 'skill/index.json')) ? path.join(ROOT, 'skill') : path.join(ROOT, '../rtl-agent/skills'))), mode: 'auto', ids: [], maxSelected: 2, maxChars: 6000, includeExamples: promptProfile === 'legacy' },
    mcp: { workspaceRoot: path.resolve(env.EDA_TMP || '/var/tmp/eda'), requestTimeoutMs: 600000,
      backend: env.VIVADO_MCP_BACKEND || 'fixed_persistent',
      officialBinary: path.resolve(env.ROSS_MCP_BIN || path.join(ROOT, 'vendor/ross/vivado-mcp-server-linux-amd64-2026.9.1')) },
    outputDir: path.resolve(env.EDA_TMP || '/var/tmp/eda'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: create-config.mjs <output.json>');
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(runtimeConfig(), null, 2) + '\n', { mode: 0o600 });
}
