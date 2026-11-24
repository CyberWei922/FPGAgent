#!/usr/bin/env node
import {agentRoot, sourceModule, readText, print, argumentsFor, required, cli, interfaceFor} from '../../deterministic-cli.mjs';

await cli(async () => {
  const args = argumentsFor({spec: {type: 'string'}, rtl: {type: 'string'}, top: {type: 'string'}, interface: {type: 'string'}});
  if (args.help) return console.log('rtl-interface-check --spec prompt.txt --rtl dut.sv --top NAME [--interface interface.sv]');
  required(args, ['spec', 'rtl', 'top']);
  const root = await agentRoot(import.meta.url);
  const expected = await interfaceFor(root, args, await readText(args.spec));
  const {moduleInterface, checkInterface} = await sourceModule(root, 'competition/agent/interface.mjs');
  const rtl = await readText(args.rtl), actual = moduleInterface(rtl, args.top);
  const check = checkInterface(rtl, expected);
  const names = [...new Set([...expected.ports, ...actual.ports].map(p => p.name))];
  const ports = names.map(name => {
    const wanted = expected.ports.find(p => p.name === name) ?? null;
    const found = actual.ports.find(p => p.name === name) ?? null;
    return {name, expected: wanted, actual: found, name_match: !!wanted && !!found,
      direction_match: wanted && found ? wanted.direction === found.direction : null,
      width_match: wanted && found && wanted.width !== null && found.width !== null ? wanted.width === found.width : null};
  });
  print({status: check.rc === 0 ? 'match' : check.rc === 1 ? 'mismatch' : 'unknown', ports, check});
  process.exitCode = check.rc === null ? 2 : check.rc;
});
