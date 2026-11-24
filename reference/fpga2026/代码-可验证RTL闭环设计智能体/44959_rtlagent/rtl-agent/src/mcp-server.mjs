import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, loadTask, readJson } from './config.mjs';
import { inspectVivado, checkRtl } from './vivado.mjs';
import { createRossBackend } from './ross-backend.mjs';
import { createPersistentBackend } from './persistent-backend.mjs';

const SERVER_INFO = { name: 'rtl-vivado', version: '0.1.0' };
const CALL_ID_KEY = 'rtlAgentCallId';
const absolutePath = z.string().min(1).max(4096).refine(value => path.isAbsolute(value), 'An absolute path is required');

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label} must be an absolute path`);
  const full = path.resolve(value);
  if (process.platform === 'win32' && full.slice(path.parse(full).root.length).includes(':')) throw new Error(`${label} cannot use an alternate data stream`);
  return full;
}

function inside(root, file, label) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} is outside mcp.workspaceRoot`);
  return file;
}

async function inputFile(root, value, label) {
  const canonical = inside(root, await realpath(absolute(value, label)), label);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error(`${label} must be a regular file of at most 2 MiB`);
  return canonical;
}

async function outputDirectory(root, value) {
  let ancestor = absolute(value, 'workDir');
  const missing = [];
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Cannot resolve workDir parent');
      ancestor = parent;
    }
  }
  // Resolve the nearest existing parent before creating anything. A junction or
  // symlink to an external directory must not cause an out-of-workspace write.
  let canonical = inside(root, await realpath(ancestor), 'workDir parent');
  if (!(await stat(canonical)).isDirectory()) throw new Error('workDir parent must be a directory');
  for (const component of missing) {
    canonical = inside(root, path.join(canonical, component), 'workDir');
    await mkdir(canonical).catch(error => { if (error.code !== 'EEXIST') throw error; });
    canonical = inside(root, await realpath(canonical), 'workDir');
    if (!(await stat(canonical)).isDirectory()) throw new Error('workDir must be a directory');
  }
  return canonical;
}

