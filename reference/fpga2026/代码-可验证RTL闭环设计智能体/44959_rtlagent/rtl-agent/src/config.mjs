import { normalizeDual } from './dual/config.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeThinkingPolicy, validateModelThinking } from './thinking.mjs';
import { normalizeRtlPrecheck } from './slang-precheck.mjs';
import { normalizeOutputRecovery } from './output-recovery.mjs';
import { normalizeRag } from './rag.mjs';

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
}
function identifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${name} must be a simple Verilog identifier`);
}
function skillIds(value, name) {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error(`${name} must contain unique skill IDs`);
}
export async function readJson(file) {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Cannot read JSON ${path.basename(file)}: ${error instanceof SyntaxError ? 'invalid JSON syntax' : (error.code ?? 'read failed')}`); }
}

export async function loadConfig(file) {
  const fullPath = path.resolve(file);
  const raw = object(await readJson(fullPath), 'config');
  object(raw.model, 'model'); object(raw.vivado, 'vivado');
  const model = {
    contextWindow: 8192, maxTokens: 2048, temperature: 0.2,
    reasoning: false, requestTimeoutMs: 240000, ...raw.model,
  };
  const url = new URL(model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('model.baseUrl must be an HTTP(S) endpoint without credentials, query or fragment');
  }
  model.baseUrl = url.toString().replace(/\/$/, '');
  if (typeof model.id !== 'string' || !model.id.trim()) throw new Error('model.id is required');
  integer(model.contextWindow, 'model.contextWindow', 512);
  integer(model.maxTokens, 'model.maxTokens');
  integer(model.requestTimeoutMs, 'model.requestTimeoutMs', 1, 2147483647);
  if (model.maxTokens >= model.contextWindow) throw new Error('model.maxTokens must leave room for input in contextWindow');
  if (model.reasoningBudget !== undefined) integer(model.reasoningBudget, 'model.reasoningBudget', -1, model.maxTokens - 1);
  if (!Number.isFinite(model.temperature) || model.temperature < 0 || model.temperature > 2) throw new Error('Invalid model.temperature');
  if (model.topP !== undefined && (!Number.isFinite(model.topP) || model.topP <= 0 || model.topP > 1)) throw new Error('Invalid model.topP');
  if (model.compat !== undefined) object(model.compat, 'model.compat');
  if (model.extraBody !== undefined) {
    object(model.extraBody, 'model.extraBody');
    for (const key of ['model', 'messages', 'stream', 'tools', 'max_tokens', 'max_completion_tokens']) {
      if (key in model.extraBody) throw new Error(`model.extraBody cannot override ${key}`);
    }
  }
  validateModelThinking(model);
  const vivado = {
    part: 'xczu3eg-sbva484-1-e', stageTimeoutMs: 120000,
    synthesisTimeoutMs: 180000, maxThreads: 2, ...raw.vivado,
  };
  if (!vivado.binDir || vivado.expectedVersion !== '2026.1') throw new Error('vivado.binDir and expectedVersion 2026.1 are required');
  vivado.binDir = path.resolve(path.dirname(fullPath), vivado.binDir);
  if (!/^[A-Za-z0-9_-]+$/.test(vivado.part)) throw new Error('Invalid vivado.part');
  for (const key of ['stageTimeoutMs', 'synthesisTimeoutMs', 'maxThreads']) integer(vivado[key], `vivado.${key}`);
  const agent = { maxRepairs: 2, totalTimeoutMs: 900000, maxPromptChars: 24000, maxFeedbackChars: 5000, reasoningGuidance: false, promptProfile: 'legacy', ...raw.agent };
  if (!['legacy', 'compact', 'adaptive'].includes(agent.promptProfile)) throw new Error('agent.promptProfile must be legacy, compact or adaptive');
  if (typeof agent.reasoningGuidance !== 'boolean') throw new Error('agent.reasoningGuidance must be boolean');
  integer(agent.maxRepairs, 'agent.maxRepairs', 0, 10);
  for (const key of ['totalTimeoutMs', 'maxPromptChars', 'maxFeedbackChars']) integer(agent[key], `agent.${key}`);
  integer(agent.totalTimeoutMs, 'agent.totalTimeoutMs', 1, 2147483647);
  agent.thinking = normalizeThinkingPolicy(agent.thinking, model);
  agent.rtlPrecheck = normalizeRtlPrecheck(agent.rtlPrecheck);
  agent.outputRecovery = normalizeOutputRecovery(agent.outputRecovery);
  agent.rag = normalizeRag(agent.rag, path.dirname(fullPath));
  if (agent.selfCheck !== undefined) object(agent.selfCheck, 'agent.selfCheck');
  agent.selfCheck = { mode: 'off', diagnose: false, templateFastPath: false, timeoutMs: 150000, maxTokens: Math.min(8192, model.maxTokens), ...agent.selfCheck };
  if (!['off', 'vectors', 'templates'].includes(agent.selfCheck.mode) || typeof agent.selfCheck.diagnose !== 'boolean') throw new Error('agent.selfCheck requires mode off/vectors/templates and a boolean diagnose');
  if (typeof agent.selfCheck.templateFastPath !== 'boolean') throw new Error('agent.selfCheck.templateFastPath must be boolean');
  if (agent.selfCheck.templateFastPath && agent.selfCheck.mode === 'off') throw new Error('Self-check templates require vector checks');
  if (agent.selfCheck.diagnose && agent.selfCheck.mode === 'off') throw new Error('Failure diagnosis requires vector self-checks');
  integer(agent.selfCheck.timeoutMs, 'agent.selfCheck.timeoutMs', 1000, 300000);
  integer(agent.selfCheck.maxTokens, 'agent.selfCheck.maxTokens', agent.selfCheck.mode === 'off' ? 1 : 256, model.maxTokens);
  if (raw.skills !== undefined) object(raw.skills, 'skills');
  const skills = { enabled: false, directory: 'skills', mode: 'auto', ids: [], maxSelected: 2, maxChars: 6000, includeExamples: true, ...raw.skills };
  if (typeof skills.enabled !== 'boolean' || typeof skills.includeExamples !== 'boolean') throw new Error('skills.enabled and includeExamples must be boolean');
  if (!['auto', 'manual'].includes(skills.mode)) throw new Error('skills.mode must be auto or manual');
  if (typeof skills.directory !== 'string' || !skills.directory.trim()) throw new Error('skills.directory is required');
  skills.directory = path.resolve(path.dirname(fullPath), skills.directory);
  skillIds(skills.ids, 'skills.ids');
  integer(skills.maxSelected, 'skills.maxSelected', 1, 10);
  integer(skills.maxChars, 'skills.maxChars', 1, 100000);
  if (raw.mcp !== undefined) object(raw.mcp, 'mcp');
  const mcp = { workspaceRoot: '.', requestTimeoutMs: 600000, backend: 'fixed', ...raw.mcp };
  if (!['fixed', 'fixed_persistent', 'amd_ross'].includes(mcp.backend)) throw new Error('mcp.backend must be fixed, fixed_persistent or amd_ross');
  if (mcp.backend === 'amd_ross' && (typeof mcp.officialBinary !== 'string' || !path.isAbsolute(mcp.officialBinary))) throw new Error('mcp.officialBinary must be an absolute path');
  if (typeof mcp.workspaceRoot !== 'string' || !mcp.workspaceRoot.trim()) throw new Error('mcp.workspaceRoot is required');
  mcp.workspaceRoot = path.resolve(path.dirname(fullPath), mcp.workspaceRoot);
  integer(mcp.requestTimeoutMs, 'mcp.requestTimeoutMs', 1, 2147483647);
  const workflowMode = raw.workflowMode ?? 'legacy';
  if (!['legacy', 'dual_v1', 'planner_v1', 'planner_v2'].includes(workflowMode)) throw new Error('Unknown workflowMode');
  const dual = workflowMode !== 'legacy' ? normalizeDual(raw.dual, model) : undefined;
  if (dual && Boolean(dual.plannerPhase1) !== ['planner_v1','planner_v2'].includes(workflowMode)) throw new Error('Planner requires its explicit workflowMode');
  if (dual && Boolean(dual.plannerPhase2) !== (workflowMode === 'planner_v2')) throw new Error('Physical modularity requires explicit planner_v2 workflowMode');
  return { model, vivado, agent, skills, mcp, workflowMode, ...(dual ? { dual } : {}), outputDir: path.resolve(path.dirname(fullPath), raw.outputDir ?? 'runs') };
}

