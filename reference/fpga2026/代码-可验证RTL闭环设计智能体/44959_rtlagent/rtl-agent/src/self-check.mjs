import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { generateRtl } from './model.mjs';
import { compileVectorPlan } from './compiled-plans.mjs';
import { compileScenarioPlan } from './verification/plan.mjs';
import {traceDescriptor} from './harness/observations.mjs';
import {renderTransactionTestbench,negativeTransactionRtl} from './verification/transaction-renderer.mjs';

const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_STEPS = 96;
const MAX_BYTES = 100000;
const sha = text => createHash('sha256').update(text).digest('hex');
const compact = text => text.replace(/\s+/g, ' ').trim();
const object = x => x && typeof x === 'object' && !Array.isArray(x);

export function parseRoleJson(text) {
  const source = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i, '$1');
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('Role response exceeds the JSON size budget');
  return JSON.parse(source);
}

export function bitLiteral(value, width) {
  if (typeof value !== 'string' || value.length > 8192 || !Number.isSafeInteger(width) || width < 1 || width > 4096) throw new Error('Use bounded strings for known bit values');
  let s = value.replace(/_/g, '').trim(), n;
  const sized = /^(\d+)'([hbd])([0-9a-f]+)$/i.exec(s);
  if (sized) {
    if (Number(sized[1]) !== width) throw new Error('Sized value does not match port width');
    const radix = sized[2].toLowerCase();
    if (radix === 'b' && !/^[01]+$/.test(sized[3]) || radix === 'd' && !/^\d+$/.test(sized[3])) throw new Error('Invalid bit value');
    n = BigInt((radix === 'h' ? '0x' : radix === 'b' ? '0b' : '') + sized[3]);
  } else if (/^-?\d+$/.test(s) || /^0[xb][0-9a-f]+$/i.test(s)) {
    n = BigInt(s);
  } else throw new Error('Values must be known integer literals; expressions and X/Z are not allowed');
  const modulus = 1n << BigInt(width);
  if (n >= modulus || n < -(modulus >> 1n)) throw new Error('Bit value is outside the port width');
  return `${width}'h${((n + modulus) % modulus).toString(16)}`;
}

export function validateVectorPlan(plan, { spec, expected }) {
  if (!object(plan) || plan.schema_version !== 1) throw new Error('Expected vector plan schema_version=1');
  if (plan.status === 'unsupported') {
    if (typeof plan.reason !== 'string' || !plan.reason.trim() || plan.reason.length > 1000) throw new Error('Unsupported plans need a bounded reason');
    return { schema_version: 1, status: 'unsupported', reason: plan.reason };
  }
  if (plan.status !== 'ready') throw new Error('Plan status must be ready or unsupported');
  if (Object.keys(plan).some(key => !['schema_version', 'status', 'constraints', 'steps', 'expectedChecks', 'distinctInputStates'].includes(key))) throw new Error('Unsupported plan instructions');
  const ports = expected.ports;
  if (!ID.test(expected.top) || !ports?.length || ports.length > 64 || expected.unresolved?.length || ports.some(p => !ID.test(p.name) || !['input', 'output'].includes(p.direction) || !Number.isSafeInteger(p.width) || p.width < 1 || p.width > 4096)) throw new Error('A resolved input/output interface is required for vector checks');
  if (new Set(ports.map(p => p.name)).size !== ports.length) throw new Error('Duplicate interface ports');
  const inputs = ports.filter(p => p.direction === 'input'), outputs = ports.filter(p => p.direction === 'output');
  if (!inputs.length || !outputs.length) throw new Error('Vector checks require input and output ports');
  if (!Array.isArray(plan.constraints) || !plan.constraints.length || plan.constraints.length > 24) throw new Error('Expected 1..24 anchored behavior constraints');
  const ids = new Set();
  const constraints = plan.constraints.map(c => {
    if (!object(c) || !/^C[0-9]{1,2}$/.test(c.id) || ids.has(c.id) || typeof c.quote !== 'string' || c.quote.length < 6 || c.quote.length > 2000 || !compact(spec).includes(compact(c.quote)) || typeof c.claim !== 'string' || !c.claim.trim() || c.claim.length > 1500) throw new Error('Each constraint needs a unique C-number, an exact specification quote and a bounded claim');
    ids.add(c.id); return { id: c.id, quote: c.quote, claim: c.claim };
  });
  if (!Array.isArray(plan.steps) || plan.steps.length < 2 || plan.steps.length > MAX_STEPS) throw new Error(`Expected 2..${MAX_STEPS} explicit drive/check steps`);
  const byName = new Map(ports.map(p => [p.name, p])), checked = new Set(), states = new Set();
  let current = {}, expectedChecks = 0;
  const steps = plan.steps.map((step, index) => {
    if (!object(step) || !object(step.drive) || !object(step.expect)) throw new Error('Every step needs drive and expect objects');
    if (Object.keys(step).some(key => !['drive', 'expect', 'because'].includes(key))) throw new Error('Steps cannot contain implicit clocks, repeats, delays or other instructions');
    const values = (dict, direction) => Object.fromEntries(Object.entries(dict).map(([name, value]) => {
      const port = byName.get(name);
      if (!port || port.direction !== direction) throw new Error('Drive only inputs and check only declared outputs');
      return [name, bitLiteral(value, port.width)];
    }));
    const drive = values(step.drive, 'input'), expect = values(step.expect, 'output');
    if (index === 0 && inputs.some(p => !Object.hasOwn(drive, p.name))) throw new Error('The first step must initialize every input explicitly, including clocks');
    if (Object.keys(expect).length && (!Array.isArray(step.because) || !step.because.length || step.because.some(id => !ids.has(id)))) throw new Error('Every expected output must cite anchored behavior constraints');
    current = { ...current, ...drive }; states.add(JSON.stringify(Object.entries(current).sort()));
    for (const name of Object.keys(expect)) checked.add(name);
    expectedChecks += Object.keys(expect).length;
    return { drive, expect, because: Object.keys(expect).length ? [...new Set(step.because)] : [] };
  });
  if (expectedChecks < 3 || expectedChecks > 512 || outputs.some(p => !checked.has(p.name)) || states.size < 2) throw new Error('Need at least three comparisons, two input states, and checks of every output');
  const normalized = { schema_version: 1, status: 'ready', constraints, steps, expectedChecks, distinctInputStates: states.size };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_BYTES) throw new Error('Normalized plan exceeds size budget');
  return normalized;
}

