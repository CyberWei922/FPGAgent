import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { measureGpu, readiness } from './readiness.mjs';
import { inspectEnvironment } from './check-environment.mjs';
import { generationSettings } from '../config/generation.mjs';
import { plannerRuntimeConfig } from '../config/create-planner-config.mjs';
import { startModels, stopModels } from './dual-models.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DECLARATION = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

// One llama-server command for one model. Used by dual-models.mjs for both roles.
export function modelCommand(env, sharedGeneration = generationSettings(), declaration = DECLARATION) {
  if (!env.MODEL_NAME || !env.MODEL_PATH || !path.isAbsolute(env.MODEL_PATH)) throw new Error('MODEL_NAME and an absolute local MODEL_PATH are required');
  if (env.GPU_INDEX && env.GPU_INDEX !== '0') throw new Error('This deployment supports a single GPU at index 0');
  const context = String(env.MAX_MODEL_LEN || declaration.context?.max_model_len || DECLARATION.context.max_model_len);
  const threads = Number(env.LLAMA_THREADS || 16);
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error('LLAMA_THREADS must be a positive integer');
  if (env.SERVING_BACKEND && env.SERVING_BACKEND !== 'llama.cpp') throw new Error('This deployment requires the validated llama.cpp backend');
  if (!env.LLAMA_SERVER_BIN || !path.isAbsolute(env.LLAMA_SERVER_BIN)) throw new Error('LLAMA_SERVER_BIN must point to the installed ROCm llama-server');
  const budget = declaration.serving?.reasoning_budget_tokens;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0 || budget >= Number(context))) {
    throw new Error('Shared server reasoning budget must be a nonnegative integer below the context size');
  }
  return { bin: env.LLAMA_SERVER_BIN, args: ['--model', env.MODEL_PATH, '--alias', env.MODEL_NAME, '--host', '127.0.0.1', '--port', '8000',
    '--ctx-size', context, '--parallel', '1', '--n-gpu-layers', '999', '--split-mode', 'none', '--main-gpu', '0',
    '--fit', 'off', '--threads', String(threads), '--threads-batch', String(threads),
    '--jinja', '--reasoning', sharedGeneration.chat_template_kwargs.enable_thinking ? 'on' : 'off',
    '--chat-template-kwargs', JSON.stringify(sharedGeneration.chat_template_kwargs),
    ...(sharedGeneration.chat_template_kwargs.enable_thinking && budget !== undefined ? ['--reasoning-budget', String(budget)] : [])] };
}

