import { requireSharedMain } from '../../rtl-agent/src/dual/config.mjs';
import { createDualProbe } from '../../rtl-agent/src/dual/readiness.mjs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../rtl-agent/src/config.mjs';
import { loadSkillCatalog } from '../../rtl-agent/src/skills.mjs';
import { inspectEnvironment, requireEnvironment } from './check-environment.mjs';
import { connectVivadoMcp } from '../../rtl-agent/src/mcp-client.mjs';
import { BASELINE_MAX_TOKENS, requireSharedGeneration } from '../config/generation.mjs';

const exec = promisify(execFile);
const VRAM_LIMIT_GIB = (() => { try { return JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).deployment?.vram_limit_gib ?? 32; } catch { return 32; } })();

export function gpuMemory(json, index = 0) {
  const cards = Object.entries(json).filter(([key, value]) => /^(card|gpu)\d+$/i.test(key) && value && typeof value === 'object');
  const card = cards.find(([key]) => Number(key.match(/\d+/)[0]) === index)?.[1];
  if (!card) throw new Error('Selected GPU memory metrics are unavailable');
  const used = Number(card['VRAM Total Used Memory (B)']), total = Number(card['VRAM Total Memory (B)']);
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0 || used > total) throw new Error('Invalid GPU byte counters');
  return { usedBytes: used, totalBytes: total, usedGb: used / 1024 ** 3, totalGb: total / 1024 ** 3 };
}

export async function measureGpu(env = process.env) {
  try {
    const { stdout } = await exec(env.ROCM_SMI_BIN || 'rocm-smi', ['--showmeminfo', 'vram', '--json'], { env, timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true });
    return { ...gpuMemory(JSON.parse(stdout), Number(env.GPU_INDEX || 0)), source: 'rocm-smi' };
  } catch (smiError) {
    try {
      const program = fileURLToPath(new URL('../environment/gpu_memory.py', import.meta.url));
      const { stdout } = await exec(env.PYTHON_BIN || 'python3', ['-B', program, String(Number(env.GPU_INDEX || 0))], { env, timeout: 10000, maxBuffer: 65536, windowsHide: true });
      const value = JSON.parse(stdout);
      if (value.source !== 'hipMemGetInfo' || !Number.isFinite(value.usedBytes) || !Number.isFinite(value.totalBytes) || value.usedBytes < 0 || value.totalBytes <= 0 || value.usedBytes > value.totalBytes) throw new Error('Invalid HIP memory counters');
      return { ...value, usedGb: value.usedBytes / 1024 ** 3, totalGb: value.totalBytes / 1024 ** 3 };
    } catch (hipError) { throw new Error('GPU memory unavailable; rocm-smi: ' + smiError.message.slice(0, 300) + '; HIP: ' + hipError.message.slice(0, 300)); }
  }
}

export async function servedModels(env = process.env) {
  const url = new URL((env.LLM_BASE_URL || 'http://127.0.0.1:8000/v1').replace(/\/$/, '') + '/models');
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Inference endpoint must be local');
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Inference service is unavailable');
  const data = await response.json();
  return (data.data ?? []).map(item => item.id);
}

export function readiness(env = process.env, { initialEnvironment } = {}) {
  let preflight, cached, checkedAt = 0, pending, environment = initialEnvironment;
  const dualProbe = createDualProbe();
  const run = async () => {
    try {
      if (process.platform !== 'linux') throw new Error('Production acceptance requires Linux');
      if (!env.AGENT_CONFIG || !env.MODEL_NAME) throw new Error('Runtime configuration and model declaration are required');
      const config = await loadConfig(env.AGENT_CONFIG);
      if (config.model.id !== env.MODEL_NAME || config.model.baseUrl.replace(/\/$/, '') !== (env.LLM_BASE_URL || '').replace(/\/$/, '')) throw new Error('Agent and baseline model configuration differ');
      if (config.model.contextWindow <= BASELINE_MAX_TOKENS) throw new Error('Shared context has no input space beyond the 16384-token baseline output');
      requireSharedGeneration(config.model);
      if (!preflight) {
        environment ??= await inspectEnvironment(env);
        requireEnvironment(environment);
        if (config.skills.enabled) await loadSkillCatalog(config.skills);
        const work = path.resolve(env.EDA_TMP || '/var/tmp/eda'); await mkdir(work, { recursive: true });
        for (const tool of ['vivado', 'xvlog', 'xelab', 'xsim']) await access(path.join(config.vivado.binDir, tool));
        const { stdout } = await exec(path.join(config.vivado.binDir, 'vivado'), ['-version'], { cwd: work, timeout: 5000, maxBuffer: 65536 });
        if (!/Vivado\s+v?2026\.1\b/i.test(stdout)) throw new Error('Vivado 2026.1 is required');
        if (config.mcp.backend === 'amd_ross') {
          const backend = await connectVivadoMcp({ configPath: env.AGENT_CONFIG, config, signal: AbortSignal.timeout(20000) });
          try { const info = await backend.info({ signal: AbortSignal.timeout(10000) }); if (!info.ok) throw new Error('Official MCP Vivado preflight failed'); }
          finally { await backend.close(); }
        }
        preflight = true;
      }
      if (['dual_v1', 'planner_v1', 'planner_v2'].includes(config.workflowMode)) {
        requireSharedMain(config);
        const dual = await dualProbe(config);
        if (!dual.ready) return { ready: false, dual_ready: false, track: 'rtl', model: env.MODEL_NAME, vram_gb: null, reason: dual.reason };
      }
      const [models, memory] = await Promise.all([servedModels(env), measureGpu(env)]);
      if (!models.includes(env.MODEL_NAME)) throw new Error('Served model identity does not match MODEL_NAME');
      // One declared limit (GiB, as reported by rocm-smi/HIP) for all loaded models.
      if (memory.usedGb > VRAM_LIMIT_GIB) throw new Error(`Measured GPU memory ${memory.usedGb.toFixed(2)} GiB exceeds the declared ${VRAM_LIMIT_GIB} GiB limit`);
      return { ready: true, ...(['dual_v1', 'planner_v1', 'planner_v2'].includes(config.workflowMode) ? { dual_ready: true } : {}), track: 'rtl', model: env.MODEL_NAME, vram_gb: Math.round(memory.usedGb * 10) / 10,
        environment_profile: environment.profile_id };
    } catch (error) {
      return { ready: false, track: 'rtl', model: env.MODEL_NAME || 'unconfigured', vram_gb: null, reason: error.message };
    }
  };
  return async () => {
    if (cached && Date.now() - checkedAt < 2000) return cached;
    if (!pending) pending = run().then(value => { cached = value; checkedAt = Date.now(); return value; }).finally(() => { pending = null; });
    return pending;
  };
}