export function renderVectorTestbench(plan, expected, {trace=false,clockPort=null}={}) {
  if(plan.transaction)return renderTransactionTestbench(plan,expected);
  const observation=trace?traceDescriptor(plan,expected,clockPort):null;
  const top = expected.top === 'rtl_selfcheck_tb' ? 'rtl_selfcheck_tb_2' : 'rtl_selfcheck_tb';
  const names = new Set(expected.ports.map(p => p.name));
  let prefix = '__rtl_check_';
  while (['checks', 'failures', 'reported', 'fd', 'dut', 'trace_fd'].some(n => names.has(prefix + n))) prefix += '_';
  const count = prefix + 'checks', failures = prefix + 'failures', reported = prefix + 'reported', fd = prefix + 'fd';
  const lines = ['`timescale 1ns/1ps', `module ${top};`, `integer ${count} = 0;`, `integer ${failures} = 0;`, `integer ${reported} = 0;`, `integer ${fd};`];
  for (const p of expected.ports) lines.push(`${p.direction === 'input' ? 'reg' : 'wire'} [${p.width - 1}:0] ${p.name};`);
  lines.push(`${expected.top} ${prefix}dut(${expected.ports.map(p => `.${p.name}(${p.name})`).join(', ')});`, 'initial begin');
  if(observation){
    lines.splice(lines.indexOf('initial begin'),0,`integer ${prefix}trace_fd;`);
    lines.push(`  ${prefix}trace_fd = $fopen("${observation.file}", "w");`,`  if (${prefix}trace_fd == 0) $fatal(1, "Observation file could not be opened");`,
      `  $fwrite(${prefix}trace_fd, "RTL_TRACE_V1 ${observation.plan_sha256}\\n");`);
  }
  plan.steps.forEach((step, index) => {
    if(step.clock_batch){
      const b=step.clock_batch,p=expected.ports.find(p=>p.name===b.port),active=b.edge==='posedge'?"1'h1":"1'h0",idle=b.edge==='posedge'?"1'h0":"1'h1";
      if(p?.direction!=='input'||p.width!==1||!['posedge','negedge'].includes(b.edge)||!Number.isSafeInteger(b.cycles)||b.cycles<1||b.cycles>1000000||Object.keys(step.drive).length!==1||step.drive[b.port]!==active)throw new Error('Invalid bounded clock batch');
      // The preceding setup has already settled at the inactive level. End
      // each unobserved cycle inactive; the normal step below is the last edge.
      lines.push(`  repeat (${b.cycles-1}) begin`, `    ${b.port} = ${active}; #2;`, `    ${b.port} = ${idle}; #2;`, '  end');
    }
    for (const [name, value] of Object.entries(step.drive)) lines.push(`  ${name} = ${value};`);
    lines.push('  #2;');
    if(observation)lines.push(`  $fwrite(${prefix}trace_fd, "${index}\\t%0d${expected.ports.map(()=>'\\t%b').join('')}\\n", $time, ${expected.ports.map(p=>p.name).join(', ')});`);
    for (const [name, value] of Object.entries(step.expect)) {
      const mask=step.masks?.[name],actual=mask?`(${name} & ${mask})`:name,wanted=mask?`(${value} & ${mask})`:value;
      lines.push(`  ${count} = ${count} + 1;`, `  if (${actual} !== ${wanted}) begin`, `    ${failures} = ${failures} + 1;`, `    if (${reported} == 0) begin`, `      ${reported} = 1;`,
        `      $display("RTL_SELFTEST_FAIL step=${index} port=${name} expected=%h actual=%h${mask?' care='+mask:''} constraints=${step.because.join(',')}", ${value}, ${name});`);
      for (const p of expected.ports.filter(p => p.direction === 'input')) lines.push(`      $display("RTL_SELFTEST_INPUT ${p.name}=%h", ${p.name});`);
      lines.push('    end', '  end');
    }
  });
  if(observation)lines.push(`  $fwrite(${prefix}trace_fd, "END\\t${plan.steps.length}\\t%0d\\t%0d\\n", ${count}, ${failures});`,`  $fclose(${prefix}trace_fd);`);
  lines.push(`  ${fd} = $fopen("selftest_result.txt", "w");`, `  if (${fd} == 0) $fatal(1, "Self-check completion file could not be opened");`,
    `  $fwrite(${fd}, "checks=%0d failures=%0d\\n", ${count}, ${failures});`, `  $fclose(${fd});`,
    `  $display("RTL_SELFTEST_COMPLETE checks=%0d failures=%0d", ${count}, ${failures});`, '  $finish;', 'end', 'endmodule', '');
  return { top, source: lines.join('\n'), ...(observation?{observation}:{}) };
}

