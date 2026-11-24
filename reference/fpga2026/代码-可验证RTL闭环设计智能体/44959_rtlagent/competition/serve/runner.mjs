import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
async function boundedFile(file, limit) {
  try { const info = await stat(file); if (!info.isFile() || info.size > limit) throw new Error('Output is not a bounded regular file'); return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export function processRunner(env = process.env) {
  return async (request, { signal, deadlineAt }) => {
    if (process.platform !== 'linux') throw new Error('The production runner requires Linux');
    let scratch = path.resolve(env.EDA_TMP || '/var/tmp/eda'); await mkdir(scratch, { recursive: true }); scratch = await realpath(scratch);
    const work = await mkdtemp(path.join(scratch, 'rtl-job-')), input = path.join(work, 'input'), output = path.join(work, 'output');
    let child, timer, stop, forced = false;
    try {
      await mkdir(input); await mkdir(output);
      await writeFile(path.join(input, 'prompt.txt'), request.prompt);
      if (request.interface) await writeFile(path.join(input, 'interface.txt'), request.interface);
      const remaining = (deadlineAt - Date.now()) / 1000;
      if (remaining <= 0 || signal.aborted) return { solution: '', trace: JSON.stringify({ ts: Date.now() / 1000, tool: 'deadline', rc: 1 }) + '\n' };
      child = spawn(env.PYTHON_BIN || 'python3', [path.join(ROOT, 'serve/process_runner.py'), '--timeout', String(remaining), '--grace', '2', '--cwd', ROOT, '--',
        '/bin/bash', path.join(ROOT, request.mode === 'agent' ? 'run.sh' : 'run_baseline.sh'), input, output],
      { cwd: work, env: { ...env, TRACK: 'rtl', AGENT_DEADLINE_S: String(remaining) }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
      let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
      stop = () => { try { child.kill('SIGTERM'); } catch {} };
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      // The Python supervisor reaps descendants across new process sessions.
      // This guard is only for a broken supervisor, after its normal cleanup window.
      timer = setTimeout(() => { forced = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, Math.max(1, remaining * 1000 + 7000));
      const rc = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      let solution = await boundedFile(path.join(output, 'solution.v'), 2 * 1024 * 1024), trace = await boundedFile(path.join(output, 'trace.jsonl'), 4 * 1024 * 1024);
      if (rc !== 0 || !trace.trim()) trace += JSON.stringify({ ts: Date.now() / 1000, tool: 'process', rc, excerpt: rc === 0 ? 'No trace produced' : 'Request process stopped or failed' }) + '\n';
      // A timed-out request may still have a complete, atomically saved candidate.
      if (rc === 125 || forced) { const error = new Error('Descendant cleanup could not be confirmed'); error.fatal = true; throw error; }
      return { solution, trace };
    } finally {
      clearTimeout(timer); if (stop) signal.removeEventListener('abort', stop);
      const relative = path.relative(scratch, work);
      if (!relative.startsWith('rtl-job-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected job workspace');
      await rm(work, { recursive: true, force: true });
    }
  };
}
