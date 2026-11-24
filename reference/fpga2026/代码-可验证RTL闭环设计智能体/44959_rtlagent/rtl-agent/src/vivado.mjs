import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCounterexample, summarizeCounterexample } from './counterexample.mjs';
import {sha256} from './dual/snapshot.mjs';
import {validateTraceDescriptor,parseObservation,compactObservation,decodeObservation,OBSERVATION_LIMIT} from './harness/observations.mjs';

const TOOL_NAMES = ['vivado', 'xvlog', 'xelab', 'xsim'];
const STAGES = ['compile', 'simulate', 'synthesize'];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LOG_LIMIT = 8 * 1024 * 1024;
const INFRA = /license.*(?:not found|failed|failure|unavailable|expired|denied)|(?:failed|unable|cannot|could not).*license|flexnet.*(?:error|failed)|segmentation fault|internal (?:error|exception)|access (?:is )?denied|permission denied|no space left|out of memory|bad allocation|\[XSIM 43-3409\]|Failed to compile generated C file/i;
const ERROR_LINE = /(?:^|\n)\s*(?:ERROR|FATAL(?:_ERROR)?)(?:\s*:|\s+\[)|\b(?:syntax error|Assertion failed)\b/i;

function validateConfig(config) {
  if (!config || typeof config.binDir !== 'string' || !config.binDir.trim()) throw new Error('vivado.binDir is required');
  const result = {
    ...config,
    binDir: path.resolve(config.binDir),
    stageTimeoutMs: config.stageTimeoutMs ?? 120000,
    synthesisTimeoutMs: config.synthesisTimeoutMs ?? 180000,
    maxThreads: config.maxThreads ?? 2,
    part: config.part ?? 'xczu3eg-sbva484-1-e',
  };
  if (config.expectedVersion !== '2026.1') throw new Error('Vivado 2026.1 is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,99}$/.test(result.part)) throw new Error('Invalid FPGA part');
  for (const key of ['stageTimeoutMs', 'synthesisTimeoutMs']) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 3600000) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(result.maxThreads) || result.maxThreads < 1 || result.maxThreads > 64) throw new Error('Invalid maxThreads');
  return result;
}

function validateTask(task) {
  if (!task || !IDENTIFIER.test(task.top ?? '')) throw new Error('Invalid top module name');
  if (task.clockPort !== undefined && !IDENTIFIER.test(task.clockPort)) throw new Error('Invalid clock port name');
  const period = task.clockPeriodNs ?? 5;
  if (typeof period !== 'number' || !Number.isFinite(period) || period <= 0 || period > 1000000) throw new Error('Invalid clock period');
  if (!Array.isArray(task.stages) || task.stages.length === 0 || task.stages.some(s => !STAGES.includes(s)) || new Set(task.stages).size !== task.stages.length) throw new Error('Invalid check stages');
  if (task.testbench) {
    const tb = task.testbench;
    if (!path.isAbsolute(tb.path ?? '') || !IDENTIFIER.test(tb.top ?? '')) throw new Error('Invalid testbench path or top');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}\.txt$/.test(tb.resultFile ?? '')) throw new Error('Invalid testbench result filename');
    if (!Number.isSafeInteger(tb.expectedChecks) || tb.expectedChecks < 1) throw new Error('Invalid expected test count');
    if(tb.observation){
      validateTraceDescriptor(tb.observation);
      if(tb.origin!=='self_generated_spec_vectors'||!/^[a-f0-9]{64}$/.test(tb.observerBenchSha256??''))throw new Error('Observation requires a frozen self-generated checker');
    }
  }
}

async function findTools(config) {
  const tools = {};
  for (const name of TOOL_NAMES) {
    const suffixes = process.platform === 'win32' ? ['.bat', '.cmd', '.exe'] : [''];
    for (const suffix of suffixes) {
      const file = path.join(config.binDir, name + suffix);
      try { await access(file); tools[name] = file; break; } catch { /* Try the next supported launcher. */ }
    }
  }
  return tools;
}