export function negativeControlRtl(plan, expected) {
  if(plan.transaction)return negativeTransactionRtl(plan,expected);
  const step=plan.steps.find(s=>Object.keys(s.expect).length),first=Object.entries(step.expect)[0],target=expected.ports.find(p=>p.name===first[0]);
  const care=step.masks?.[first[0]],bits=care?BigInt('0x'+care.split("'h")[1]):1n,flip=bits&-bits;
  if(!flip)throw new Error('Negative control requires a cared-about output bit');
  const wrong = bitLiteral(String(BigInt('0x' + first[1].split("'h")[1]) ^ flip), target.width);
  return `module ${expected.top}(${expected.ports.map(p => `${p.direction} wire [${p.width - 1}:0] ${p.name}`).join(', ')});\n`
    + expected.ports.filter(p => p.direction === 'output').map(p => `assign ${p.name} = ${p.name === target.name ? wrong : `${p.width}'h0`};`).join('\n') + '\nendmodule\n';
}

const PLAN_RULES = `You author a bounded functional check from an immutable RTL specification, before any DUT implementation exists. No official reference implementation or testbench is available. Return JSON only, not RTL or a testbench.
Schema: {"schema_version":1,"status":"ready","constraints":[{"id":"C1","quote":"exact substring of the supplied specification","claim":"precise required behavior"}],"steps":[{"drive":{"input_name":"integer bit value"},"expect":{"output_name":"integer bit value"},"because":["C1"]}]}.
Use 1..24 constraints and 2..96 steps. Aim for 6..24 meaningful comparisons, including boundaries, asymmetric values, reset/enable priority and cycle transitions when specified. All values are strings: decimal, 0x hex, or correctly sized Verilog literals. No expressions, X/Z, arrays or generated code. Drive only supplied inputs, compare only supplied outputs. Check each output at least once and perform at least three comparisons across at least two input states.
Every step assigns its drive values simultaneously, waits 2 ns, then performs its expect comparisons; omitted inputs retain their previous values. The first step must drive EVERY input. Clocks are explicit inputs: every high/low edge must be written as a step. Empty expect objects are allowed on setup edges. No automatic clocks, cycles or repetition exist. Set reset/data/enable before an active edge. Do not assume initial register values or unspecified reset behavior. Compare only after values are defined by the specification. Use original port bit ordering and exact latency. Do not add requirements absent from the quoted specification.
If the specification/interface cannot be checked honestly by this schema, return {"schema_version":1,"status":"unsupported","reason":"specific limitation"}. Do not invent unknown behavior or assert arbitrary initial values.`;

async function roleCall({ role, config, prompt, systemPrompt, directory, generate, signal, timeoutMs, onRecord }) {
  const start = Date.now(), bounded = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, bounded]) : bounded;
  const model = { ...config.model, maxTokens: Math.min(config.model.maxTokens, config.agent.selfCheck.maxTokens), requestTimeoutMs: timeoutMs };
  if (model.reasoning && model.reasoningBudget >= 0) model.reasoningBudget = Math.min(model.reasoningBudget, model.maxTokens - 1);
  onRecord({ tool: 'role_start', role, max_tokens: model.maxTokens, timeout_ms: timeoutMs });
  let response;
  try {
    response = await generate({ model, prompt, systemPrompt, signal: combined });
    combined.throwIfAborted();
    await writeFile(path.join(directory, role + '-response.json'), JSON.stringify({ text: response.text, usage: response.usage, timing: response.timing, stopReason: response.stopReason, requestParameters: response.requestParameters }, null, 2));
    onRecord({ tool: 'role_response', role, sha256: sha(response.text), text: response.text.slice(0, 65536), truncated_for_audit: response.text.length > 65536 });
    const parsed = parseRoleJson(response.text);
    onRecord({ tool: 'role', role, rc: 0, sec: (Date.now() - start) / 1000, usage: response.usage, timing: response.timing, finish: response.stopReason });
    return parsed;
  } catch (error) {
    onRecord({ tool: 'role', role, rc: 1, sec: (Date.now() - start) / 1000, code: error.code ?? 'ROLE_RESPONSE_UNUSABLE', usage: response?.usage ?? error.usage, finish: response?.stopReason ?? error.stopReason });
    throw error;
  }
}

