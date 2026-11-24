import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const [base, promptFile, deadline = '900'] = process.argv.slice(2);
if (!base || !promptFile || !process.env.FPGACHINA_TOKEN) throw new Error('Usage: FPGACHINA_TOKEN=... node public-smoke.mjs <https://rc-...> <prompt.txt> [deadline_s]');
const origin = new URL(base);
if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('Use the public HTTPS rc-tunnel address');
const headers = { Authorization: 'Bearer ' + process.env.FPGACHINA_TOKEN, 'Content-Type': 'application/json' };
async function request(route, body) {
  const response = await fetch(new URL(route, origin), { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} on ${route}`);
  return await response.json();
}
const health = await request('/v1/health');
if (!health.ready || health.track !== 'rtl' || !Number.isFinite(health.vram_gb)) throw new Error('Service is not ready for RTL');
console.log(JSON.stringify(health));
const prompt = await readFile(promptFile, 'utf8');
for (const mode of ['agent', 'baseline']) {
  const started = Date.now(), job = await request('/v1/solve', { task_id: 'public-smoke-' + mode, nonce: randomUUID(), mode, prompt, interface: '', deadline_s: Number(deadline) });
  if (!job.job_id || job.status !== 'queued') throw new Error('Invalid asynchronous submission response');
  let result;
  while (Date.now() - started < (Number(deadline) + 20) * 1000) {
    result = await request('/v1/jobs/' + job.job_id); if (result.status === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (result?.status !== 'done' || typeof result.solution !== 'string' || typeof result.trace !== 'string') throw new Error('Missing or malformed done response');
  for (const line of result.trace.trim().split('\n').filter(Boolean)) JSON.parse(line);
  console.log(JSON.stringify({ mode, status: result.status, solution_bytes: Buffer.byteLength(result.solution), wall_s: (Date.now() - started) / 1000 }));
}
