import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runProcess } from './vivado.mjs';

const HELPER = fileURLToPath(new URL('./rag-query.py', import.meta.url));
export const RAG_POLICY = 'repair-hybrid-v1';
export function normalizeRag(raw, base = process.cwd()) {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('agent.rag must be an object');
  const value = { mode: 'off', python: 'python3', root: '', manifestSha256: '', endpoint: 'http://127.0.0.1:18085', timeoutMs: 5000,
    minRemainingMs: 60000, maxChars: 2800, maxDocuments: 2, minCosine: .5, ...raw };
  if (!['off', 'repair'].includes(value.mode)) throw new Error('agent.rag.mode must be off or repair');
  if (typeof value.python !== 'string' || !value.python.trim() || /[\r\n\0]/.test(value.python)) throw new Error('agent.rag.python must name an executable');
  if (value.python.includes(path.sep)) value.python = path.resolve(base, value.python);
  if (typeof value.root !== 'string' || /[\r\n\0]/.test(value.root)) throw new Error('agent.rag.root must be a local bundle directory');
  if (value.root) value.root = path.resolve(base, value.root);
  if (value.mode !== 'off' && (!value.root || !/^[a-f0-9]{64}$/.test(value.manifestSha256))) throw new Error('Enabled agent.rag requires root and manifestSha256');
  const url = new URL(value.endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('agent.rag.endpoint must be a numeric loopback HTTP origin');
  value.endpoint = url.origin;
  for (const [key, min, max] of [['timeoutMs', 100, 10000], ['minRemainingMs', 1000, 300000], ['maxChars', 600, 6000], ['maxDocuments', 1, 3]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`Invalid agent.rag.${key}`);
  }
  if (!Number.isFinite(value.minCosine) || value.minCosine < 0 || value.minCosine > 1) throw new Error('Invalid agent.rag.minCosine');
  return value;
}

// Never pass task paths, generated RTL, testbenches or judge output to retrieval.
export function repairQuery(task, feedback) {
  return `SystemVerilog RTL repair. Diagnostics: ${feedback.slice(0, 1600)}\nSpecification: ${task.spec.slice(0, 1000)}`;
}

export async function retrieveRepair({ options, query, exclude = [], workDir, signal, executor = runProcess }) {
  const started = Date.now(), config = normalizeRag(options);
  const fallback = reason => ({ decision: 'fallback', reason, policy: RAG_POLICY, durationMs: Date.now() - started, text: '', documents: [] });
  if (config.mode === 'off') return { ...fallback('disabled'), decision: 'off' };
  if (signal?.aborted) signal.throwIfAborted();
  try {
    const run = await executor(config.python, ['-B', HELPER, '--root', config.root, '--manifest-sha256', config.manifestSha256,
      '--endpoint', config.endpoint, '--query', query, '--exclude', JSON.stringify(exclude), '--limit', String(config.maxDocuments),
      '--min-cosine', String(config.minCosine), '--max-chars', String(config.maxChars)], { cwd: workDir, timeoutMs: config.timeoutMs, signal });
    if (signal?.aborted) signal.throwIfAborted();
    if (run.cancelled || run.timedOut || run.spawnError || run.exitCode !== 0) return fallback(run.timedOut ? 'timeout' : 'helper_unavailable');
    const result = JSON.parse(run.text);
    if (result.policy !== RAG_POLICY || !['hit', 'abstain'].includes(result.decision) || !Array.isArray(result.documents)
        || result.documents.length > config.maxDocuments || typeof result.text !== 'string' || result.text.length > config.maxChars
        || result.manifestSha256 !== config.manifestSha256 || (result.decision === 'hit') !== Boolean(result.documents.length && result.text)) return fallback('invalid_result');
    for (const doc of result.documents) {
      if (typeof doc.id !== 'string' || typeof doc.document_id !== 'string' || !/^[a-f0-9]{64}$/.test(doc.sha256)
          || !Number.isFinite(doc.cosine) || doc.cosine < config.minCosine || !['amd-official', 'project-authored'].includes(doc.origin)) return fallback('invalid_document');
    }
    return { ...result, durationMs: Date.now() - started, querySha256: createHash('sha256').update(query).digest('hex') };
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    return fallback('helper_unavailable');
  }
}
