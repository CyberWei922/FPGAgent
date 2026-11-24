#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, rm} from 'node:fs/promises';
import {agentRoot, sourceModule, readText, print, argumentsFor, required, cli} from '../../deterministic-cli.mjs';

await cli(async () => {
  const args = argumentsFor({rtl: {type: 'string'}, top: {type: 'string'}, python: {type: 'string'}, 'work-dir': {type: 'string'}});
  if (args.help) return console.log('rtl-lint-rules --rtl dut.sv --top NAME [--python python3] [--work-dir DIR]');
  required(args, ['rtl', 'top']);
  const root = await agentRoot(import.meta.url);
  const {runRtlLint, RTL_LINT_RULES} = await sourceModule(root, 'rtl-agent/src/rtl-lint.mjs');
  const {runProcess} = await sourceModule(root, 'rtl-agent/src/vivado.mjs');
  const temporary = !args['work-dir'];
  const workDir = temporary ? await mkdtemp(path.join(os.tmpdir(), 'deterministic-lint-')) : path.resolve(args['work-dir']);
  try {
    let missingInterpreter = false;
    const result = await runRtlLint({rtl: await readText(args.rtl), top: args.top, workDir,
      options: {mode: 'slang', python: args.python ?? process.env.SLANG_PYTHON ?? 'python3', maxFindings: 16},
      executor: async (...parameters) => {
        const run = await runProcess(...parameters);
        missingInterpreter = /\bENOENT\b/.test(run.spawnError ?? '');
        return run;
      }});
    const {durationMs, ...stable} = result;
    const skipped = result.status === 'unknown' && (['helper_unavailable', 'version_mismatch'].includes(result.reason)
      || (result.reason === 'helper_process_error' && missingInterpreter));
    print({...stable, ...(skipped ? {status: 'skipped', installation: 'Run python3 -B competition/environment/install-slang.py --wheel-dir competition/vendor/pyslang/wheels --target competition/vendor/pyslang/site-packages from the package root (Dockerfile command; Linux pinned wheels). On other platforms use a Python environment with pyslang==12.0.0 and pass --python.'} : {}), rules: RTL_LINT_RULES});
    process.exitCode = skipped || result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
  } finally { if (temporary) await rm(workDir, {recursive: true, force: true}); }
});
