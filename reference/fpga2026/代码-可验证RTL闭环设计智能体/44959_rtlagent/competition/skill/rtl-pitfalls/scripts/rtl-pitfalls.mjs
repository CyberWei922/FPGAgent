#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {argumentsFor, print, cli} from '../../deterministic-cli.mjs';

await cli(async () => {
  const args = argumentsFor({id: {type: 'string'}, category: {type: 'string'}, format: {type: 'string'}});
  if (args.help) return console.log('rtl-pitfalls [--id ID] [--category CATEGORY] [--format json|markdown]');
  if (args.format && !['json', 'markdown'].includes(args.format)) throw new Error('--format must be json or markdown');
  const all = JSON.parse(await readFile(new URL('../pitfalls.json', import.meta.url), 'utf8'));
  const rows = all.filter(row => (!args.id || row.id === args.id) && (!args.category || row.category === args.category));
  if (!rows.length) { print({status: 'not_found', count: 0, pitfalls: []}); process.exitCode = 1; return; }
  if (args.format !== 'markdown') return print({count: rows.length, pitfalls: rows});
  const cell = text => String(text).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const lines = [];
  for (const category of new Set(rows.map(row => row.category))) {
    lines.push('### ' + category, '', '| ID | Symptom / cause | Rule | Detect with | Applies to / Not for | Evidence |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of rows.filter(row => row.category === category)) lines.push('| ' + [r.id, r.symptom + ' / ' + r.cause,
      r.rule, r.detect_with.join('; '), r.applies_to.join('; ') + ' / ' + r.not_for.join('; '),
      r.evidence.map(e => e.task + ': ' + JSON.stringify(e.numbers) + '; ' + e.artifact + '#' + (e.pointer ?? '') + '; commit ' + e.commit).join('; ')].map(cell).join(' | ') + ' |');
    lines.push('');
  }
  console.log(lines.join('\n').trimEnd());
});