export async function loadTask(file) {
  const fullPath = path.resolve(file);
  const task = object(await readJson(fullPath), 'task');
  if (typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(task.id)) throw new Error('Invalid task.id');
  identifier(task.top, 'task.top');
  if (task.specFile) {
    if (task.spec) throw new Error('Choose spec or specFile, not both');
    task.spec = await readFile(path.resolve(path.dirname(fullPath), task.specFile), 'utf8');
  }
  if (typeof task.spec !== 'string' || !task.spec.trim()) throw new Error('task.spec or specFile is required');
  if (task.skillIds !== undefined) skillIds(task.skillIds, 'task.skillIds');
  if (task.clockPort !== undefined) identifier(task.clockPort, 'task.clockPort');
  task.clockPeriodNs ??= 5;
  if (!Number.isFinite(task.clockPeriodNs) || task.clockPeriodNs <= 0) throw new Error('Invalid clockPeriodNs');
  task.stages ??= ['compile', 'simulate', 'synthesize'];
  if (!Array.isArray(task.stages) || !task.stages.length || new Set(task.stages).size !== task.stages.length || task.stages.some(s => !['compile', 'simulate', 'synthesize'].includes(s))) throw new Error('Invalid task.stages');
  if (task.stages.includes('simulate') && !task.testbench) throw new Error('A trusted testbench is required for the simulate stage');
  if (task.testbench) {
    object(task.testbench, 'task.testbench'); identifier(task.testbench.top, 'testbench.top');
    if (task.testbench.top === task.top) throw new Error('Testbench top and DUT top must differ');
    if (typeof task.testbench.path !== 'string') throw new Error('testbench.path is required');
    task.testbench.path = path.resolve(path.dirname(fullPath), task.testbench.path);
    task.testbench.resultFile ??= 'tb_result.txt';
    if (!/^[A-Za-z0-9_-]+\.txt$/.test(task.testbench.resultFile)) throw new Error('Invalid testbench.resultFile');
    integer(task.testbench.expectedChecks, 'testbench.expectedChecks');
    await readFile(task.testbench.path); // Fail before spending model tokens.
  }
  return task;
}

export function publicConfig(config) {
  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      /^(apiKey|authorization|password|secret|token)$/i.test(k) ? '[REDACTED]' : redact(v)]));
  };
  return redact(config);
}
