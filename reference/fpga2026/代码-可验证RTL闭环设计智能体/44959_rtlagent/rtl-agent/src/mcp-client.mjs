import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {validateObservationResult} from './harness/observations.mjs';

const SERVER_PATH = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
const CLEANUP_GRACE_MS = 7000;
const infoSchema = z.object({
  available: z.boolean(), ok: z.boolean(), version: z.string().nullable(), expectedVersion: z.string().nullable(),
  versionMatches: z.boolean(), binDir: z.string(), tools: z.record(z.string(), z.string()), diagnostics: z.array(z.string()),
});
const checkSchema = z.object({
  passed: z.boolean(), version: z.string().nullable(), feedback: z.string(), oracleKind: z.enum(['public_testbench', 'self_generated_spec_vectors', 'none']),
  artifactDir: z.string().optional(), artifactIndex: z.string().optional(),
  observation:z.custom(value=>{try{validateObservationResult(value);return true;}catch{return false;}},'Invalid complete observation payload').optional(),
  stages: z.array(z.object({
    name: z.enum(['compile', 'simulate', 'synthesize']), status: z.enum(['pass', 'fail', 'error', 'timeout', 'skipped']),
    diagnostics: z.array(z.string()), logPath: z.string().nullable(), durationMs: z.number().nonnegative(),
    completed: z.boolean().optional(), checks: z.number().int().nonnegative().optional(), failures: z.number().int().nonnegative().optional(),
    counterexample: z.object({
      schema: z.literal('prob154-v1'), firstSample: z.number().int().positive(),
      sampling: z.string(), complete: z.boolean(),
      samples: z.array(z.object({
        sample: z.number().int().positive(), timePs: z.number().int().nonnegative(),
        clk: z.string().regex(/^[01xz]$/i), reset: z.string().regex(/^[01xz]$/i),
        input: z.string().regex(/^[0-9a-fxz]{2}$/i),
        expectedDone: z.string().regex(/^[01xz]$/i), actualDone: z.string().regex(/^[01xz]$/i),
        expectedData: z.string().regex(/^[0-9a-fxz]{6}$/i), actualData: z.string().regex(/^[0-9a-fxz]{6}$/i),
        mismatch: z.boolean(),
      })).min(1).max(9),
    }).optional(),
  }).refine(stage => !stage.completed || Number.isSafeInteger(stage.checks) && stage.checks > 0 && Number.isSafeInteger(stage.failures)
    && stage.failures <= stage.checks && (stage.status !== 'pass' || stage.failures === 0), 'Completed checks need consistent counts')).min(1),
}).refine(value => !value.passed || value.stages.every(stage => stage.status === 'pass'), 'A passing check cannot contain an unsuccessful stage')
  .refine(value=>{
    if(!value.observation)return true;
    if(value.observation.status==='incomplete')return !value.passed;
    return value.stages.some(s=>s.name==='simulate'&&s.completed&&s.checks===value.observation.view.metadata.checks&&s.failures===value.observation.view.metadata.failures);
  },'Observation must match completed simulation counts');

function emit(handler, event) {
  try { Promise.resolve(handler?.(event)).catch(() => {}); } catch { /* Observability cannot change a verdict. */ }
}

async function waitForCleanup(promises) {
  if (!promises.length) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.all(promises).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), CLEANUP_GRACE_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Also exported for protocol-contract tests: malformed/error responses fail
// closed, instead of accidentally treating a truthy string as a passing check.
export function decodeVivadoToolResult(tool, result) {
  if (result?.isError) throw new Error(`${tool}: ${result.structuredContent?.message ?? result.content?.find(item => item.type === 'text')?.text ?? 'MCP tool failed'}`);
  const parsed = (tool === 'vivado_info' ? infoSchema : checkSchema).safeParse(result?.structuredContent);
  if (!parsed.success) throw new Error(`${tool}: invalid MCP structured result`);
  const text = result.content?.find(item => item.type === 'text')?.text;
  let textValue;
  try { textValue = JSON.parse(text); } catch { throw new Error(`${tool}: missing or invalid JSON text result`); }
  if (JSON.stringify(textValue) !== JSON.stringify(result.structuredContent)) throw new Error(`${tool}: inconsistent MCP text and structured results`);
  return parsed.data;
}