export function launchSpec(executable, args) {
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(executable)) {
    // cmd is required by AMD's batch launchers. Only quoted, validated tokens
    // are permitted; no command or Tcl text supplied by the model is accepted.
    const tokens = [executable, ...args];
    if (tokens.some(token => /[\r\n"%!^&|<>]/.test(token))) throw new Error('Unsafe character in Windows launcher argument');
    const command = `"${tokens.map(token => `"${token}"`).join(' ')}"`;
    return {
      executable: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/v:off', '/c', command],
      windowsVerbatimArguments: true,
    };
  }
  return { executable, args, windowsVerbatimArguments: false };
}

export async function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 5000);
      killer.once('error', () => { clearTimeout(timer); child.kill(); resolve(); });
      killer.once('close', () => { clearTimeout(timer); resolve(); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
}

export async function runProcess(executable, args, { cwd, timeoutMs, signal, logPath }) {
  if (signal?.aborted) return { exitCode: null, cancelled: true, timedOut: false, text: 'Operation cancelled before launch.' };
  const spec = launchSpec(executable, args);
  const log = logPath ? createWriteStream(logPath, { flags: 'a' }) : null;
  let head = '', tail = '', bytes = 0, timedOut = false, cancelled = false, spawnError, logError;
  let observedError = false, observedInfrastructureError = false;
  const previousChunks = { stdout: '', stderr: '' };
  const collect = (chunk, stream) => {
    const text = chunk.toString('utf8');
    // stdout and stderr have independent line boundaries. Interleaving a long
    // stdout line before stderr must not hide a stderr FATAL at its first byte.
    const scan = previousChunks[stream] + text;
    observedError ||= ERROR_LINE.test(scan);
    observedInfrastructureError ||= INFRA.test(scan);
    previousChunks[stream] = scan.slice(-1024);
    if (head.length < 262144) head += text.slice(0, 262144 - head.length);
    tail = (tail + text).slice(-32768);
    if (log && bytes < LOG_LIMIT) {
      const remaining = LOG_LIMIT - bytes;
      log.write(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      if (bytes === LOG_LIMIT) log.write('\n[runner: log truncated at 8 MiB]\n');
    }
  };
  if (log) log.on('error', error => { logError = error.message; });
  return await new Promise(resolve => {
    const child = spawn(spec.executable, spec.args, {
      cwd, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments,
      shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cleanup = Promise.resolve();
    const stop = () => { if (child.exitCode === null) cleanup = killTree(child); };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    child.on('error', error => { spawnError = error.message; });
    child.once('close', async exitCode => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await cleanup;
      if (log) await new Promise(done => { if (log.destroyed) done(); else log.end(done); });
      resolve({ exitCode, cancelled, timedOut, spawnError, logError, observedError, observedInfrastructureError, text: head + (head.endsWith(tail) ? '' : '\n[recent output]\n' + tail) });
    });
  });
}

function summarize(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Preserve the first concrete counterexamples ahead of compiler warnings.
  const counterexamples = lines.filter(line => /\b(?:CHECK_FAIL|ASYNC_CHANGE|CHECK_COUNT_FAIL)\b/i.test(line));
  const mismatches = lines.filter(line => /^Hint: Output .+ has [1-9]\d* mismatches?\b/i.test(line));
  const summaries = lines.filter(line => /^Hint: Output .+ has no mismatches|^Hint: Total mismatched samples|^Mismatches:/i.test(line));
  const relevant = lines.filter(line => /error|fatal|warning|mismatch|license|failed|exception/i.test(line));
  const trace = parseCounterexample(text);
  const traceLines = trace ? [summarizeCounterexample(trace), 'Public checker samples (both edges, ps; not post-NBA):', ...lines.filter(line => line.startsWith('RTL_CE '))] : [];
  const selected = [...new Set([...traceLines, ...counterexamples.slice(0, 4), ...mismatches, ...summaries, ...relevant])];
  return (selected.length ? selected.slice(0, 12) : lines.slice(-8)).map(line => line.slice(0, 600));
}

function outcome(result) {
  if (result.timedOut) return { status: 'timeout', diagnostics: ['Tool exceeded its wall-clock timeout; its process tree was terminated.', ...summarize(result.text)] };
  if (result.cancelled) return { status: 'error', diagnostics: ['Operation cancelled; its process tree was terminated.'] };
  if (process.platform === 'win32' && Number.isInteger(result.exitCode) && (result.exitCode >>> 0) >= 0xc0000000) {
    return { status: 'error', diagnostics: [`Vivado process crashed (Windows exit 0x${(result.exitCode >>> 0).toString(16).toUpperCase()}); this is not an RTL syntax verdict.`, ...summarize(result.text)] };
  }
  if (result.spawnError || result.logError || result.observedInfrastructureError || INFRA.test(result.text)) return { status: 'error', diagnostics: [result.spawnError ?? result.logError ?? 'Vivado infrastructure or license error.', ...summarize(result.text)] };
  if (result.exitCode !== 0 || result.observedError || ERROR_LINE.test(result.text)) return { status: 'fail', diagnostics: [`Tool exited with code ${result.exitCode}.`, ...summarize(result.text)] };
  return { status: 'pass', diagnostics: summarize(result.text) };
}

export async function inspectVivado(config, options = {}) {
  const cfg = validateConfig(config);
  const tools = await findTools(cfg);
  const missing = TOOL_NAMES.filter(name => !tools[name]);
  if (!tools.vivado) return { available: false, ok: false, version: null, expectedVersion: cfg.expectedVersion ?? null, versionMatches: false, binDir: cfg.binDir, tools, diagnostics: [`Missing Vivado tools: ${missing.join(', ')}`] };
  const result = await runProcess(tools.vivado, ['-version'], { cwd: os.tmpdir(), timeoutMs: Math.min(cfg.stageTimeoutMs, 15000), signal: options.signal });
  const version = /Vivado\s+v?(\d{4}\.\d+)/i.exec(result.text)?.[1] ?? null;
  const versionMatches = version !== null && (!cfg.expectedVersion || version === cfg.expectedVersion);
  const diagnostics = [];
  if (missing.length) diagnostics.push(`Missing Vivado tools: ${missing.join(', ')}`);
  if (outcome(result).status !== 'pass') diagnostics.push(...outcome(result).diagnostics);
  if (!version) diagnostics.push('Could not identify the installed Vivado version.');
  else if (!versionMatches) diagnostics.push(`Expected Vivado ${cfg.expectedVersion}, found ${version}.`);
  const available = missing.length === 0 && outcome(result).status === 'pass' && version !== null;
  return { available, ok: available && versionMatches, version, expectedVersion: cfg.expectedVersion ?? null, versionMatches, binDir: cfg.binDir, tools, diagnostics };
}

async function copySource(source, destination) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Source must be a regular file of at most 2 MiB');
  await copyFile(source, destination);
}

function emit(callback, event) {
  try { const promise = callback?.(event); promise?.catch?.(() => {}); } catch { /* Observers cannot alter tool verdicts. */ }
}

export async function checkRtl({ rtlPath, task, config, workDir, executionRoot, signal, onEvent, executor }) {
  const cfg = validateConfig(config);
  validateTask(task);
  if (!path.isAbsolute(rtlPath ?? '') || !path.isAbsolute(workDir ?? '')) throw new Error('rtlPath and workDir must be absolute paths');
  if (executionRoot !== undefined && !path.isAbsolute(executionRoot)) throw new Error('executionRoot must be an absolute path');
  await mkdir(workDir, { recursive: true });
  await mkdir(executionRoot ?? workDir, { recursive: true });
  const runDir = await mkdtemp(path.join(executionRoot ?? workDir, 'vivado-'));
  const artifactIndex = path.join(workDir, `${path.basename(runDir)}-artifacts.json`);
  await writeFile(artifactIndex, JSON.stringify({ artifactDir: runDir, requestedWorkDir: workDir, rtlPath, testbenchPath: task.testbench?.path }, null, 2));
  const stages = [];let observation;
  const requested = STAGES.filter(stage => task.stages.includes(stage) || (stage === 'compile' && task.stages.includes('simulate')));
  const oracleKind = task.testbench?.origin === 'self_generated_spec_vectors' ? 'self_generated_spec_vectors' : task.testbench ? 'public_testbench' : 'none';
  const benchLabel = oracleKind === 'self_generated_spec_vectors' ? 'Self-generated specification checks' : 'Public testbench';
  const finish = version => {
    const passed = stages.length > 0 && stages.every(stage => stage.status === 'pass');
    // Put failing evidence before successful-stage banners so a repair prompt's
    // feedback limit cannot hide the actual mismatch. Full logs stay in artifacts.
    const failing = stages.filter(stage => ['fail', 'error', 'timeout'].includes(stage.status));
    const other = stages.filter(stage => !failing.includes(stage));
    const feedback = [...failing, ...other].map(stage => `${stage.name}: ${stage.status}` +
      (stage.status === 'pass' ? '' : `\n${stage.diagnostics.join('\n')}`)).join('\n\n') + (oracleKind === 'none' ? '\n\nNo testbench oracle: functional correctness has not been verified.' : oracleKind === 'self_generated_spec_vectors'
      ? '\n\nSelf-generated specification checks are fallible; this is not official functional verification.' : '\n\nSimulation verdict refers only to the configured public testbench.');
    return { passed, stages, version, feedback: feedback.slice(0, 12000), oracleKind, artifactDir: runDir, artifactIndex,...(observation?{observation}:{}) };
  };
  // Leave room for xsim.dir/sim_snapshot/obj and legacy tool-generated names.
  if (process.platform === 'win32' && runDir.length > 160) {
    stages.push({ name: requested[0], status: 'error', diagnostics: ['Vivado execution path exceeds the 160-character workspace limit. Use MCP with a shorter workspace root; do not repair the RTL for this tool-path problem.'], logPath: null, durationMs: 0 });
    return finish(null);
  }
  const installed = await inspectVivado(cfg, { signal });
  if (!installed.ok) {
    stages.push({ name: requested[0], status: 'error', diagnostics: installed.diagnostics, logPath: null, durationMs: 0 });
    return finish(installed.version);
  }
  await copySource(rtlPath, path.join(runDir, 'dut.sv'));
  if (task.testbench) await copySource(task.testbench.path, path.join(runDir, 'tb.sv'));
  const candidateSha256=task.testbench?.observation?sha256(await readFile(path.join(runDir,'dut.sv'))):null;
  if(task.testbench?.observation&&sha256(await readFile(path.join(runDir,'tb.sv')))!==task.testbench.observerBenchSha256)throw new Error('Frozen observer checker hash changed');
  await writeFile(path.join(runDir, 'run_sim.tcl'), 'run all\nquit\n', 'utf8');
  const clock = task.clockPort ? `create_clock -name task_clock -period ${task.clockPeriodNs ?? 5} [get_ports {${task.clockPort}}]\n` : '# No clock port specified by the task.\n';
  await writeFile(path.join(runDir, 'constraints.xdc'), clock, 'utf8');
  const synthesis = `${executor ? 'catch {close_design}\ncatch {close_project}\n' : ''}set_param general.maxThreads ${cfg.maxThreads}\nif {[catch {\n  read_verilog -sv dut.sv\n  read_xdc constraints.xdc\n  synth_design -top ${task.top} -part ${cfg.part}\n  report_utilization -file utilization.rpt\n  write_checkpoint -force post_synth.dcp\n} err]} {\n  puts stderr $err\n  ${executor ? 'error $err' : 'exit 1'}\n}\n${executor ? '' : 'exit 0\n'}`;
  await writeFile(path.join(runDir, 'synth.tcl'), synthesis, 'utf8');
  let blocked = false;
  for (const name of requested) {
    const started = Date.now();
    const logPath = path.join(runDir, `${name}.log`);
    if (blocked) {
      stages.push({ name, status: 'skipped', diagnostics: ['An earlier stage did not pass.'], logPath: null, durationMs: 0 });
      continue;
    }
    if (name === 'simulate' && !task.testbench) {
      stages.push({ name, status: 'skipped', diagnostics: ['No public testbench was configured; functional correctness is unverified.'], logPath: null, durationMs: 0 });
      continue;
    }
    emit(onEvent, { type: 'stage_start', stage: name, logPath });
    const run = async (tool, args, timeoutMs = cfg.stageTimeoutMs) => {
      const options = { cwd: runDir, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), signal, logPath };
      return executor ? executor({ tool, executable: installed.tools[tool], args, ...options }) : runProcess(installed.tools[tool], args, options);
    };
    let result;
    if (name === 'compile') {
      result = await run('xvlog', ['-sv', 'dut.sv', ...(task.testbench ? ['tb.sv'] : [])]);
      if (outcome(result).status === 'pass') {
        // Supply missing simulation units only. Never override a module's
        // explicit timeunit/timeprecision; this is unrelated to the XDC clock period.
        result = await run('xelab', [`work.${task.testbench?.top ?? task.top}`, '--timescale', '1ns/1ps', '-debug', 'typical', '-s', 'sim_snapshot', '-mt', String(cfg.maxThreads)]);
      }
    } else if (name === 'simulate') {
      result = await run('xsim', ['sim_snapshot', '-tclbatch', 'run_sim.tcl', '-onfinish', 'quit', '-onerror', 'quit']);
    } else {
      result = await run('vivado', ['-mode', 'batch', '-nojournal', '-source', 'synth.tcl'], cfg.synthesisTimeoutMs);
    }
    const stage = { name, ...outcome(result), logPath, durationMs: Date.now() - started };
    if (name === 'simulate') {
      const counterexample = parseCounterexample(result.text);
      if (counterexample) stage.counterexample = counterexample;
      if (oracleKind === 'self_generated_spec_vectors') {
        const witness = result.text.split(/\r?\n/).filter(line => /^RTL_SELFTEST_(?:FAIL|INPUT) /.test(line)).slice(0, 65);
        if (witness.length) stage.diagnostics = [...witness, ...stage.diagnostics];
      }
    }
    if (stage.status === 'pass' && name === 'simulate') {
      let content = '';
      try {
        const resultPath = path.join(runDir, task.testbench.resultFile);
        const stat = await lstat(resultPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error('Invalid result file');
        content = await readFile(resultPath, 'utf8');
      } catch { /* Missing/invalid completion is an inconclusive simulation, never a pass. */ }
      const match = /^checks=(\d+) failures=(\d+)\s*$/.exec(content);
      if (match && Number.isSafeInteger(Number(match[1])) && Number.isSafeInteger(Number(match[2])) && Number(match[1]) === task.testbench.expectedChecks && Number(match[2]) <= Number(match[1])) {
        stage.completed = true; stage.checks = Number(match[1]); stage.failures = Number(match[2]);
      }
      if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || Number(match[1]) !== task.testbench.expectedChecks || Number(match[2]) !== 0) {
        stage.status = 'fail';
        const completedWithFailures = match && Number(match[1]) === task.testbench.expectedChecks && Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0;
        stage.diagnostics = [completedWithFailures
          ? `${benchLabel} completed ${match[1]} checks with ${match[2]} failures.`
          : `Testbench did not prove completion: expected checks=${task.testbench.expectedChecks} failures=0; got ${JSON.stringify(content.slice(0, 256))}.`,
        ...stage.diagnostics];
      } else {
        stage.diagnostics = [`${benchLabel} completed ${match[1]} checks with zero failures.`, ...stage.diagnostics];
      }
    }
    if(name==='simulate'&&task.testbench?.observation){
      try{
        if(!stage.completed)throw new Error('Simulation did not complete; observation is partial or unavailable');
        const file=path.join(runDir,task.testbench.observation.file),stat=await lstat(file);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>OBSERVATION_LIMIT)throw new Error('Invalid observation file');
        const trace=parseObservation(await readFile(file,'utf8'),task.testbench.observation,{candidateSha256,benchSha256:task.testbench.observerBenchSha256,checks:stage.checks,failures:stage.failures});
        observation={status:'complete',view:compactObservation(trace)};
        if(JSON.stringify(decodeObservation(observation.view))!==JSON.stringify(trace))throw new Error('Observation table roundtrip lost data');
        await writeFile(path.join(runDir,'observation.json'),JSON.stringify(trace));
        await writeFile(path.join(runDir,'observation-table.json'),JSON.stringify(observation.view));
      }catch(error){
        observation={status:'incomplete',code:'OBSERVATION_INVALID',reason:String(error.message).slice(0,300)};
        if(stage.status==='pass'||stage.completed)stage.status='error';
        stage.diagnostics.unshift('Observation incomplete/invalid; do not infer DUT behavior from missing rows.');
      }
    }
    if (stage.status === 'pass' && name === 'synthesize') {
      try {
        const checkpoint = await lstat(path.join(runDir, 'post_synth.dcp'));
        if (!checkpoint.isFile() || checkpoint.isSymbolicLink() || checkpoint.size === 0) throw new Error('Invalid checkpoint');
      }
      catch { stage.status = 'error'; stage.diagnostics = ['Vivado exited without the expected synthesis checkpoint.']; }
    }
    stages.push(stage);
    blocked = stage.status !== 'pass';
    emit(onEvent, { type: 'stage_end', stage: name, status: stage.status, durationMs: stage.durationMs });
  }
  return finish(installed.version);
}