export async function prepareSelfCheck({ task, expected, config, workspace, generate = generateRtl, check, signal, onRecord = () => {}, planProvider }) {
  const directory = path.join(workspace, 'self-check'); await mkdir(directory);
  const setting = config.agent.selfCheck;
  try {
    if (!expected.ports.length || expected.unresolved?.length || expected.ports.some(p => !Number.isSafeInteger(p.width) || p.direction === 'inout')) throw new Error('Resolved ports are unavailable');
    if(planProvider&&!expected.ports.some(p=>p.direction==='output'))throw new Error('No declared observable output; preserve the original interface instead of guessing a correction');
    let compiled = setting.templateFastPath || setting.mode === 'templates' ? compileVectorPlan({ spec: task.spec, expected }) : null;
    if(compiled&&planProvider)try{validateVectorPlan(compiled.plan,{spec:task.spec,expected});}catch(error){onRecord({tool:'self_test_template_rejected',reason:String(error.message).slice(0,200)});compiled=null;}
    if (!compiled && setting.mode === 'templates' && !planProvider) {
      onRecord({ tool: 'self_test_unavailable', rc: 1, reason: 'No supported specification template; preserve the original compile/synthesis flow without a model planner call' });
      return null;
    }
    if (compiled) onRecord({ tool: 'self_test_template', rc: 0, family: compiled.family, version: compiled.version, source: 'original_specification_only' });
    const raw = compiled?.plan ?? (planProvider?await planProvider({task,expected,signal}):await roleCall({ role: 'check_author', config, generate, signal, timeoutMs: setting.timeoutMs, directory, onRecord,
      systemPrompt: PLAN_RULES, prompt: `ORIGINAL SPECIFICATION:\n${task.spec}\n\nSUPPLIED INTERFACE:\n${JSON.stringify(expected.ports)}` }));
    await writeFile(path.join(directory,'source-plan.json'),JSON.stringify(raw,null,2),{flag:'wx'});
    const plan = !compiled&&planProvider?compileScenarioPlan(raw,{spec:task.spec,expected}):validateVectorPlan(raw, { spec: task.spec, expected });
    if (!['ready','advisory_only'].includes(plan.status)) { onRecord({ tool: 'self_test_unavailable', rc: 1, reason: plan.reason }); return null; }
    const bench = renderVectorTestbench(plan, expected,{trace:config.dual?.harness?.trace===true,clockPort:plan.clock?.port??task.clockPort??null}), benchPath = path.join(directory, 'checker.sv'), planPath = path.join(directory, 'plan.json');
    await writeFile(benchPath, bench.source, { flag: 'wx' }); await chmod(benchPath, 0o444);
    await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }); await chmod(planPath, 0o444);
    if(plan.status==='advisory_only'){
      const policy=plan.coverage.table_safety;
      onRecord({tool:'self_test_advisory',rc:0,...policy,available:false,attached:false,plan_path:planPath,bench_path:benchPath,plan_sha256:sha(JSON.stringify(plan)),bench_sha256:sha(bench.source),uncovered:plan.coverage.uncovered});
      onRecord({tool:'self_test_unavailable',rc:1,code:'TEST_TABLE_ADVISORY_ONLY',reason:policy.reason});
      // Return no prepared task: no checker/constraints can reach validation,
      // diagnosis/repair, or candidate selection. Artifacts are reference only.
      return null;
    }
    const prepared = { ...task, stages: ['compile', 'simulate', 'synthesize'], behaviorConstraints: plan.constraints,
      testbench: { path: benchPath, top: bench.top, resultFile: 'selftest_result.txt', expectedChecks: plan.expectedChecks, origin: 'self_generated_spec_vectors',coverage:plan.coverage??{kind:'partial',semantic_correctness:'unproven'},...(plan.assurance?{assurance:plan.assurance}:{}),...(bench.observation?{observation:bench.observation,observerBenchSha256:sha(bench.source)}:{}) } };
    if(plan.handwritten_table)prepared.testbench.handwritten_table=structuredClone(plan.handwritten_table);
    if(compiled)prepared.testbench.generator={kind:'specification_template',family:compiled.family};
    const negativePath = path.join(directory, 'negative-control.sv'), probeTaskPath = path.join(directory, 'negative-task.json');
    const probeTask = { ...prepared, stages: ['compile', 'simulate'] };
    await writeFile(negativePath, negativeControlRtl(plan, expected)); await writeFile(probeTaskPath, JSON.stringify(probeTask));
    const validation = await check({ rtlPath: negativePath, task: probeTask, taskPath: probeTaskPath, config: config.vivado, workDir: path.join(directory, 'negative-check'), signal });
    const killed = validation.stages.some(s => s.name === 'compile' && s.status === 'pass') && validation.stages.some(s => s.name === 'simulate' && s.status === 'fail' && (!planProvider || s.completed===true && s.checks===plan.expectedChecks && s.failures>0));
    await writeFile(path.join(directory, 'negative-control-result.json'), JSON.stringify(validation, null, 2));
    onRecord({ tool: 'self_test_negative_control', rc: killed ? 0 : 1, stages: validation.stages.map(s => ({ name: s.name, status: s.status, sec: s.durationMs / 1000 })) });
    if (!killed) throw new Error('The checker did not reject the deliberately wrong control');
    onRecord({ tool: 'self_test_plan', rc: 0, origin: 'self_generated_spec_vectors', plan_origin: compiled ? 'specification_template' : planProvider?'auxiliary_scenarios':'model_specification_vectors', official_functional_verified: false, plan_sha256: sha(JSON.stringify(plan)), bench_sha256: sha(bench.source), plan });
    return { task: prepared, plan, benchSha256: sha(bench.source), directory };
  } catch (error) {
    signal?.throwIfAborted();
    onRecord({ tool: 'self_test_unavailable', rc: 1, code:error.code??'TEST_PREPARATION_INVALID', reason: ['MODEL_TRUNCATED', 'MODEL_TIMEOUT'].includes(error.code) ? error.code : 'Plan or checker validation failed', detail: error instanceof SyntaxError ? 'Invalid JSON' : String(error.message).slice(0, 300) });
    return null;
  }
}

