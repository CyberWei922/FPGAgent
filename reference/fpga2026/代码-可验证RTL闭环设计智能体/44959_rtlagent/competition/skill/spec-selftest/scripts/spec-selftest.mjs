#!/usr/bin/env node
import path from 'node:path';
import {mkdir, writeFile, access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {agentRoot, sourceModule, readText, readJson, print, argumentsFor, required, cli, interfaceFor} from '../../deterministic-cli.mjs';

await cli(async () => {
  const args = argumentsFor({spec: {type: 'string'}, interface: {type: 'string'}, top: {type: 'string'},
    params: {type: 'string'}, out: {type: 'string'}, 'list-methods': {type: 'boolean'},
    expressions: {type: 'boolean'}, run: {type: 'boolean'}, rtl: {type: 'string'}, 'vivado-bin': {type: 'string'}});
  if (args.help) return console.log('spec-selftest --spec prompt.txt [--interface interface.sv] [--top NAME] --params method.json --out NEW_DIR [--expressions] [--run --rtl dut.sv --vivado-bin DIR]\nspec-selftest --list-methods [--spec prompt.txt --top NAME]');
  const root = await agentRoot(import.meta.url);
  const {METHOD_IDS, METHOD_REGISTRY, eligibleMethods, methodOutputSchema} = await sourceModule(root, 'rtl-agent/src/verification/registry.mjs');
  const spec = args.spec ? await readText(args.spec) : null;
  const expected = spec === null ? null : await interfaceFor(root, args, spec);
  if (args['list-methods']) {
    const eligible = expected ? eligibleMethods({task: {spec}, expected, expressions: !!args.expressions}) : null;
    return print({methods: METHOD_IDS.map(id => ({name: id, description: METHOD_REGISTRY[id].description,
      focus: METHOD_REGISTRY[id].focus, limits: METHOD_REGISTRY[id].limits,
      parameters: methodOutputSchema([id]).anyOf[0].properties.params,
      ...(eligible ? {eligible: eligible.includes(id)} : {})}))});
  }
  required(args, ['spec', 'params', 'out']);
  if (args.run) required(args, ['rtl']);
  // Resolve all input paths before creating output. Refuse an existing directory.
  if (args.rtl) await access(path.resolve(args.rtl), constants.R_OK);
  const raw = await readJson(args.params);
  const {compileTestMethod} = await sourceModule(root, 'rtl-agent/src/verification/methods.mjs');
  let compiled;
  try { compiled = compileTestMethod(raw, {task: {spec}, expected, expressions: !!args.expressions}); }
  catch (error) {
    print({status: 'rejected', code: error.code ?? null, message: error.message});
    process.exitCode = 1;
    return;
  }
  if (compiled.value.status === 'unsupported') {
    print({status: 'unsupported', reason: compiled.value.reason});
    process.exitCode = 1;
    return;
  }
  const {compileScenarioPlan} = await sourceModule(root, 'rtl-agent/src/verification/plan.mjs');
  const {renderVectorTestbench, negativeControlRtl} = await sourceModule(root, 'rtl-agent/src/self-check.mjs');
  const plan = compileScenarioPlan(compiled.value, {spec, expected});
  const bench = renderVectorTestbench(plan, expected);
  const negative = negativeControlRtl(plan, expected);
  const out = path.resolve(args.out);
  await mkdir(path.dirname(out), {recursive: true});
  await mkdir(out);
  for (const [name, content] of Object.entries({'tb.sv': bench.source, 'negative-control.sv': negative,
    'plan.json': JSON.stringify(compiled.value, null, 2) + '\n',
    'calculations.json': JSON.stringify(compiled.calculations, null, 2) + '\n'})) await writeFile(path.join(out, name), content);
  const result = {status: 'ready', method: raw.method, coverage: compiled.coverage,
    ...(compiled.value.transaction ? {transaction: compiled.value.transaction} : {scenarios: compiled.value.scenarios}),
    expectedChecks: plan.expectedChecks, files: ['tb.sv', 'negative-control.sv', 'plan.json', 'calculations.json']};
  if (args.run) {
    const {inspectVivado, checkRtl} = await sourceModule(root, 'rtl-agent/src/vivado.mjs');
    let binDir = args['vivado-bin'] ?? process.env.VIVADO_BIN;
    if (!binDir) for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      try { await access(path.join(directory, 'vivado'), constants.X_OK); binDir = directory; break; } catch { /* Continue. */ }
    }
    if (!binDir) result.run = {status: 'skipped', reason: 'Vivado unavailable. Set --vivado-bin or VIVADO_BIN to the Vivado 2026.1 bin directory.'};
    else {
      const config = {binDir, expectedVersion: '2026.1', maxThreads: 2};
      const installed = await inspectVivado(config);
      if (!installed.ok) result.run = {status: 'skipped', reason: 'Vivado 2026.1 toolchain unavailable', diagnostics: installed.diagnostics};
      else {
        const task = {top: expected.top, stages: ['compile', 'simulate'], testbench: {
          path: path.join(out, 'tb.sv'), top: bench.top, resultFile: 'selftest_result.txt',
          expectedChecks: plan.expectedChecks, origin: 'self_generated_spec_vectors'}};
        const dut = await checkRtl({rtlPath: path.resolve(args.rtl), task, config, workDir: path.join(out, 'dut-run')});
        const control = await checkRtl({rtlPath: path.join(out, 'negative-control.sv'), task, config, workDir: path.join(out, 'control-run')});
        const simulation = control.stages.find(stage => stage.name === 'simulate');
        const detected = simulation?.status === 'fail' && simulation.completed === true && simulation.failures > 0;
        const passed = dut.passed && detected;
        result.run = {status: passed ? 'pass' : 'fail', dut_passed: dut.passed, negative_control_detected: detected, dut, control};
        if (!passed) process.exitCode = 1;
      }
    }
  }
  print(result);
});