async function checkedInputs(root, args) {
  const rtlPath = await inputFile(root, args.rtlPath, 'rtlPath');
  const taskPath = await inputFile(root, args.taskPath, 'taskPath');
  const raw = await readJson(taskPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('task must be an object');
  const base = path.dirname(taskPath);
  // loadTask reads these files itself, so validate references BEFORE calling it.
  let specPath, tbPath;
  if (raw.specFile !== undefined) {
    if (typeof raw.specFile !== 'string') throw new Error('task.specFile must be a path');
    specPath = await inputFile(root, path.resolve(base, raw.specFile), 'task.specFile');
  }
  if (raw.testbench !== undefined) {
    if (typeof raw.testbench?.path !== 'string') throw new Error('task.testbench.path must be a path');
    tbPath = await inputFile(root, path.resolve(base, raw.testbench.path), 'task.testbench.path');
  }
  const task = await loadTask(taskPath);
  if (task.specFile) {
    if (await inputFile(root, path.resolve(base, task.specFile), 'task.specFile') !== specPath) throw new Error('task.specFile changed while loading');
  }
  if (task.testbench) {
    const loadedTb = await inputFile(root, task.testbench.path, 'task.testbench.path');
    if (loadedTb !== tbPath) throw new Error('task.testbench.path changed while loading');
    task.testbench.path = loadedTb;
  }
  return { rtlPath, task, workDir: await outputDirectory(root, args.workDir) };
}

function result(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}

function errorResult(error, code = 'VIVADO_MCP_ERROR') {
  return result({ passed: false, error: code, message: String(error?.message ?? error).slice(0, 2000) }, true);
}

export async function startVivadoMcpServer({ configPath }) {
  const config = await loadConfig(absolute(configPath, 'configPath'));
  const root = await realpath(absolute(config.mcp.workspaceRoot, 'mcp.workspaceRoot'));
  if (!(await stat(root)).isDirectory()) throw new Error('mcp.workspaceRoot must be a directory');
  const server = new McpServer(SERVER_INFO, { capabilities: { logging: {} } });
  const transport = new StdioServerTransport();
  const lifetime = new AbortController();
  let busy = false, active = Promise.resolve(), stopping, official;
  const persistent = config.mcp.backend === 'fixed_persistent' ? createPersistentBackend({ config }) : undefined;
  const officialBackend = async () => {
    if (!official) official = await createRossBackend({ config, signal: lifetime.signal });
    return official;
  };

  async function exclusive(extra, operation) {
    const callId = typeof extra._meta?.[CALL_ID_KEY] === 'string' ? extra._meta[CALL_ID_KEY].slice(0, 100) : undefined;
    const notify = async data => {
      if (!server.isConnected()) return;
      let timer;
      // A broken stdout pipe must not prevent process cleanup indefinitely.
      await Promise.race([
        server.sendLoggingMessage({ level: 'info', logger: 'rtl-vivado', data: { ...data, callId } }).catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, 200); }),
      ]);
      clearTimeout(timer);
    };
    if (busy || lifetime.signal.aborted) {
      await notify({ type: 'mcp_cleanup' });
      return errorResult(new Error(busy ? 'Vivado is busy; retry after the active request finishes' : 'Vivado server is shutting down'), busy ? 'VIVADO_BUSY' : 'VIVADO_STOPPING');
    }
    busy = true;
    let finish;
    active = new Promise(resolve => { finish = resolve; });
    const signal = AbortSignal.any([lifetime.signal, extra.signal]);
    try {
      signal.throwIfAborted();
      return result(await operation(signal, data => notify(data)));
    } catch (error) {
      return errorResult(error, signal.aborted ? 'VIVADO_CANCELLED' : 'VIVADO_MCP_ERROR');
    } finally {
      busy = false;
      // The request response may be discarded after MCP cancellation. A logging
      // notification lets our client wait for process-tree cleanup before close.
      await notify({ type: 'mcp_cleanup' });
      finish();
    }
  }

  server.registerTool('vivado_info', {
    description: 'Inspect the fixed configured Vivado toolchain and version. No shell or Tcl input is accepted.',
    inputSchema: z.object({}).strict(),
  }, async (_args, extra) => exclusive(extra, async signal => config.mcp.backend === 'amd_ross'
    ? (await officialBackend()).info({ signal }) : inspectVivado(config.vivado, { signal })));

  server.registerTool('vivado_check', {
    description: 'Run the fixed Vivado compile/simulation/synthesis flow. Inputs and artifacts must remain in the configured workspace; testbenches are public local checks, not a hidden judge.',
    inputSchema: z.object({ rtlPath: absolutePath, taskPath: absolutePath, workDir: absolutePath }).strict(),
  }, async (args, extra) => exclusive(extra, async (signal, onEvent) => {
    const inputs = await checkedInputs(root, args);
    // Legacy Windows EDA binaries can crash with deeply nested benchmark paths.
    // Keep tool execution short while retaining an index beside the requested run.
    const executionRoot = await outputDirectory(root, path.join(root, '.vivado-work'));
    signal.throwIfAborted();
    if (config.mcp.backend === 'amd_ross') return (await officialBackend()).check({ ...inputs, signal, onEvent });
    if (persistent) return persistent.check({ ...inputs, signal, onEvent });
    return checkRtl({ ...inputs, executionRoot, config: config.vivado, signal, onEvent });
  }));

  async function shutdown(reason) {
    if (stopping) return stopping;
    stopping = (async () => {
      lifetime.abort(new Error(reason));
      await active;
      if (official) await official.close();
      if (persistent) await persistent.close();
      await server.close();
      process.stdin.pause();
      for (const [emitter, event, listener] of listeners) emitter.off(event, listener);
    })();
    return stopping;
  }
  const stop = reason => { void shutdown(reason).catch(error => { process.stderr.write(`Vivado MCP shutdown: ${error.message}\n`); process.exitCode = 1; }); };
  const listeners = [
    [process.stdin, 'end', () => stop('MCP client disconnected')],
    [process.stdin, 'close', () => stop('MCP client closed stdin')],
    [process.stdin, 'error', () => stop('MCP stdin failed')],
    [process.stdout, 'error', () => stop('MCP stdout failed')],
    [process, 'SIGINT', () => stop('SIGINT')],
    [process, 'SIGTERM', () => stop('SIGTERM')],
  ];
  for (const [emitter, event, listener] of listeners) emitter.on(event, listener);
  server.server.onclose = () => stop('MCP transport closed');
  server.server.onerror = error => {
    process.stderr.write(`Vivado MCP protocol error: ${String(error.message).slice(0, 1000)}\n`);
    stop('MCP protocol error');
  };
  try { await server.connect(transport); }
  catch (error) { await shutdown('MCP startup failed'); throw error; }
  return { server, close: () => shutdown('Server close requested') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') {
    process.stderr.write('Usage: node src/mcp-server.mjs --config <absolute-config.json>\n');
    process.exitCode = 1;
  } else {
    startVivadoMcpServer({ configPath: path.resolve(args[1]) }).catch(error => {
      process.stderr.write(`Vivado MCP startup failed: ${String(error.message).slice(0, 2000)}\n`);
      process.exitCode = 1;
    });
  }
}
