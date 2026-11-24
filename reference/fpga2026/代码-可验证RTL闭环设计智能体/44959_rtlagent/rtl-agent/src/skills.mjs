import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const INTRO = 'OFFLINE SKILL PATTERNS\nThe task specification takes precedence. These general patterns and example interfaces apply only where compatible with that specification.\n';
const SUMMARY_INTRO = 'OFFLINE SKILL NOTES (the task specification takes precedence):\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.normalize('NFKC').toLowerCase();
const emptySelection = () => ({ text: '', selected: [], omitted: [], totalChars: 0 });

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function ids(value, label) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error(`${label} must be an array of skill IDs`);
  return [...new Set(value)];
}

function settings(config) {
  if (config === undefined) return { enabled: false };
  record(config, 'skills');
  if (config.enabled === undefined || config.enabled === false) return { enabled: false };
  if (config.enabled !== true) throw new Error('skills.enabled must be a boolean');
  const result = { mode: 'auto', ids: [], maxSelected: 2, maxChars: 6000, includeExamples: true, ...config };
  if (!['auto', 'manual'].includes(result.mode)) throw new Error('skills.mode must be auto or manual');
  result.ids = ids(result.ids, 'skills.ids');
  for (const key of ['maxSelected', 'maxChars']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error(`skills.${key} must be a nonnegative integer`);
  }
  if (typeof result.includeExamples !== 'boolean') throw new Error('skills.includeExamples must be a boolean');
  return result;
}

function relativeFile(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\0\r\n:]/.test(value)
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`${label} must be a relative file path within the skills directory`);
  }
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${label} must not contain path traversal`);
  return parts.join('/');
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function inspectFile(root, relative) {
  const file = path.resolve(root, relative);
  if (!within(root, file)) throw new Error(`Skill path escapes the skills directory: ${relative}`);
  const physical = await realpath(file);
  if (!within(root, physical)) throw new Error(`Skill symlink escapes the skills directory: ${relative}`);
  const info = await stat(physical);
  if (!info.isFile()) throw new Error(`Skill path must be a regular file: ${relative}`);
  return { path: physical, size: info.size };
}

async function material(root, relative, role) {
  // Recheck paths when selected: an index load must not authorize a later symlink swap.
  const file = await inspectFile(root, relative);
  if (file.size > MAX_FILE_BYTES) throw new Error(`Skill material exceeds 2 MiB: ${relative}`);
  const bytes = await readFile(file.path);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Skill material exceeds 2 MiB: ${relative}`);
  return { text: bytes.toString('utf8').replace(/^\uFEFF/, ''), file: { role, path: file.path, sha256: hash(bytes) } };
}

function bodyWithoutFrontmatter(text, id) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trim() === '---') {
    const closing = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (closing < 0) throw new Error(`Unterminated frontmatter in skill ${id}`);
    lines.splice(0, closing + 1);
  }
  const body = lines.join('\n').trim();
  if (!body) throw new Error(`Skill ${id} has no body`);
  return body;
}

