import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { atomicWrite } from '../agent/main.mjs';
import { readiness } from './readiness.mjs';
import { processRunner } from './runner.mjs';

const errorTrace = message => JSON.stringify({ ts: Date.now() / 1000, tool: 'service', rc: 1, excerpt: message }) + '\n';
const publicJob = job => ({ job_id: job.id, task_id: job.request.task_id, status: job.status });
function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  for (const name of ['task_id', 'nonce', 'mode', 'prompt', 'interface']) if (typeof value[name] !== 'string') throw new Error(`${name} must be a string`);
  if (!value.task_id.trim() || value.task_id.length > 200 || !value.nonce.trim() || value.nonce.length > 300) throw new Error('task_id and nonce must be nonempty and bounded');
  if (!['agent', 'baseline'].includes(value.mode)) throw new Error('mode must be agent or baseline');
  if (!value.prompt.trim() || Buffer.byteLength(value.prompt) > 1024 * 1024 || Buffer.byteLength(value.interface) > 65536) throw new Error('Invalid prompt/interface size');
  if (!Number.isFinite(value.deadline_s) || value.deadline_s < 1 || value.deadline_s > 86400) throw new Error('deadline_s must be between 1 and 86400');
  return Object.fromEntries(['task_id', 'nonce', 'mode', 'prompt', 'interface', 'deadline_s'].map(key => [key, value[key]]));
}
async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1500 * 1024) throw new Error('Request body too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Tests inject an in-process runner. Production has no mock/environment bypass.
export async function createSubmissionServer({ token, stateDir, runner, checkReady, maxJobs = 2000, retentionMs = 24 * 3600_000, reserveMs = 10_000, onFatal = () => {} }) {
  if (typeof token !== 'string' || token.length < 8 || /[\r\n]/.test(token)) throw new Error('A nonempty FPGACHINA_TOKEN of at least 8 characters is required');
  stateDir = path.resolve(stateDir); await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const expectedAuth = Buffer.from('Bearer ' + token), jobs = new Map(), nonces = new Map(), queue = [];
  let active, working = false, closing = false, worker = Promise.resolve(), admission = Promise.resolve();
  const file = job => path.join(stateDir, job.id + '.json');
  const finish = async (job, result) => {
    if (job.status === 'done') return;
    if (job.finishing) return await job.finishing;
    clearTimeout(job.expiry);
    job.finishing = (async () => {
    const value = { job_id: job.id, task_id: job.request.task_id, status: 'done',
      solution: typeof result.solution === 'string' ? result.solution : '', trace: typeof result.trace === 'string' ? result.trace : errorTrace('Invalid runner result'),
      elapsed_s: (Date.now() - job.started) / 1000 };
    if (Buffer.byteLength(value.solution) > 2 * 1024 * 1024 || Buffer.byteLength(value.trace) > 4 * 1024 * 1024) {
      value.solution = ''; value.trace = errorTrace('Runner output exceeds the response size limit');
    }
    await atomicWrite(file(job), JSON.stringify(value));
    job.status = 'done'; job.finished = Date.now();
    // Keep only small metadata in memory. Completed code/traces live on local disk.
    job.request = { task_id: job.request.task_id, nonce: job.request.nonce };
    })();
    await job.finishing;
  };
  const prune = async () => {
    for (const [id, job] of jobs) {
      if (job.status !== 'done' || (jobs.size < maxJobs && Date.now() - job.finished < retentionMs)) continue;
      await rm(file(job), { force: true }); jobs.delete(id); nonces.delete(job.request.nonce);
    }
  };
  const drain = async () => {
    if (working) return; working = true;
    try {
      while (queue.length && !closing) {
        const job = queue.shift(); if (job.status !== 'queued' || job.finishing) continue;
        if (Date.now() >= job.stopAt) { await finish(job, { trace: errorTrace('Budget expired while queued') }); continue; }
        clearTimeout(job.expiry); job.status = 'running'; job.controller = new AbortController(); active = job;
        const timer = setTimeout(() => job.controller.abort(new Error('Request deadline reached')), Math.max(1, job.stopAt - Date.now()));
        try { await finish(job, await runner(job.request, { signal: job.controller.signal, deadlineAt: job.stopAt, jobId: job.id })); }
        catch (error) {
          await finish(job, { trace: errorTrace('Request runner failed; inspect private service logs') });
          if (error.fatal) {
            closing = true;
            for (const queued of queue) if (queued.status === 'queued') await finish(queued, { trace: errorTrace('Service cannot confirm process cleanup; further work stopped') });
            // Production exits here so api-supervisor starts a fresh server;
            // staying up but refusing every later task would score them all L0.
            onFatal(error);
          }
        }
        finally { clearTimeout(timer); active = undefined; }
      }
    } finally { working = false; }
  };
  const server = http.createServer(async (request, response) => {
    try {
      const authorization = Buffer.from(request.headers.authorization || '');
      if (authorization.length !== expectedAuth.length || !timingSafeEqual(authorization, expectedAuth)) return send(response, 401, { detail: 'Unauthorized' });
      if (request.method === 'GET' && request.url === '/v1/health') {
        const state = await checkReady();
        return send(response, 200, closing ? { ...state, ready: false, reason: 'Service is stopping or process cleanup needs inspection' } : state);
      }
      if (request.method === 'GET' && /^\/v1\/jobs\/[a-f0-9-]{36}$/.test(request.url)) {
        const job = jobs.get(request.url.slice('/v1/jobs/'.length));
        if (!job) return send(response, 404, { detail: 'Unknown or expired job' });
        return send(response, 200, job.status === 'done' ? JSON.parse(await readFile(file(job), 'utf8')) : publicJob(job));
      }
      if (request.method === 'POST' && request.url === '/v1/solve') {
        let value; try { value = validate(await body(request)); } catch (error) { return send(response, 400, { detail: error.message }); }
        // Admission is serialized separately from solving so simultaneous nonce
        // replays cannot create two jobs across asynchronous disk pruning.
        const accept = async () => {
        const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex'), duplicate = jobs.get(nonces.get(value.nonce));
        if (duplicate) return duplicate.hash === hash ? send(response, 202, { ...publicJob(duplicate), status: 'queued' }) : send(response, 409, { detail: 'nonce was already used for a different request' });
        if (closing) return send(response, 503, { detail: 'Service is stopping' });
        await prune(); if (jobs.size >= maxJobs || queue.length >= 32) return send(response, 503, { detail: 'Job capacity reached' });
        const started = Date.now(), job = { id: randomUUID(), request: value, hash, started, status: 'queued', stopAt: started + Math.max(1, value.deadline_s * 1000 - reserveMs) };
        jobs.set(job.id, job); nonces.set(value.nonce, job.id); queue.push(job);
        job.expiry = setTimeout(() => { if (job.status === 'queued') finish(job, { trace: errorTrace('Budget expired while queued') }).catch(() => {}); }, Math.max(1, job.stopAt - Date.now()));
        send(response, 202, publicJob(job));
        worker = worker.then(drain).catch(error => { process.stderr.write('Queue failure: ' + error.message + '\n'); });
        return;
        };
        const accepted = admission.then(accept); admission = accepted.catch(() => {}); await accepted; return;
      }
      send(response, 404, { detail: 'Unknown endpoint' });
    } catch { if (!response.headersSent) send(response, 500, { detail: 'Internal service error' }); else response.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 3000;
  return { server, async close() {
    closing = true; active?.controller.abort(new Error('Service stopping'));
    await admission;
    for (const job of queue) if (job.status === 'queued') await finish(job, { trace: errorTrace('Service stopping') });
    await worker;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  } };
}

export async function main(env = process.env) {
  // Finish slow offline tool/version inspection before opening the HTTP port.
  // Once exposed, health/solve/jobs must answer within a few seconds.
  const checkReady = readiness(env), initial = await checkReady();
  if (!initial.ready) throw new Error('Runtime is not ready: ' + initial.reason);
  const service = await createSubmissionServer({ token: env.FPGACHINA_TOKEN, stateDir: path.join(env.SERVICE_STATE_DIR || '/var/tmp/rtl-agent-service', 'jobs'),
    runner: processRunner(env), checkReady,
    onFatal: () => {
      process.stderr.write('Process cleanup could not be confirmed; exiting so api-supervisor restarts a fresh server\n');
      setTimeout(() => process.exit(70), 2000);
    } });
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(7860, '127.0.0.1', resolve); });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