export async function connectVivadoMcp({ configPath, config, signal, onEvent, transportSpec, mapArguments = value => value } = {}) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) throw new Error('MCP configPath must be absolute');
  const timeout = config?.mcp?.requestTimeoutMs ?? 600000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error('Invalid mcp.requestTimeoutMs');
  signal?.throwIfAborted();
  const lifetime = new AbortController();
  const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  // Retain only AMD/toolchain environment additions; do not copy model API keys.
  const env = Object.fromEntries(['LM_LICENSE_FILE', 'XILINXD_LICENSE_FILE', 'XILINX_VIVADO', 'XILINX_VITIS', 'LD_LIBRARY_PATH', 'TMP', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH, '--config', configPath], cwd: path.dirname(configPath), stderr: 'pipe', env, ...transportSpec });
  const client = new Client({ name: 'rtl-fixed-flow-agent', version: '0.1.0' });
  const pending = new Map();
  let closePromise, closed = false, broken;
  const markClean = callId => { const item = pending.get(callId); if (item) { item.clean(); pending.delete(callId); } };
  transport.stderr?.on('data', chunk => emit(onEvent, { type: 'mcp_stderr', message: chunk.toString('utf8').slice(0, 4000) }));
  client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
    if (notification.params.logger !== 'rtl-vivado') return;
    const event = notification.params.data;
    if (!event || typeof event !== 'object') return;
    if (event.type === 'mcp_cleanup') { markClean(event.callId); return; }
    const callback = pending.get(event.callId)?.onEvent ?? onEvent;
    const { callId: _callId, ...publicEvent } = event;
    emit(callback, publicEvent);
  });
  client.onclose = () => {
    closed = true;
    if (!closePromise) broken ??= new Error('Vivado MCP connection closed unexpectedly');
  };
  client.onerror = error => {
    broken = new Error(`Vivado MCP protocol error: ${error.message}`);
    lifetime.abort(broken);
    emit(onEvent, { type: 'mcp_error', message: broken.message });
  };

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      lifetime.abort(new Error('Vivado MCP client closing'));
      // SDK cancellation rejects immediately, before Vivado's child-tree cleanup.
      // Wait for our protocol notification, then let the SDK close the transport.
      const cleanup = [...pending.values()].map(item => item.cleaned);
      await waitForCleanup(cleanup);
      await client.close();
      for (const callId of pending.keys()) markClean(callId);
      closed = true;
    })();
    return closePromise;
  }

  const options = requestSignal => ({ signal: requestSignal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false });
  try {
    // Loading the SDK from a shared WSL drive can take longer than a deliberately
    // short per-tool timeout. Initialization has its own bounded startup budget.
    const startup = { ...options(combined), timeout: Math.max(timeout, 15000), maxTotalTimeout: Math.max(timeout, 15000) };
    await client.connect(transport, startup);
    const { tools } = await client.listTools({}, startup);
    const names = tools.map(tool => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(['vivado_check', 'vivado_info'])) throw new Error('Vivado MCP server advertised unexpected tools');
    const metadata = { transport: 'stdio', backend: config?.mcp?.backend || 'fixed', serverPid: transport.pid, server: client.getServerVersion(), tools: names, requestTimeoutMs: timeout,
      ...(transportSpec ? { execution: 'development_external_transport' } : {}) };

    async function call(tool, args, requestSignal, requestEvent) {
      if (broken) throw broken;
      if (closed || closePromise) throw new Error('Vivado MCP client is closed');
      const requestCombined = requestSignal ? AbortSignal.any([combined, requestSignal]) : combined;
      requestCombined.throwIfAborted();
      const callId = randomUUID();
      let clean;
      const cleaned = new Promise(resolve => { clean = resolve; });
      pending.set(callId, { clean, cleaned, onEvent: requestEvent ?? onEvent });
      try {
        const result = await client.callTool({ name: tool, arguments: mapArguments(args), _meta: { rtlAgentCallId: callId } }, undefined, options(requestCombined));
        markClean(callId); // A full response also guarantees the handler finished.
        if (broken) throw broken;
        requestCombined.throwIfAborted();
        return decodeVivadoToolResult(tool, result);
      } catch (error) {
        // A cancelled call may be followed immediately by another experiment on
        // this connection. Do not expose a rejection until the old EDA tree is
        // gone; otherwise the new request races the server's single-job lock.
        if (pending.has(callId)) {
          if (requestCombined.aborted || error.code === ErrorCode.RequestTimeout) {
            if (!await waitForCleanup([cleaned])) {
              broken ??= new Error('Vivado MCP cleanup was not confirmed; this connection cannot be reused');
              emit(requestEvent ?? onEvent, { type: 'mcp_error', message: broken.message });
            }
          } else {
            markClean(callId);
          }
        }
        emit(requestEvent ?? onEvent, { type: 'mcp_call_error', tool, message: error.message });
        throw error;
      }
    }
    return {
      metadata,
      info: ({ signal: requestSignal } = {}) => call('vivado_info', {}, requestSignal),
      check: ({ rtlPath, taskPath, workDir, signal: requestSignal, onEvent: requestEvent }) => call('vivado_check', { rtlPath, taskPath, workDir }, requestSignal, requestEvent),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