function fencedExample(text) {
  const body = text.replace(/\r\n/g, '\n').trimEnd();
  let longest = 0;
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}systemverilog\n${body}\n${fence}`;
}

/** Load only the index and file metadata. Skill bodies/examples are read on selection. */
export async function loadSkillCatalog(config) {
  const cfg = settings(config);
  if (!cfg.enabled) return Object.freeze({ enabled: false, version: 1, directory: null, indexPath: null, indexSha256: null, skills: Object.freeze([]) });
  if (typeof cfg.directory !== 'string' || !path.isAbsolute(cfg.directory)) throw new Error('skills.directory must be an absolute directory');
  const directory = await realpath(cfg.directory);
  if (!(await stat(directory)).isDirectory()) throw new Error('skills.directory must be a directory');
  const indexFile = await material(directory, 'index.json', 'index');
  let index;
  try { index = JSON.parse(indexFile.text); }
  catch { throw new Error('Invalid JSON in skills/index.json'); }
  record(index, 'Skill index');
  if (index.version !== 1 || !Array.isArray(index.skills)) throw new Error('Skill index must have version 1 and a skills array');
  const seen = new Set();
  const skills = [];
  for (const item of index.skills) {
    record(item, 'Skill index entry');
    if (typeof item.id !== 'string' || !ID.test(item.id) || seen.has(item.id)) throw new Error('Skill index contains an invalid or duplicate ID');
    seen.add(item.id);
    if (typeof item.description !== 'string' || !item.description.trim()) throw new Error(`Skill ${item.id} requires a description`);
    if (!Array.isArray(item.keywords) || item.keywords.some(word => typeof word !== 'string' || !word.trim())) throw new Error(`Skill ${item.id} keywords must be nonempty literal strings`);
    const entry = {
      id: item.id, description: item.description.trim(),
      path: relativeFile(item.path, `Skill ${item.id} path`), keywords: Object.freeze([...new Set(item.keywords)]),
    };
    if (item.summary !== undefined) {
      if (typeof item.summary !== 'string' || !item.summary.trim() || item.summary.length > 600) throw new Error(`Skill ${item.id} summary must contain 1-600 characters`);
      entry.summary = item.summary.trim();
    }
    for (const key of ['example', 'reference']) {
      if (item[key] !== undefined) entry[key] = relativeFile(item[key], `Skill ${item.id} ${key}`);
    }
    for (const key of ['top', 'clockPort']) {
      if (item[key] !== undefined) {
        if (typeof item[key] !== 'string' || !IDENTIFIER.test(item[key])) throw new Error(`Invalid ${key} in skill ${item.id}`);
        entry[key] = item[key];
      }
    }
    if (item.clockPeriodNs !== undefined) {
      if (typeof item.clockPeriodNs !== 'number' || !Number.isFinite(item.clockPeriodNs) || item.clockPeriodNs <= 0) throw new Error(`Invalid clockPeriodNs in skill ${item.id}`);
      entry.clockPeriodNs = item.clockPeriodNs;
    }
    for (const key of ['path', 'example', 'reference']) if (entry[key]) await inspectFile(directory, entry[key]);
    skills.push(Object.freeze(entry));
  }
  return Object.freeze({ enabled: true, version: 1, directory, indexPath: indexFile.file.path, indexSha256: indexFile.file.sha256, skills: Object.freeze(skills) });
}

/** Explicit IDs take priority; auto selection adds distinct literal keyword hits. */
export async function selectSkills({ catalog, task = {}, feedback = '', config, presentation = 'full' } = {}) {
  const cfg = settings(config);
  if (!cfg.enabled) return emptySelection();
  if (!['full', 'summary'].includes(presentation)) throw new Error('Skill presentation must be full or summary');
  if (!catalog?.enabled || !Array.isArray(catalog.skills)) throw new Error('Enabled skill selection requires a loaded skill catalog');
  record(task, 'task');
  if ((task.spec !== undefined && typeof task.spec !== 'string') || typeof feedback !== 'string') throw new Error('Skill matching requires text specification and feedback');
  const explicitSource = task.skillIds !== undefined ? 'task.skillIds' : 'skills.ids';
  const explicitIds = ids(task.skillIds !== undefined ? task.skillIds : cfg.ids, explicitSource);
  const byId = new Map(catalog.skills.map(entry => [entry.id, entry]));
  // Check every explicit ID before reading any body, even when budgets are zero.
  for (const id of explicitIds) if (!byId.has(id)) throw new Error(`Unknown explicit skill ID: ${id}`);
  const candidates = explicitIds.map(id => ({ entry: byId.get(id), reason: `explicit: ${explicitSource}` }));
  if (cfg.mode === 'auto') {
    const text = normalized(`${task.spec ?? ''}\n${feedback}`);
    const explicit = new Set(explicitIds);
    const ranked = catalog.skills.filter(entry => !explicit.has(entry.id)).map((entry, order) => {
      const matches = [...new Set(entry.keywords.map(normalized))].filter(word => text.includes(word));
      return { entry, order, score: matches.length, reason: `keywords: ${matches.join(', ')}` };
    }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
    candidates.push(...ranked);
  }
  const result = emptySelection();
  const blocks = [];
  for (const candidate of candidates) {
    const { entry, reason } = candidate;
    if (result.selected.length >= cfg.maxSelected) {
      result.omitted.push({ id: entry.id, reason: 'max_selected' });
      continue;
    }
    const skill = presentation === 'full' ? await material(catalog.directory, entry.path, 'skill') : null;
    const files = skill ? [skill.file] : [{ role: 'index', path: catalog.indexPath, sha256: catalog.indexSha256 }];
    let block = `<offline-skill id="${entry.id}">\n` + (skill
      ? `${entry.description}\n\n${bodyWithoutFrontmatter(skill.text, entry.id)}` : entry.summary ?? entry.description);
    if (presentation === 'full' && cfg.includeExamples && entry.example) {
      const example = await material(catalog.directory, entry.example, 'example');
      files.push(example.file);
      block += `\n\nExample (${entry.example}):\n${fencedExample(example.text)}`;
    }
    if (presentation === 'full' && entry.reference) block += `\n\nReference (not loaded): ${entry.reference}`;
    block += '\n</offline-skill>';
    const proposed = (presentation === 'summary' ? SUMMARY_INTRO : INTRO) + [...blocks, block].join('\n\n');
    if (proposed.length > cfg.maxChars) {
      result.omitted.push({ id: entry.id, reason: 'max_chars', requiredChars: proposed.length });
      continue;
    }
    blocks.push(block);
    result.text = proposed;
    result.selected.push({ id: entry.id, sha256: hash(block), files, reason, presentation });
  }
  result.totalChars = result.text.length;
  return result;
}
