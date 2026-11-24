import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, readFile, writeFile, readdir, stat, mkdir, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectVivado, checkRtl } from './vivado.mjs';

// Fixed scripts only. Hex-encoded Tcl words prevent paths from becoming commands.
export const tclWord = value => `[encoding convertfrom utf-8 [binary decode hex ${Buffer.from(String(value), 'utf8').toString('hex')}]]`;
export function toolScript({ tool, executable, args, cwd, logPath, marker }) {
  if (!['vivado', 'xvlog', 'xelab', 'xsim'].includes(tool)) throw new Error('Unsupported fixed Vivado tool');
  for (const file of [executable, cwd, logPath, marker]) if (!path.isAbsolute(file)) throw new Error('Absolute tool paths are required');
  const command = tool === 'vivado' ? `source ${tclWord(path.join(cwd, 'synth.tcl'))}`
    : `exec ${[executable, ...args].map(tclWord).join(' ')} 2>@1`;
  return `cd ${tclWord(cwd)}\nset rtl_rc [catch {${command}} rtl_output]\nset rtl_log [open ${tclWord(logPath)} w]\nputs $rtl_log $rtl_output\nclose $rtl_log\nset rtl_marker [open ${tclWord(marker + '.tmp')} w]\nputs $rtl_marker $rtl_rc\nclose $rtl_marker\nfile rename -force ${tclWord(marker + '.tmp')} ${tclWord(marker)}\n`;
}

function responseObjects(result) {
  const objects = [result?.structuredContent];
  for (const item of result?.content ?? []) if (item.type === 'text') {
    try { objects.push(JSON.parse(item.text)); } catch { /* Only machine-readable fields are interpreted. */ }
  }
  return objects.filter(Boolean);
}
function failedResponse(result) {
  return result?.isError || responseObjects(result).some(value => ['error', 'failed', 'failure'].includes(value.status) || value.success === false);
}
export function sessionId(result) {
  if (failedResponse(result)) throw new Error('Official MCP could not start Vivado');
  const objects = responseObjects(result);
  function find(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (typeof value.session_id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value.session_id)) return value.session_id;
    for (const nested of Object.values(value)) { const id = find(nested, depth + 1); if (id) return id; }
  }
  for (const object of objects) { const id = find(object); if (id) return id; }
  throw new Error('Official MCP returned no supported session_id; inspect its actual response before adapting');
}

