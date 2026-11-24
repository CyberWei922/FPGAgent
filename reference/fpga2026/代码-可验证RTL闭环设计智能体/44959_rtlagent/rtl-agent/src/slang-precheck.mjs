import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { runProcess } from './vivado.mjs';

const HELPER = fileURLToPath(new URL('./slang-precheck.py', import.meta.url));
const RULES = new Set(['procedural_net_assignment', 'undeclared_identifier', 'redefinition', 'multiple_always_ff_drivers', 'missing_semicolon']);

export function normalizeRtlPrecheck(raw) {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('agent.rtlPrecheck must be an object');
  const result = { mode: 'off', python: 'python3', timeoutMs: 5000, maxDiagnostics: 12, ...raw };
  if (!['off', 'slang'].includes(result.mode)) throw new Error('agent.rtlPrecheck.mode must be off or slang');
  if (typeof result.python !== 'string' || !result.python.trim() || /[\r\n\0]/.test(result.python)) throw new Error('agent.rtlPrecheck.python must name an executable');
  for (const [name, min, max] of [['timeoutMs', 50, 15000], ['maxDiagnostics', 1, 24]]) {
    if (!Number.isSafeInteger(result[name]) || result[name] < min || result[name] > max) throw new Error(`Invalid agent.rtlPrecheck.${name}`);
  }
  return result;
}

export async function checkWithSlang({ rtlPath, top, workDir, options, signal, executor = runProcess }) {
  const config = normalizeRtlPrecheck(options), started = Date.now();
  if (signal?.aborted) signal.throwIfAborted();
  if (config.mode === 'off') return { decision: 'off', durationMs: 0 };
  let directory;
  const fallback = reason => ({ decision: 'fallback', reason, durationMs: Date.now() - started });
  try {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(top)) return fallback('invalid_top');
    const info = await lstat(rtlPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) return fallback('source_boundary');
    const source = await readFile(rtlPath, 'utf8'), digest = createHash('sha256').update(source).digest('hex');
    await mkdir(workDir, { recursive: true });
    directory = await mkdtemp(path.join(workDir, 'slang-'));
    const input = path.join(directory, 'dut.sv');
    await writeFile(input, source, { flag: 'wx', mode: 0o600 });
    const run = await executor(config.python, ['-B', HELPER, '--source', input, '--top', top, '--max-diagnostics', String(config.maxDiagnostics)],
      { cwd: directory, timeoutMs: config.timeoutMs, signal });
    if (signal?.aborted) signal.throwIfAborted();
    if (run.cancelled) throw new Error('Preflight was cancelled');
    if (run.timedOut) return fallback('helper_timeout');
    if (run.exitCode !== 0 || run.spawnError || run.text.length > 65536) return fallback('helper_process_error');
    let result;
    try { result = JSON.parse(run.text); } catch { return fallback('helper_protocol_error'); }
    if (result?.schema_version !== 1 || result.tool !== 'pyslang' || result.version !== '12.0.0'
        || !['pass', 'reject', 'fallback'].includes(result.decision)) return fallback('helper_protocol_error');
    if (result.decision === 'fallback') return { ...fallback(result.reason), errorType: result.error_type };
    if (result.source_sha256 !== digest || !Number.isSafeInteger(result.errors) || result.errors < 0
        || !Number.isSafeInteger(result.warnings) || result.warnings < 0 || !Array.isArray(result.diagnostics)
        || result.diagnostics.length > config.maxDiagnostics) return fallback('helper_protocol_error');
    const rows = result.diagnostics;
    if (rows.some(row => row.file !== 'dut.sv' || !Number.isSafeInteger(row.line) || row.line < 1
        || !Number.isSafeInteger(row.column) || row.column < 1 || typeof row.message !== 'string' || row.message.length > 1000
        || !['error', 'fatal error', 'warning', 'note'].includes(row.severity))) return fallback('helper_protocol_error');
    const hard = rows.filter(row => ['error', 'fatal error'].includes(row.severity));
    if (result.decision === 'pass' && (result.errors !== 0 || hard.length)) return fallback('helper_protocol_error');
    if (result.decision === 'reject' && (!hard.length || hard.length !== result.errors || hard.some(row => !RULES.has(row.rule)))) return fallback('unverified_diagnostic');
    const output = { decision: result.decision, reason: result.reason, errors: result.errors, warnings: result.warnings,
      diagnostics: rows, sourceSha256: digest, durationMs: Date.now() - started };
    await writeFile(path.join(workDir, 'slang-precheck.json'), JSON.stringify(output, null, 2) + '\n');
    return output;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    return fallback('helper_unavailable');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function slangFailure(result, maxChars = 5000) {
  if (result.decision !== 'reject') return null;
  const lines = result.diagnostics.filter(row => ['error', 'fatal error'].includes(row.severity))
    .map(row => `${row.file}:${row.line}:${row.column}: ${row.severity}: ${row.message}`);
  const feedback = ('SLANG_PREFLIGHT: language errors detected before AMD compilation. Repair the cause using the specification; return the complete RTL.\n'
    + lines.join('\n') + '\nAMD compilation, synthesis and functional correctness have not been verified.').slice(0, maxChars);
  return { passed: false, oracleKind: 'none', feedback,
    stages: [{ name: 'precheck', tool: 'pyslang', status: 'fail', diagnostics: lines, durationMs: result.durationMs, logPath: null }] };
}
