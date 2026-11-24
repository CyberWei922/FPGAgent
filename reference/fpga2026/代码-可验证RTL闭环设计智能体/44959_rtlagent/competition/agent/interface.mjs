// Prompt direction typos remain advisory; known widths/names must not be
// silently padded or truncated by the generated testbench. Explicit interfaces
// additionally bind direction (full ANSI contracts are checked by dual-entry).
const ID = '[A-Za-z_][A-Za-z0-9_$]*';
const clean = text => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');

function closeParen(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function declarations(text) {
  const ports = [], unresolved = [];
  let direction, width = 1;
  for (const chunk of text.split(',')) {
    let value = chunk.trim();
    const dir = /^(input|output|inout)\b/.exec(value);
    if (dir) { direction = dir[1]; width = 1; value = value.slice(dir[0].length).trim(); }
    value = value.replace(/\b(?:wire|reg|logic|signed|unsigned|var)\b/g, '').trim();
    const range = /^\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(value);
    if (range) { width = Math.abs(Number(range[1]) - Number(range[2])) + 1; value = value.slice(range[0].length).trim(); }
    else if (value.startsWith('[')) { width = null; value = value.replace(/^\[[^\]]*\]/, '').trim(); }
    const name = new RegExp(`^(${ID})(?:\\s*=.*)?$`).exec(value);
    if (!direction || !name) { if (value) unresolved.push(value.slice(0, 100)); continue; }
    ports.push({ name: name[1], direction, width });
  }
  return { ports, unresolved };
}

export function moduleInterface(source, top) {
  const text = clean(source), regex = new RegExp(`\\bmodule\\s+(?:(?:automatic|static)\\s+)?(${ID})\\s*`, 'g');
  let found;
  while ((found = regex.exec(text))) {
    if (top && found[1] !== top) continue;
    let start = regex.lastIndex;
    if (text[start] === '#') { start = text.indexOf('(', start); const end = closeParen(text, start); if (end < 0) break; start = end + 1; }
    while (start < text.length && /\s/.test(text[start])) start++;
    if (text[start] !== '(') continue;
    const end = closeParen(text, start);
    if (end < 0) break;
    const header = text.slice(start + 1, end), stop = text.indexOf('endmodule', end);
    const body = text.slice(end + 1, stop < 0 ? undefined : stop);
    const parsed = /\b(?:input|output|inout)\b/.test(header) ? declarations(header) : (() => {
      const result = { ports: [], unresolved: [] };
      for (const decl of body.matchAll(/\b(input|output|inout)\s+([^;]+);/g)) {
        const item = declarations(decl[1] + ' ' + decl[2]);
        result.ports.push(...item.ports); result.unresolved.push(...item.unresolved);
      }
      const names = header.split(',').map(s => s.trim()).filter(Boolean);
      if (names.some(name => !result.ports.some(port => port.name === name))) result.unresolved.push('Non-ANSI header has undeclared ports');
      return result;
    })();
    return { top: found[1], ...parsed };
  }
  return { top: null, ports: [], unresolved: ['Module declaration could not be parsed'] };
}

export function expectedInterface(prompt, explicit = '', fallbackTop = 'TopModule') {
  if (explicit.trim()) {
    const parsed = moduleInterface(explicit);
    if (!parsed.top || !parsed.ports.length || parsed.unresolved.length) throw new Error('Explicit interface could not be parsed');
    return { ...parsed, authoritative: true, source: 'interface.txt' };
  }
  // Prose connectors are not identifiers. Multiple conflicting declarations
  // are uncertain too: use the task contract, never an arbitrary first word.
  const commonWords=new Set(['with','using','that','which','should','is','has','have','must','will','shall','to','for','of','and','as','the','a','an','named','called','following','below','above']);
  const candidates=[...prompt.matchAll(/\b(?:module\s+named|top(?:-level)?\s+module|module\s+name)\s*(?:(?:is|named|called)\s+|[:=]\s*)?["'`]?([A-Za-z_][A-Za-z0-9_$]*)/gi)]
    .map(m=>m[1]).filter(n=>!commonWords.has(n.toLowerCase()));
  const names=[...new Set(candidates)];
  const ports = [...prompt.matchAll(/^\s*-\s*(input|output|inout)\s+([A-Za-z_]\w*)\s*,?\s*(?:\(\s*(\d+)\s*(?:bits?|位)\s*\))?\s*$/gm)]
    .map(([, direction, name, width]) => ({ direction, name, width: width ? Number(width) : 1 }));
  if(!ports.length&&/\b(?:bug|fixes?|new version)\b/i.test(prompt)){
    const declarations=[...prompt.matchAll(/\bmodule\s+([A-Za-z_]\w*)\s*\(/g)];
    if(declarations.length===1){const parsed=moduleInterface(prompt,declarations[0][1]);
      if(parsed.top&&parsed.ports.length&&!parsed.unresolved.length)return {...parsed,authoritative:false,source:'prompt_module_declaration',behavior_source:'original_prose_only'};
    }
  }
  const top = names.length===1 ? names[0] : fallbackTop;
  if (typeof top!=='string'||!new RegExp(`^${ID}$`).test(top)) throw new Error('Invalid task top module name');
  if (!top) throw new Error('The top module name is missing from the prompt');
  if (new Set(ports.map(port => port.name)).size !== ports.length || ports.some(port => port.width < 1)) throw new Error('Prompt port list is ambiguous');
  return { top, ports, authoritative: false, source: 'prompt.txt', unresolved: ports.length ? [] : ['No reliable prompt port list; only the top name is checked'] };
}

export function checkInterface(source, expected) {
  const actual = moduleInterface(source, expected.top), differences = [], blockingDifferences = [];
  const difference = (message, binding = true) => { differences.push(message); if (binding) blockingDifferences.push(message); };
  if (actual.top !== expected.top) difference(`Expected module ${expected.top}`);
  const byName = new Map(actual.ports.map(port => [port.name, port]));
  if (byName.size !== actual.ports.length) difference('Duplicate port declarations');
  for (const port of expected.ports) {
    const other = byName.get(port.name);
    if (!other) difference(`Missing port ${port.name}`);
    else {
      if (other.direction !== port.direction) difference(`${port.name}: expected ${port.direction}, found ${other.direction}`, expected.authoritative);
      if (other.width !== null && port.width !== null && other.width !== port.width) difference(`${port.name}: expected ${port.width} bits, found ${other.width}`);
    }
  }
  if (expected.ports.length) for (const port of actual.ports) if (!expected.ports.some(p => p.name === port.name)) difference(`Unexpected port ${port.name}`);
  const unresolved = [...expected.unresolved, ...actual.unresolved, ...[...expected.ports, ...actual.ports].filter(p => p.width === null).map(p => `Unresolved width for ${p.name}`)];
  return { rc: differences.length ? 1 : unresolved.length ? null : 0, authoritative: expected.authoritative,
    blocking: blockingDifferences.length > 0, blockingDifferences, differences, unresolved, excerpt: [...differences, ...unresolved].join('; ') || 'Module and ports match the declared interface',
    source: expected.source, functional_verified: false };
}