// One official sidecar per request; a Vivado session is reused only within it.
export async function createRossBackend({ config, signal, client: givenClient, transport: givenTransport }) {
  const command = config.mcp.officialBinary;
  if (!givenClient && (!command || !path.isAbsolute(command))) throw new Error('An absolute official MCP binary path is required');
  const client = givenClient ?? new Client({ name: 'rtl-competition-adapter', version: '0.2.0' });
  const privateHome = path.join(path.resolve(config.mcp.workspaceRoot || '.'), '.ross-home');
  const toolEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LD_LIBRARY_PATH', 'LM_LICENSE_FILE', 'XILINXD_LICENSE_FILE', 'XILINX_VIVADO'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  if (!givenClient) {
    await mkdir(privateHome, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32' && !toolEnv.XILINXD_LICENSE_FILE && process.env.APPDATA) {
      const license = path.join(process.env.APPDATA, 'XilinxLicense', 'Xilinx.lic');
      try { await access(license); toolEnv.XILINXD_LICENSE_FILE = license; } catch { /* Retain other configured license discovery. */ }
    }
    if (process.platform !== 'win32' && !toolEnv.XILINXD_LICENSE_FILE && process.env.HOME) {
      const license = path.join(process.env.HOME, '.Xilinx', 'Xilinx.lic');
      try { await access(license); toolEnv.XILINXD_LICENSE_FILE = license; } catch { /* Cloud image may use a license server. */ }
    }
    toolEnv.HOME = privateHome;
    if (process.platform === 'win32') toolEnv.USERPROFILE = privateHome;
  }
  const transport = givenTransport ?? (givenClient ? {} : new StdioClientTransport({ command,
    args: ['--stdio', '--state-dir=' + path.join(config.mcp.workspaceRoot, '.ross-state'), '--max-sessions=1', '--enable-lsf=false', '--enable-ssh=false', '--enable-telemetry=false', '--enable-otel=false'], cwd: config.mcp.workspaceRoot,
    stderr: 'pipe', env: toolEnv }));
  transport.stderr?.on('data', chunk => { /* Keep sidecar logs away from MCP stdout. */ process.stderr.write(String(chunk).slice(0, 4000)); });
  let id, ownedPid, vivadoLog, broken = false, closed = false, closePromise;
  const pending = new Set();
  const call = async (name, args, callSignal = signal, timeout = config.mcp.requestTimeoutMs) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { signal: callSignal, timeout, maxTotalTimeout: timeout });
    if (failedResponse(result)) throw new Error(`Official MCP ${name} failed`);
    return result;
  };
  async function stopSession() {
    if (!id) return;
    const owned = id; id = undefined;
    try {
      const end = Date.now() + 5000;
      await call('vivado_stop', { session_id: owned, close_vivado: true }, AbortSignal.timeout(3500), 3500);
      while (ownedPid) {
        try { process.kill(ownedPid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() >= end) throw new Error('Owned Vivado process is still alive after stop');
        await delay(100);
      }
      ownedPid = undefined;
    }
    catch (error) { broken = true; throw new Error(`Official Vivado session cleanup is unconfirmed: ${error.message}`); }
  }
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      let failure;
      try { await stopSession(); } catch (error) { failure = error; }
      await client.close();
      await Promise.allSettled([...pending]);
      if (failure) throw failure;
    })();
    return closePromise;
  }
  try {
    if (!givenClient) await client.connect(transport, { signal, timeout: 15000 });
    const { tools } = await client.listTools({}, { signal, timeout: 10000 });
    const names = tools.map(tool => tool.name);
    for (const needed of ['vivado_start', 'vivado_stop', 'vivado_execute', 'vivado_status', 'vivado_log_messages']) {
      if (!names.includes(needed)) throw new Error(`Official MCP is missing ${needed}`);
    }
    const metadata = { backend: 'amd_ross', transport: 'stdio', server: client.getServerVersion?.(), tools: names, officialBinary: command,
      acceptance: 'Adapter capability discovery only; actual Vivado acceptance requires execution' };
    async function executor(options) {
      if (broken || closed) throw new Error('Official MCP connection is not reusable');
      const combined = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
      if (!id) {
        const started = await call('vivado_start', { working_dir: config.mcp.workspaceRoot, session_type: 'general', gui_mode: false,
          vivado_path: path.join(config.vivado.binDir, 'vivado' + (process.platform === 'win32' ? '.bat' : '')), external: false }, combined);
        await writeFile(path.join(config.mcp.workspaceRoot, '.ross-start.json'), JSON.stringify(started, null, 2));
        id = sessionId(started);
        const processId = responseObjects(started).find(value => Number.isInteger(value.process_id))?.process_id;
        if (processId > 0) ownedPid = processId;
        try {
          const directory = path.join(config.mcp.workspaceRoot, '.vivado-ai');
          const logs = (await readdir(directory)).filter(name => /^vivado_[A-Za-z0-9_]+\.log$/.test(name) && !name.startsWith('vivado_proxy_'));
          if (logs.length === 1) vivadoLog = path.join(directory, logs[0]);
        } catch { /* Some builds return logs only through the tool API. */ }
      }
      const logOffset = vivadoLog ? (await stat(vivadoLog)).size : 0;
      const marker = path.join(options.cwd, `ross-${randomUUID()}.done`);
      // Each command gets an independent log; xvlog output must survive xelab.
      const commandLog = marker + '.log';
      const script = toolScript({ ...options, logPath: commandLog, marker });
      await writeFile(marker + '.tcl', script);
      let error;
      const operation = call('vivado_execute', { session_id: id, command: `source ${tclWord(marker + '.tcl')}`, capture_log: true, echo: false }, combined)
        .catch(value => { error = value; });
      pending.add(operation); operation.finally(() => pending.delete(operation));
      try {
        while (true) {
          combined.throwIfAborted();
          let value;
          try { value = (await readFile(marker, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (value !== undefined) {
            if (!/^[01]$/.test(value)) throw new Error('Invalid official execution completion marker');
            const log = await open(commandLog, 'r');
            let text;
            try { const size = (await log.stat()).size; const bytes = Buffer.alloc(Math.min(size, 8 * 1024 * 1024)); await log.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length)); text = bytes.toString('utf8'); }
            finally { await log.close(); }
            if (options.tool === 'vivado' && vivadoLog) {
              const nativeLog = await open(vivadoLog, 'r');
              try { const size = (await nativeLog.stat()).size; const bytes = Buffer.alloc(Math.min(Math.max(0, size - logOffset), 8 * 1024 * 1024));
                await nativeLog.read(bytes, 0, bytes.length, Math.max(logOffset, size - bytes.length)); text += '\n' + bytes.toString('utf8'); }
              finally { await nativeLog.close(); }
            }
            // Preserve a single stage log while retaining the full command artifacts.
            await writeFile(options.logPath, text, { flag: options.args?.[0]?.startsWith('work.') ? 'a' : 'w' });
            return { exitCode: Number(value), text, timedOut: false, cancelled: false };
          }
          if (error) throw error;
          await delay(100, undefined, { signal: combined });
        }
      } catch (failure) {
        broken = true;
        let cleanup;
        try { await stopSession(); } catch (e) { cleanup = e.message; }
        return { exitCode: null, text: cleanup || failure.message, timedOut: !cleanup && combined.aborted && !options.signal?.aborted,
          cancelled: !cleanup && Boolean(options.signal?.aborted), spawnError: cleanup || (!combined.aborted ? failure.message : undefined) };
      }
    }
    return { metadata, info: args => inspectVivado(config.vivado, args),
      check: async args => {
        if (broken || closed) throw new Error('Official MCP connection is not reusable');
        return await checkRtl({ ...args, config: config.vivado, executionRoot: path.join(config.mcp.workspaceRoot, '.vivado-work'), executor });
      }, close };
  } catch (error) { try { await close(); } catch {} throw error; }
}
