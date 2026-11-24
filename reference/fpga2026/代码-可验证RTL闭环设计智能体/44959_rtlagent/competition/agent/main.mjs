import { requireSharedMain } from '../../rtl-agent/src/dual/config.mjs';
import { archiveDualWork } from '../../rtl-agent/src/dual/archive.mjs';
import { runDualCompetition } from './dual-entry.mjs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { loadConfig } from '../../rtl-agent/src/config.mjs';
import { runWorkflow } from '../../rtl-agent/src/workflow.mjs';
import { freezeTask } from '../../rtl-agent/src/task-snapshot.mjs';
import { connectVivadoMcp } from '../../rtl-agent/src/mcp-client.mjs';
import { checkInterface, expectedInterface } from './interface.mjs';
import { BASELINE_MAX_TOKENS, requireSharedGeneration } from '../config/generation.mjs';
import { assertCheckerUnchanged, createFailureReviewer, prepareSelfCheck } from '../../rtl-agent/src/self-check.mjs';
import { candidateEvidenceRank } from '../../rtl-agent/src/candidate-evidence.mjs';
import { checkWithSlang, slangFailure } from '../../rtl-agent/src/slang-precheck.mjs';

export async function atomicWrite(file, content) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, content, { flag: 'wx' });
  try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
}

async function inputFile(directory, name, optional = false) {
  const file = path.join(directory, name);
  let info;
  try { info = await lstat(file); } catch (error) { if (optional && error.code === 'ENOENT') return ''; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`Invalid ${name}: expected a regular UTF-8 file of at most 1 MiB`);
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
}