// Frozen competition configuration. This is the configuration validated on the
// cloud (full-cex 60-task run) plus the switches decided on 2026-10-28.
// run.sh and the HTTP service inherit it; nothing else needs to be exported.
export const PRODUCTION_AGENT_ENV = Object.freeze({
  AGENT_SELF_TEST: 'templates', AGENT_SELF_TEST_TEMPLATES: '1', AGENT_PROMPT_PROFILE: 'adaptive',
  AGENT_RETRY_NORMAL_EMPTY: '1', AGENT_REGENERATE_WITHOUT_RTL: '1', AGENT_RAG: 'off', AGENT_RTL_PRECHECK: 'off', AGENT_RTL_LINT: 'slang',
  AGENT_DIAGNOSTIC_ROLE: '0', AGENT_NL2SPEC: '1', AGENT_EARLY_HANDOFF: '1', AGENT_GENERATION_ONLY: '1', AGENT_COMPACT_PLANNER: '1',
  AGENT_AUTHOR_CONTROL: '1', AGENT_PHASE_DRY: '1', AGENT_CONVERGENCE: '1',
  AGENT_UNIFIED_HARNESS: '1', AGENT_CALCULATOR: '1', AGENT_HARNESS_CONTRACTS: '1', AGENT_HARNESS_TRACE: '1', AGENT_HARNESS_CONTINUITY: '1',
  AGENT_REGISTERED_FEEDBACK: '1', AGENT_DIAGNOSIS_V2: '0', AGENT_DIAGNOSIS_EVIDENCE: '0', AGENT_DIAGNOSIS_CEX: '1',
  AGENT_REPAIR_ROUTING: '1', AGENT_REPAIR_CEX: '1', AGENT_MAX_REPAIRS: '2', AGENT_KEEP_WORK: '0',
  AGENT_RESAMPLE: '1', AGENT_RESAMPLE_MAX: '2', AGENT_RESAMPLE_PARALLEL: '2', AGENT_RESAMPLE_PREFETCH: '0',
  AGENT_MAIN_PARALLEL: '2', AGENT_MAIN_POOL_CONTEXT: '32768',
  AGENT_VERIFICATION: '1', AGENT_VERIFICATION_COMPACT: '1', AGENT_VERIFICATION_TASKS: '1',
  AGENT_VERIFICATION_STRUCTURED: '0', AGENT_VERIFICATION_SEMANTIC_REVIEW: '0',
  AGENT_PLANNING_RAG: 'off', AGENT_VERIFICATION_RAG: 'off', AGENT_DIAGNOSIS_RAG: 'off',
  // Decisions of 2026-10-28 (docs/new-agent/FINAL-READINESS-20261028.md).
  AGENT_VERIFICATION_TABLE_GUARD: '1', AGENT_VERIFICATION_EXPRESSIONS: '1', AGENT_REPAIR_FALLBACKS: '1', AGENT_REPAIR_DIAGNOSIS_FIRST: '1',
  AGENT_VERIFICATION_BODY_RESERVE: '1', AGENT_VERIFICATION_BUDGET_SCHEDULE: '0',
  AGENT_VERIFICATION_TRANSACTIONS: '0', AGENT_VERIFICATION_NEWTYPES: '0',
  EDA_THREADS: '2', VIVADO_MCP_BACKEND: 'fixed_persistent', SERVING_BACKEND: 'llama.cpp',
  MAX_MODEL_LEN: '24576', LLM_MAX_TOKENS: '12288', LLM_TEMPERATURE: '1.0',
  PLANNER_CONTEXT: '20480', PLANNER_TEMPERATURE: '0.8', AGENT_DEADLINE_S: '900',
});

const sha256File = async file => {
  const hash = createHash('sha256'); const handle = await open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close().catch(() => {}); }
  return hash.digest('hex');
};
const firstExisting = (...candidates) => candidates.find(item => item && existsSync(item));

// Weight files are local; their identities come from manifest.json.
export function weightPaths(env, declaration = DECLARATION) {
  const dir = env.MODEL_DIR || '/workspace/models';
  const [aux, draft] = declaration.auxiliary_models;
  return {
    main: path.resolve(env.MAIN_MODEL_PATH || path.join(dir, declaration.model.file)),
    aux: path.resolve(env.AUX_MODEL_PATH || path.join(dir, aux.file)),
    draft: path.resolve(env.DRAFT_MODEL_PATH || firstExisting(path.join(dir, draft.file), path.join('/var/tmp/models-draft', draft.file)) || path.join(dir, draft.file)),
  };
}
export function plannerModel(declaration = DECLARATION, auxPath = null) {
  const aux = declaration.auxiliary_models[0], d = declaration.deployment.aux;
  return { id: aux.name, ...(auxPath ? { identity: { path: auxPath, revision: aux.revision, sha256: aux.sha256, quantization: aux.quantization } } : {}), baseUrl: `http://127.0.0.1:${d.port}/v1`, contextWindow: d.context, maxTokens: d.max_output_tokens,
    temperature: 0.8, topP: 0.95, reasoning: true, reasoningBudget: declaration.serving.reasoning_budget_tokens,
    thinking: { format: 'qwen-template-graded', capability: 'graded', effortMap: { low: 'low', medium: 'medium' } },
    extraBody: { cache_prompt: true }, requestTimeoutMs: 600000,
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } };
}
export function deployment({ stateDir, backend, backendSha256, weights }, declaration = DECLARATION) {
  const main = declaration.model, [aux, draft] = declaration.auxiliary_models, d = declaration.deployment;
  const budget = declaration.serving.reasoning_budget_tokens;
  return { schema: 'rtl2llm.planner-deployment.v1', state_dir: path.join(stateDir, 'models'), backend: { path: backend, sha256: backendSha256 },
    main: { id: main.name, path: weights.main, revision: main.revision, sha256: main.sha256, bytes: main.bytes, quantization: main.quantization,
      port: d.main.port, context: d.main.context, thinking: true, reasoning_budget: budget, parallel: d.main.parallel },
    aux: { id: aux.name, path: weights.aux, revision: aux.revision, sha256: aux.sha256, bytes: aux.bytes, quantization: aux.quantization,
      port: d.aux.port, context: d.aux.context, thinking: true, reasoning_budget: budget,
      draft: { path: weights.draft, sha256: draft.sha256, n_max: d.aux.draft_n_max } } };
}

