import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label} must be an absolute path`);
  const full = path.resolve(value);
  if (process.platform === 'win32' && full.slice(path.parse(full).root.length).includes(':')) throw new Error(`${label} cannot use an alternate data stream`);
  return full;
}

function inside(root, file, label) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} is outside workspaceRoot`);
  return file;
}

async function source(root, file, label) {
  const canonical = inside(root, await realpath(absolute(file, label)), label);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw new Error(`${label} must be a regular file of at most 2 MiB`);
  const bytes = await readFile(canonical);
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`${label} must be at most 2 MiB`);
  return { path: canonical, bytes, sha256: hash(bytes) };
}

/**
 * Freeze the already parsed task's semantics, plus the trusted TB bytes available
 * now. Source task/spec file hashes describe provenance at freeze time; those
 * files are never reparsed to replace the caller's specification or stages.
 * The caller creates runDir, writes task.json, and passes that snapshot to MCP.
 */
export async function freezeTask({ task, taskPath, workspaceRoot, runDir }) {
  if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.spec !== 'string' || !task.spec.trim()) throw new Error('freezeTask requires a parsed task with a specification');
  const root = await realpath(absolute(workspaceRoot, 'workspaceRoot'));
  if (!(await stat(root)).isDirectory()) throw new Error('workspaceRoot must be a directory');
  const directory = inside(root, await realpath(absolute(runDir, 'runDir')), 'runDir');
  if (!(await stat(directory)).isDirectory()) throw new Error('runDir must be an existing directory');
  const originalTaskPath = absolute(taskPath, 'taskPath');
  const taskSource = await source(root, originalTaskPath, 'taskPath');
  let specSource;
  if (task.specFile !== undefined) {
    if (typeof task.specFile !== 'string' || !task.specFile) throw new Error('task.specFile must be a nonempty path');
    // Match loadTask's resolution from the supplied path, including an in-root alias.
    specSource = await source(root, path.resolve(path.dirname(originalTaskPath), task.specFile), 'task.specFile');
  }
  let tbSource;
  if (task.testbench !== undefined) {
    if (!task.testbench || typeof task.testbench !== 'object' || Array.isArray(task.testbench)) throw new Error('task.testbench must be an object');
    tbSource = await source(root, task.testbench.path, 'task.testbench.path');
  }

  const frozenTask = structuredClone(task);
  delete frozenTask.specFile;
  // Do not preserve a caller-supplied audit object as if we had verified it.
  frozenTask.verificationSources = {
    semantics: 'provided-parsed-task',
    task: { path: taskSource.path, sha256: taskSource.sha256, role: 'provenance-only-at-freeze' },
    spec: {
      origin: specSource ? 'parsed-specFile' : 'parsed-inline-spec',
      sha256: hash(Buffer.from(frozenTask.spec, 'utf8')),
      sourcePath: (specSource ?? taskSource).path,
      sourceFileSha256: (specSource ?? taskSource).sha256,
      sourceFileRole: 'provenance-only-at-freeze',
    },
  };
  if (tbSource) {
    const snapshotPath = path.join(directory, 'trusted-testbench.sv');
    // Exclusive creation also refuses preexisting symlinks/junctions; never
    // overwrite an existing file or follow a destination link outside runDir.
    await writeFile(snapshotPath, tbSource.bytes, { flag: 'wx' });
    frozenTask.testbench.path = snapshotPath;
    frozenTask.verificationSources.tb = {
      path: tbSource.path, sha256: tbSource.sha256, snapshotPath,
    };
  }
  return frozenTask;
}