export function failureHistory(plan, feedback, {maxChars=12000}={}) {
  const match = /RTL_SELFTEST_FAIL\s+step=(\d+)\b/.exec(feedback ?? '');
  const index = match ? Number(match[1]) : -1;
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(plan?.steps) || index >= plan.steps.length) return null;
  let inputs = {};
  const rows = [];
  for (let i = 0; i <= index; i++) {
    const step = plan.steps[i];
    if (!object(step?.drive) || !object(step.expect)) return null;
    inputs = { ...inputs, ...step.drive };
    // Keep initialization and the recent edge history, with all held inputs
    // materialized. Expected outputs remain hypotheses from the frozen plan.
    if (i < 2 || i >= index - 11) rows.push({ step: i, inputs: { ...inputs }, expect: step.expect, ...(step.masks?{masks:step.masks}:{}), because: step.because,
      position: i === index ? 'first_reported_mismatch' : 'before_first_reported_mismatch' });
  }
  const result = { source: 'frozen_specification_vectors_only', first_mismatch_step: index,
    omitted_middle_steps: Math.max(0, index + 1 - rows.length), step_semantics: 'Drive simultaneously, wait 2 ns, then compare. Omitted inputs hold their previous values. Expected values are fallible hypotheses; no official oracle is present.', rows };
  while(JSON.stringify(result).length>maxChars&&result.rows.length>3){result.rows.splice(2,1);result.omitted_middle_steps++;}
  return JSON.stringify(result).length <= maxChars ? result : null;
}