// Dependency injection is for tests. The CLI always uses the real model and MCP.
export async function runCompetition({ inputDir, outputDir, env = process.env, signal, generate, connect = connectVivadoMcp, precheck = checkWithSlang, append = appendFile }) {
  const started = Date.now();
  inputDir = path.resolve(inputDir); outputDir = path.resolve(outputDir);
  await mkdir(outputDir, { recursive: true });
  await atomicWrite(path.join(outputDir, 'solution.v'), '');
  await writeFile(path.join(outputDir, 'trace.jsonl'), '');
  let queue = Promise.resolve(), workspace, scratch, mcp, result, selfCheck, best = { rank: -1, code: '', checks: [] };
  let modelCalls = 0, retainEvidenceWorkspace = false, dualArchivePlan, mcpCleanupConfirmed = true;
  let traceWriteFailures = 0, lastTraceWriteError = null;
  const record = event => {
    if (['role_start', 'llm_start', 'llm_route_start'].includes(event.tool)) modelCalls++;
    queue = queue.then(() => append(path.join(outputDir, 'trace.jsonl'), JSON.stringify({ ts: Date.now() / 1000, ...event }) + '\n'))
      .catch(error => { traceWriteFailures++; lastTraceWriteError = error?.code ?? 'WRITE_FAILED'; });
  };
  const secrets = [env.LLM_API_KEY, env.FPGACHINA_TOKEN].filter(value => value && value.length > 3);
  const safe = value => secrets.reduce((s, secret) => s.split(secret).join('[REDACTED]'), String(value)).slice(0, 2000);
  const publish = async (code, rank, checks) => {
    if (rank >= best.rank) { best = { code, rank, checks }; await atomicWrite(path.join(outputDir, 'solution.v'), code); }
  };
  try {
    const budget = Number(env.AGENT_DEADLINE_S);
    if (!Number.isFinite(budget) || budget <= 0 || budget > 86400) throw new Error('AGENT_DEADLINE_S must be a positive per-request budget');
    if (!env.AGENT_CONFIG || !path.isAbsolute(env.AGENT_CONFIG)) throw new Error('AGENT_CONFIG must name an absolute configuration file');
    if (!env.LLM_BASE_URL || !env.MODEL_NAME) throw new Error('LLM_BASE_URL and MODEL_NAME are required; external API fallback is disabled');
    const endpoint = new URL(env.LLM_BASE_URL);
    if (!['http:', 'https:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('The competition model must use a local HTTP endpoint without embedded credentials');
    const config = await loadConfig(env.AGENT_CONFIG);
    config.model.baseUrl = env.LLM_BASE_URL.replace(/\/$/, ''); config.model.id = env.MODEL_NAME;
    if (env.LLM_API_KEY) { config.model.apiKey = env.LLM_API_KEY; delete config.model.apiKeyEnv; }
    if (config.model.contextWindow <= BASELINE_MAX_TOKENS) throw new Error('Shared model context must leave input space in addition to the fixed 16384-token baseline output');
    requireSharedGeneration(config.model);
    if (['dual_v1', 'planner_v1', 'planner_v2'].includes(config.workflowMode)) {
      requireSharedMain(config);
      if (env.LLM_API_KEY) { config.dual.mainModel.apiKey = env.LLM_API_KEY; delete config.dual.mainModel.apiKeyEnv; }
    }
    const prompt = await inputFile(inputDir, 'prompt.txt');
    if (!prompt.trim()) throw new Error('prompt.txt is empty');
    const interfaceText = await inputFile(inputDir, 'interface.txt', true);
    const expected = expectedInterface(prompt, interfaceText);
    scratch = path.resolve(env.EDA_TMP || path.join(os.tmpdir(), 'eda'));
    await mkdir(scratch, { recursive: true }); scratch = await realpath(scratch);
    workspace = await mkdtemp(path.join(scratch, 'rtl-agent-'));
    config.outputDir = path.join(workspace, 'runs'); config.mcp.workspaceRoot = workspace;
    let task = { id: 'request-' + randomUUID().slice(0, 8), top: expected.top, spec: prompt,
      stages: ['compile', 'synthesize'], clockPeriodNs: 5 };
    const clock = expected.ports.find(port => port.direction === 'input' && /^(clk|clock)$/i.test(port.name));
    if (clock) task.clockPort = clock.name;
    const taskPath = path.join(workspace, 'task.json'), configPath = path.join(workspace, 'config.json');
    await writeFile(taskPath, JSON.stringify(task));
    // The MCP only receives toolchain configuration, never model credentials.
    await writeFile(configPath, JSON.stringify({ ...config, dual: undefined, workflowMode: 'legacy', model: { ...config.model, apiKey: 'unused', apiKeyEnv: undefined } }));
    const deadline = AbortSignal.timeout(Math.max(1, Math.floor(budget * 1000 - 500)));
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    record({ tool: 'agent_meta', model: env.MODEL_NAME, scope: 'competition_no_official_oracle', functional_verified: false });
    mcp = await connect({ configPath, config, signal: combined });
    const info = await mcp.info({ signal: combined });
    record({ tool: 'preflight', rc: info.ok ? 0 : -1, excerpt: (info.diagnostics ?? []).join('; ') });
    if (!info.ok) throw new Error('Vivado 2026.1 preflight failed; check tool paths and logs');
    if (['dual_v1', 'planner_v1', 'planner_v2'].includes(config.workflowMode)) {
      result = await runDualCompetition({ config, task, prompt, interfaceText, expected, workspace, outputDir, mcp, record,
        signal: combined, deadline: started + budget * 1000 - 500, generate,
        persistentRoot: env.DUAL_EVIDENCE_ROOT || path.join(scratch, 'rtl2llm-evidence'),
        registerArchive: plan => { dualArchivePlan = plan; }, onPublish: base => { best.code = base.rtl; },
        identityCacheFile: env.AGENT_IDENTITY_CACHE ? path.resolve(env.AGENT_IDENTITY_CACHE)
          : env.SERVICE_STATE_DIR ? path.join(path.resolve(env.SERVICE_STATE_DIR), 'weight-identity-cache.json') : null });
      return result;
    }
    if (config.agent.selfCheck.mode !== 'off') {
      // No reference material or candidate RTL enters this preparation call.
      const available = budget * 1000 - (Date.now() - started) - 180000;
      if (available >= 30000) {
        config.agent.selfCheck.timeoutMs = Math.floor(Math.min(config.agent.selfCheck.timeoutMs, available));
        selfCheck = await prepareSelfCheck({ task, expected, config, workspace, generate, check: args => mcp.check(args), signal: combined, onRecord: record });
        if (selfCheck) { task = selfCheck.task; await writeFile(taskPath, JSON.stringify(task)); }
      } else record({ tool: 'self_test_unavailable', rc: 1, reason: 'Insufficient preparation budget; preserve generation time' });
    }
    const remaining = budget * 1000 - (Date.now() - started) - 500;
    if (remaining <= 0) throw new Error('The per-request time budget expired before generation');
    config.agent.totalTimeoutMs = Math.max(1, Math.floor(Math.min(config.agent.totalTimeoutMs, remaining)));
    result = await runWorkflow({ config, task, mode: 'agent', signal: combined, generate,
      ...(selfCheck && config.agent.selfCheck.diagnose ? { reviewFailure: createFailureReviewer({ config, directory: selfCheck.directory, generate, onRecord: record }) } : {}),
      verificationScope: 'competition_no_official_oracle', backend: mcp.metadata,
      prepareTask: ({ task, runDir }) => freezeTask({ task, taskPath, workspaceRoot: workspace, runDir }),
      onEvent: event => {
        if (event.phase === 'routing') record({ tool: 'routing', tier: event.tier, family: event.family, source: event.source, reasons: event.reasons, sec: event.durationMs / 1000, model_calls: event.modelCalls,
          usage: event.usage, classifier_error: event.classifierError, classifier_finish: event.classifierFinish });
        if (event.phase === 'routing_model') record({ tool: 'llm_route_start', rc: null, max_tokens: event.maxTokens, timeout_ms: event.timeoutMs });
        if (['generate', 'repair', 'regenerate'].includes(event.phase)) record({ tool: 'llm_start', round: event.attempt, kind: event.phase, rc: null });
        if (event.phase === 'output_recovery') record({ tool: 'output_recovery', round: event.attempt, action: event.action });
        if (event.phase === 'skills') record({ tool: 'skills', round: event.attempt, ids: event.ids });
        if (event.phase === 'rag') record({ tool: 'rag', round: event.attempt, decision: event.decision, reason: event.reason,
          policy: event.policy, sec: event.durationMs / 1000, query_sha256: event.querySha256, manifest_sha256: event.manifestSha256,
          documents: event.documents, skipped: event.skipped });
        if (event.phase === 'error') record({ tool: 'controller', round: event.attempt, rc: 1, excerpt: event.failureKind });
        if (event.phase === 'model' && event.event.type === 'response') record({ tool: 'model_response', round: event.attempt,
          usage: event.event.usage, timing: event.event.timing, finish: event.event.stopReason });
      },
      verify: async args => {
        const code = await readFile(args.rtlPath, 'utf8'), checked = checkInterface(code, expected);
        record({ tool: 'candidate', round: Number(path.basename(args.workDir).replace('attempt-', '')), sha256: createHash('sha256').update(code).digest('hex'),
          ...(Buffer.byteLength(code) <= 131072 ? { rtl: code } : { rtl_omitted: 'size_budget' }) });
        const executable = code.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, token => token.startsWith('"') ? '""' : ' ');
        if (/\$(?:readmem[bh]|writemem[bh]|sdf_annotate)\b/i.test(executable)) {
          record({ tool: 'source_boundary', rc: 1, excerpt: 'External memory/timing files are not supplied in the standalone task' });
          return { passed: false, oracleKind: 'none', stages: [{ name: 'compile', status: 'fail', durationMs: 0, logPath: null, diagnostics: ['Return self-contained RTL without external memory/timing files'] }], feedback: 'Return self-contained RTL without external memory/timing files' };
        }
        record({ tool: 'check_interface', ...checked });
        // Shared policy binds known widths/names but retains the historical
        // advisory handling of direction-only typos in prompt port lists.
        if (checked.blocking) return { passed: false, oracleKind: 'none',
          stages: [{ name: 'compile', status: 'fail', durationMs: 0, logPath: null, diagnostics: [checked.excerpt] }], feedback: checked.excerpt };
        // Publish complete candidates before expensive EDA, so forced termination
        // cannot erase the last useful result. Later weak candidates do not replace
        // an earlier candidate with stronger compile/synthesis evidence.
        await publish(code, 0, []);
        if (config.agent.rtlPrecheck.mode !== 'off') {
          const preflight = await precheck({ rtlPath: args.rtlPath, top: args.task.top, workDir: args.workDir,
            options: config.agent.rtlPrecheck, signal: args.signal });
          args.signal?.throwIfAborted();
          record({ tool: 'rtl_precheck', engine: 'pyslang', round: Number(path.basename(args.workDir).replace('attempt-', '')),
            decision: preflight.decision, reason: preflight.reason, errors: preflight.errors, warnings: preflight.warnings,
            sec: preflight.durationMs / 1000, functional_verified: false });
          const failure = slangFailure(preflight, config.agent.maxFeedbackChars);
          if (failure) return failure;
        }
        if (selfCheck) await assertCheckerUnchanged(args.task.testbench.path, selfCheck.benchSha256);
        const validation = await mcp.check(args);
        for (const stage of validation.stages) record({ tool: stage.name === 'compile' ? 'lint' : stage.name === 'simulate' ? 'self_test' : 'synth',
          rc: stage.status === 'pass' ? 0 : ['error', 'timeout'].includes(stage.status) ? -1 : 1,
          status: stage.status, excerpt: safe(stage.diagnostics.join('; ')), sec: stage.durationMs / 1000, functional_verified: false });
        const checks = validation.stages.filter(stage => stage.status === 'pass').map(stage => stage.name);
        await publish(code, candidateEvidenceRank(validation), checks);
        return validation;
      },
    });
    for (const attempt of result.results.agent.attempts) record({ tool: 'llm', round: attempt.index,
      tokens_in: attempt.usage?.input ?? attempt.usage?.prompt_tokens ?? null,
      tokens_out: attempt.usage?.output ?? attempt.usage?.completion_tokens ?? null,
      usage: attempt.usage, timing: attempt.timing, duration_s: attempt.durationMs / 1000,
      response_received: attempt.responseReceived, visible_text_chars: attempt.visibleTextChars, recovery_action: attempt.recoveryAction, generation_action: attempt.generationAction,
      candidate_sha256: attempt.candidateSha256, selected_skills: attempt.skills?.selected?.map(s => ({ id: s.id, sha256: s.sha256 })),
      rc: attempt.failureKind?.startsWith('MODEL_') ? 1 : 0, finish: attempt.stopReason ?? null, excerpt: attempt.failureKind ?? '' });
    record({ tool: 'selection', rc: best.code ? 0 : 1, sha256: createHash('sha256').update(best.code).digest('hex'),
      checks: best.checks, functional_verified: false, self_test_passed: best.checks.includes('simulate'), model_calls: modelCalls, elapsed_s: (Date.now() - started) / 1000 });
    result = { solved: Boolean(best.code), checks: best.checks, functional_verified: false };
    return result;
  } catch (error) {
    record({ tool: 'agent_error', rc: 1, excerpt: safe(error.message), functional_verified: false });
    result = { solved: Boolean(best.code), error: safe(error.message), functional_verified: false };
    return result;
  } finally {
    try { await mcp?.close(); } catch { mcpCleanupConfirmed = false; retainEvidenceWorkspace = Boolean(dualArchivePlan); record({ tool: 'cleanup', rc: 1, excerpt: 'MCP cleanup failed' }); }
    if (dualArchivePlan) {
      try { record({ tool: 'dual_archive', ...(await archiveDualWork({ ...dualArchivePlan, cleanupConfirmed: mcpCleanupConfirmed })), ...(mcpCleanupConfirmed ? {} : { recovery_workspace: workspace }), rc: mcpCleanupConfirmed ? 0 : 1 }); }
      catch (error) { retainEvidenceWorkspace = true; record({ tool: 'dual_archive', rc: 1, complete: false, recovery_workspace: workspace, excerpt: safe(error.message) }); }
    }
    await queue;
    if (traceWriteFailures > 0) result.trace_write_failures = traceWriteFailures;
    if (workspace && !retainEvidenceWorkspace && env.AGENT_KEEP_WORK !== '1') {
      const relative = path.relative(scratch, workspace);
      if (!relative.startsWith('rtl-agent-') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Refusing to remove an unexpected workspace');
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--input', '--output'].includes(argv[i]) || !argv[i + 1] || options[argv[i]]) throw new Error('Usage: main.mjs --input <directory> --output <directory>');
    options[argv[i]] = argv[i + 1];
  }
  if (!options['--input'] || !options['--output']) throw new Error('Both input and output directories are required');
  const controller = new AbortController(), stop = () => controller.abort(new Error('Request stopped'));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const env = { ...process.env };
  if (!env.MODEL_NAME && env.AGENT_CONFIG) env.MODEL_NAME = (await loadConfig(env.AGENT_CONFIG)).model.id;
  try { await runCompetition({ inputDir: options['--input'], outputDir: options['--output'], env, signal: controller.signal }); }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 2; });
}
