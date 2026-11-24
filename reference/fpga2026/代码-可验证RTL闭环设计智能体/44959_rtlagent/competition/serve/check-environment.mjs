import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';

const exec = promisify(execFile), ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function inspectEnvironment(env = process.env, { scope = 'runtime' } = {}) {
  let output;
  const options = { env: { ...env, NODE_BIN: process.execPath }, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true };
  const args = ['-B', path.join(ROOT, 'environment/inspect_environment.py'), '--backend', env.SERVING_BACKEND || 'llama.cpp', '--scope', scope];
  if (env.RTL_ENVIRONMENT_PROFILE) args.push('--profile', path.resolve(env.RTL_ENVIRONMENT_PROFILE));
  try { output = (await exec(env.PYTHON_BIN || 'python3', args, options)).stdout; }
  catch (error) {
    if (!error.stdout) throw new Error('Cannot inspect the Python/GPU environment; set PYTHON_BIN to the official Python 3.14 interpreter');
    output = error.stdout;
  }
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('Environment inspection returned invalid JSON'); }
  if (!Array.isArray(result.checks) || typeof result.runtime_matches !== 'boolean') throw new Error('Environment inspection result is incomplete');
  return result;
}
export function requireEnvironment(result) {
  if (!result.runtime_matches) {
    const details = result.checks.filter(item => item.required && !item.match)
      .map(item => `${item.component}: expected ${item.expected}, found ${item.actual ?? 'missing'}`).join('; ');
    throw new Error('Validation version profile mismatch: ' + details);
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), scope = args.includes('--image') ? 'image' : 'runtime';
  if (args.some(value => !['--image'].includes(value))) throw new Error('Usage: check-environment.mjs [--image]');
  const result = await inspectEnvironment(process.env, { scope });
  const output = path.join(process.env.SERVICE_STATE_DIR || '/var/tmp/rtl-agent-service', 'environment.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ profile: result.profile_id, matches: result.runtime_matches, full_image_matches: result.full_image_matches, report: output,
    checks: result.checks.map(({ component, actual, match, required }) => ({ component, actual, match, required })) }, null, 2));
  if (!result.runtime_matches) process.exitCode = 1;
}
