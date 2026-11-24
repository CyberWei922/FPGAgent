import { createHash, randomUUID } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value, typeof value === 'string' ? 'utf8' : undefined).digest('hex');
export const id = prefix => `${prefix}.${randomUUID()}`;
export class DualError extends Error {
  constructor(code, message = code) { super(message); this.name = 'DualError'; this.code = code; }
}
export function invariant(condition, code, message) { if (!condition) throw new DualError(code, message); }
export function utf8(text) {
  invariant(typeof text === 'string' && !text.startsWith('\uFEFF') && text.isWellFormed(), 'OUTPUT_INVALID', 'Expected well-formed UTF-8 without BOM');
  return Buffer.from(text, 'utf8');
}
export function sliceBytes(text, start, end) {
  const bytes = utf8(text);
  invariant(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= bytes.length,
    'PATCH_SCOPE_VIOLATION', 'Invalid byte range');
  invariant((start === 0 || (bytes[start] & 0xc0) !== 0x80) && (end === bytes.length || (bytes[end] & 0xc0) !== 0x80),
    'PATCH_SCOPE_VIOLATION', 'Range splits a UTF-8 character');
  return bytes.subarray(start, end).toString('utf8');
}
export function snapshot(rtl, parent = null) {
  utf8(rtl);
  invariant(rtl.length > 0 && rtl.length <= 131072, 'OUTPUT_INVALID', 'Candidate exceeds protocol limit');
  return Object.freeze({ id: id('candidate'), sha256: sha256(rtl), rtl, parent_id: parent?.id ?? null });
}
