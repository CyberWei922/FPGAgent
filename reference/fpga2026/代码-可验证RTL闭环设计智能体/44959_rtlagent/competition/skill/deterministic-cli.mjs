// Shared CLI plumbing. All checking and oracle logic stays in the agent sources.
import path from 'node:path';
import {access, readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

export async function agentRoot(from) {
  let directory = path.dirname(fileURLToPath(from));
  for (;;) {
    try {
      await access(path.join(directory, 'rtl-agent/src/verification/registry.mjs'));
      await access(path.join(directory, 'competition/agent/interface.mjs'));
      return directory;
    } catch { /* Try the next ancestor in development or either export layout. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot find rtl-agent/src. Keep the skill beside the exported agent.');
    directory = parent;
  }
}

export const sourceModule = (root, name) => import(pathToFileURL(path.join(root, name)).href);
export const readText = file => readFile(path.resolve(file), 'utf8');
export const readJson = async file => JSON.parse(await readText(file));
export const print = value => console.log(JSON.stringify(value, null, 2));
export function argumentsFor(options) {
  return parseArgs({options: {help: {type: 'boolean'}, ...options}, allowPositionals: false}).values;
}
export function required(args, names) {
  for (const name of names) if (!args[name]) throw new Error('Missing --' + name);
}
export async function cli(main) {
  try { await main(); }
  catch (error) {
    print({status: 'error', code: error.code ?? 'CLI_ERROR', message: error.message});
    process.exitCode = 2;
  }
}

// An explicit interface is a Verilog module header, as used by dual-entry.
export async function interfaceFor(root, args, spec) {
  const {expectedInterface} = await sourceModule(root, 'competition/agent/interface.mjs');
  const expected = expectedInterface(spec, args.interface ? await readText(args.interface) : '', args.top ?? 'TopModule');
  if (args.top && expected.top !== args.top) throw new Error('--top disagrees with the specification/interface module name');
  return expected;
}