async function background(command, log, env) {
  const handle = await open(log, 'a', 0o600);
  try {
    const child = spawn(command.bin, command.args, { cwd: ROOT, env, detached: true, stdio: ['ignore', handle.fd, handle.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); return child.pid;
  } finally { await handle.close(); }
}
async function waitFor(probe, childPid, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await probe()) return; } catch {}
    if (childPid) try { process.kill(childPid, 0); } catch { throw new Error('A background service exited; inspect its private log'); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Service readiness timed out; inspect api.log');
}
async function health(env) {
  const response = await fetch('http://127.0.0.1:7860/v1/health', { headers: { Authorization: 'Bearer ' + env.FPGACHINA_TOKEN }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Port 7860 is occupied by a different or unauthorized service');
  return await response.json();
}

// Optional, version-pinned sampler adapter for the 8B author only. If the
// backend differs from the reviewed build, the agent runs without it.
async function authorControl(env, stateDir) {
  const dir = path.join(stateDir, 'author-control-native');
  try {
    const built = JSON.parse(await readFile(path.join(dir, 'BUILD.json'), 'utf8'));
    if (existsSync(path.join(dir, 'libauthor-control.so')) && built.library_sha256 === await sha256File(path.join(dir, 'libauthor-control.so'))) return { library: path.join(dir, 'libauthor-control.so'), build: built };
  } catch {}
  try {
    if (existsSync(dir)) throw new Error('Existing author-control directory is incomplete; remove ' + dir + ' to rebuild');
    await exec(env.PYTHON_BIN, ['-B', path.join(ROOT, 'serve/build-author-control.py'), dir], { env, timeout: 180000 });
    return { library: path.join(dir, 'libauthor-control.so'), build: JSON.parse(await readFile(path.join(dir, 'BUILD.json'), 'utf8')) };
  } catch (error) { return { library: null, reason: String(error.message).slice(0, 500) }; }
}
// Offline pyslang lint from the vendored wheels. Missing wheels disable the lint only.
async function slangLint(env) {
  const target = path.join(ROOT, 'vendor/pyslang/site-packages'), wheels = path.join(ROOT, 'vendor/pyslang/wheels');
  if (existsSync(target)) return { ready: true };
  if (!existsSync(wheels)) return { ready: false, reason: 'pyslang wheels are not packaged' };
  try { await exec(env.PYTHON_BIN, ['-B', path.join(ROOT, 'environment/install-slang.py'), '--wheel-dir', wheels, '--target', target], { env, timeout: 180000 }); return { ready: true }; }
  catch (error) { return { ready: false, reason: String(error.message).slice(0, 500) }; }
}

export async function main(given = process.env, declaration = DECLARATION) {
  if (process.platform !== 'linux') throw new Error('Cloud startup requires Linux');
  if (!given.FPGACHINA_TOKEN || given.FPGACHINA_TOKEN.length < 8) throw new Error('FPGACHINA_TOKEN is required');
  const stateDir = path.resolve(given.SERVICE_STATE_DIR || '/var/tmp/rtl-agent-service');
  const env = { ...given, SERVICE_STATE_DIR: stateDir, EDA_TMP: path.resolve(given.EDA_TMP || '/var/tmp/eda'),
    TMPDIR: given.TMPDIR || '/var/tmp', AGENT_TMP: given.AGENT_TMP || '/var/tmp', SELFTEST_TMP: given.SELFTEST_TMP || '/var/tmp',
    XILINXD_LICENSE_FILE: given.XILINXD_LICENSE_FILE || '2100@vivado-lic.fpgachina.svc.cluster.local', FLEXLM_TIMEOUT: given.FLEXLM_TIMEOUT || '300000000',
    ...(given.ROCBLAS_TENSILE_LIBPATH ? {} : existsSync('/opt/llamacpp/rocblas/library') ? { ROCBLAS_TENSILE_LIBPATH: '/opt/llamacpp/rocblas/library' } : {}),
    PYTHON_BIN: given.PYTHON_BIN || firstExisting('/opt/python/bin/python3') || 'python3',
    LLAMA_SERVER_BIN: given.LLAMA_SERVER_BIN || firstExisting('/opt/llamacpp/llama-server') || '',
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', CUDA_VISIBLE_DEVICES: '0', HIP_VISIBLE_DEVICES: '0', ROCR_VISIBLE_DEVICES: '0', NO_PROXY: '127.0.0.1,localhost',
    // Older instance env files may still name a previous single model; the
    // declaration in manifest.json is authoritative for identities and limits.
    RTL_ENVIRONMENT_PROFILE: path.join(ROOT, declaration.runtime_versions.cloud_profile_file.replace(/^competition\//, '')) };
  for (const stale of ['MODEL_NAME', 'MODEL_PATH', 'MAX_MODEL_LEN', 'LLM_MAX_TOKENS', 'LLM_BASE_URL', 'AGENT_CONFIG']) delete env[stale];
  if (!path.isAbsolute(env.LLAMA_SERVER_BIN)) throw new Error('LLAMA_SERVER_BIN must point to the installed ROCm llama-server');
  const weights = weightPaths(env, declaration);
  for (const [role, file, bytes] of [['main', weights.main, declaration.model.bytes], ['aux', weights.aux, declaration.auxiliary_models[0].bytes], ['draft', weights.draft, declaration.auxiliary_models[1].bytes]]) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size !== bytes) throw new Error(`Weight ${role} must be the declared ${bytes}-byte file: ${file}`);
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 }); await mkdir(env.EDA_TMP, { recursive: true });

  // Already running with the same settings: nothing to do.
  const fingerprint = createHash('sha256').update(JSON.stringify({ declaration, production: PRODUCTION_AGENT_ENV, weights,
    token: createHash('sha256').update(env.FPGACHINA_TOKEN).digest('hex') })).digest('hex');
  const stateFile = path.join(stateDir, 'service.json');
  let state; try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let running; try { running = await health(env); } catch (error) { if (error.message.startsWith('Port 7860')) throw error; }
  if (running) {
    if (state?.fingerprint !== fingerprint || !running.ready || running.track !== 'rtl' || running.model !== declaration.model.name) throw new Error('A service is already running with different settings or is unhealthy');
    process.stdout.write('RTL service is already ready on 127.0.0.1:7860\n'); return;
  }

  const lock = await open(path.join(stateDir, 'startup.lock'), 'wx', 0o600).catch(() => { throw new Error('Another startup is in progress, or ' + path.join(stateDir, 'startup.lock') + ' needs inspection'); });
  let dep, apiPid; const degraded = [];
  try {
    // Version inventory is recorded; a different image is reported, not fatal.
    const environment = await inspectEnvironment(env).catch(error => ({ runtime_matches: false, error: error.message }));
    await writeFile(path.join(stateDir, 'environment.json'), JSON.stringify(environment, null, 2) + '\n', { mode: 0o600 });
    if (!environment.runtime_matches) degraded.push({ component: 'environment_profile', reason: 'differs from the validated cloud profile; see environment.json' });

    const agentEnv = { ...env, ...PRODUCTION_AGENT_ENV, MODEL_NAME: declaration.model.name, MODEL_PATH: weights.main,
      MAIN_MODEL_REVISION: declaration.model.revision, MAIN_MODEL_SHA256: declaration.model.sha256,
      LLM_BASE_URL: `http://127.0.0.1:${declaration.deployment.main.port}/v1`, SLANG_PYTHON: env.PYTHON_BIN,
      PLANNER_CONFIG: path.join(stateDir, 'planner.json'), RTL_AUTHOR_CONTROL_DIR: path.join(stateDir, 'author-control'),
      AGENT_CONFIG: path.join(stateDir, 'config.json') };
    const lint = await slangLint(env);
    if (!lint.ready) { agentEnv.AGENT_RTL_LINT = 'off'; degraded.push({ component: 'pyslang_lint', reason: lint.reason }); }
    const control = await authorControl(env, stateDir);
    if (!control.library) { agentEnv.AGENT_AUTHOR_CONTROL = '0'; delete agentEnv.RTL_AUTHOR_CONTROL_DIR; degraded.push({ component: 'author_control', reason: control.reason }); }
    else await mkdir(agentEnv.RTL_AUTHOR_CONTROL_DIR, { recursive: true, mode: 0o700 });

    await writeFile(agentEnv.PLANNER_CONFIG, JSON.stringify(plannerModel(declaration, weights.aux), null, 2) + '\n', { mode: 0o600 });
    const config = await plannerRuntimeConfig(agentEnv);
    await writeFile(agentEnv.AGENT_CONFIG, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

    dep = deployment({ stateDir, backend: env.LLAMA_SERVER_BIN, backendSha256: await sha256File(env.LLAMA_SERVER_BIN), weights }, declaration);
    // The author adapter is preloaded into the 8B server only; the 27B is untouched.
    const modelEnv = { ...env }; delete modelEnv.LD_PRELOAD;
    await startModels(dep, control.library ? { ...modelEnv, LD_PRELOAD: control.library, RTL_AUTHOR_CONTROL_DIR: agentEnv.RTL_AUTHOR_CONTROL_DIR } : modelEnv, ['main']);
    await startModels(dep, modelEnv, ['aux']);

    const memory = await measureGpu(env);
    if (memory.usedGb > declaration.deployment.vram_limit_gib) throw new Error(`Loaded models use ${memory.usedGb.toFixed(2)} GiB, above the declared ${declaration.deployment.vram_limit_gib} GiB limit`);
    const preflight = await readiness(agentEnv)(); if (!preflight.ready) throw new Error('Readiness failed: ' + preflight.reason);
    // api-supervisor restarts the server within 2 s if it exits (rc-tunnel
    // revokes the URL after ~1 min down). Both share one process group, so
    // stopping apiPid's group stops the supervisor and the server together.
    apiPid = await background({ bin: process.execPath, args: [path.join(ROOT, 'serve/api-supervisor.mjs')] }, path.join(stateDir, 'api.log'), agentEnv);
    await waitFor(async () => (await health(env)).ready === true, apiPid, 120000);
    state = { fingerprint, apiPid, model: declaration.model.name, auxiliary_models: declaration.auxiliary_models.map(m => m.name),
      started_at: new Date().toISOString(), deployment: dep, author_control: control.build ?? null, degraded,
      initial_vram_gib: memory.usedGb, acceptance: 'startup_only_not_peak_or_hardware_acceptance' };
    await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write('RTL service is ready on 127.0.0.1:7860 (main 8B on :' + declaration.deployment.main.port + ', auxiliary 27B on :' + declaration.deployment.aux.port + ')\n');
    if (degraded.length) process.stdout.write('Degraded components: ' + JSON.stringify(degraded) + '\n');
  } catch (error) {
    if (apiPid) try { process.kill(-apiPid, 'SIGTERM'); } catch {}
    if (dep) try { await stopModels(dep); } catch {}
    throw error;
  } finally {
    await lock.close(); await unlink(path.join(stateDir, 'startup.lock')).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