export function createFailureReviewer({ config, directory, generate = generateRtl, onRecord = () => {} }) {
  let calls = 0;
  return async ({ task, code, validation, signal, remainingMs }) => {
    if (remainingMs < 90000 || !validation.stages.some(s => s.name === 'simulate' && s.status === 'fail')) return '';
    const role = 'failure_locator_' + calls++;
    try {
      let history = null;
      try { history = failureHistory(JSON.parse(await readFile(path.join(directory, 'plan.json'), 'utf8')), validation.feedback); } catch { /* Tool feedback remains available if no bounded vector history can be read. */ }
      onRecord({ tool: 'failure_history', available: Boolean(history), first_mismatch_step: history?.first_mismatch_step, rows: history?.rows.length });
      const result = await roleCall({ role, config, directory, generate, signal, timeoutMs: Math.min(90000, Math.floor(remainingMs * .2)), onRecord,
        systemPrompt: 'You locate an RTL failure against an immutable specification. The self-check is a fallible hypothesis, not an official oracle. Return JSON only: {"kind":"rtl" or "checker_uncertain","constraint_ids":["C1"],"suspect_lines":[1],"explanation":"specific causal explanation and minimal repair"}. Do not rewrite the DUT, change tests, invent evidence, or treat a majority vote as proof. Identify the earliest actual mismatch and trace the supplied input history, old-state timing, output persistence and reset behavior against the exact specification. Your proposed change must causally explain that mismatch. If the expected value contradicts the specification or cannot be justified, return checker_uncertain instead of changing the RTL to fit it.',
        prompt: `ORIGINAL SPECIFICATION:\n${task.spec}\n\nSPECIFICATION CONSTRAINTS:\n${JSON.stringify(task.behaviorConstraints ?? [])}\n\nCURRENT RTL WITH LINE NUMBERS:\n${code.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n')}\n\nFROZEN INPUT HISTORY THROUGH FIRST MISMATCH:\n${history ? JSON.stringify(history) : 'Unavailable; do not infer unobserved earlier input states.'}\n\nACTUAL TOOL DIAGNOSTICS:\n${validation.feedback.slice(0, 8000)}` });
      const ids = new Set((task.behaviorConstraints ?? []).map(c => c.id));
      if (!object(result) || !['rtl', 'checker_uncertain'].includes(result.kind) || !Array.isArray(result.constraint_ids) || result.constraint_ids.some(id => !ids.has(id)) || !Array.isArray(result.suspect_lines) || result.suspect_lines.length > 20 || result.suspect_lines.some(n => !Number.isSafeInteger(n) || n < 1 || n > code.split('\n').length) || typeof result.explanation !== 'string' || result.explanation.length > 3000) throw new Error('Invalid failure diagnosis');
      onRecord({ tool: 'failure_diagnosis', rc: 0, ...result });
      return { feedback: `INDEPENDENT-CONTEXT DIAGNOSIS (advisory; original specification overrides it; the checker remains frozen):\n${JSON.stringify(result)}`, modelCalls: 1, stopRepair: result.kind === 'checker_uncertain' };
    } catch {
      signal?.throwIfAborted();
      onRecord({ tool: 'failure_diagnosis', rc: 1, reason: 'Unavailable diagnosis; retain actual tool evidence' }); return { feedback: '', modelCalls: 1 };
    }
  };
}

export async function assertCheckerUnchanged(file, expectedSha256) {
  if (sha(await readFile(file)) !== expectedSha256) throw new Error('The frozen self-check changed during a request');
}
