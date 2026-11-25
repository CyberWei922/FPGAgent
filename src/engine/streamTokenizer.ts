import { tokenizeVerilogForHighlight } from './highlight';

export interface PartialJsonStringResult {
  value: string;
  complete: boolean;
}

/**
 * Incrementally extracts a string field (such as `"code"`) from a streaming JSON payload.
 * Stops cleanly before any incomplete trailing escape sequence so callers never see broken text.
 */
export function extractPartialJsonStringField(
  raw: string,
  fieldName: string,
): PartialJsonStringResult | null {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const match = pattern.exec(raw);
  if (match) {
    let i = match.index + match[0].length;
    let out = '';
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '"') {
        return { value: out, complete: true };
      }
      if (ch === '\\') {
        if (i + 1 >= raw.length) break;
        const next = raw[i + 1];
        if (next === 'n') {
          out += '\n';
          i += 2;
        } else if (next === 'r') {
          i += 2;
        } else if (next === 't') {
          out += '\t';
          i += 2;
        } else if (next === '"' || next === '\\' || next === '/') {
          out += next;
          i += 2;
        } else if (next === 'b') {
          out += '\b';
          i += 2;
        } else if (next === 'f') {
          out += '\f';
          i += 2;
        } else if (next === 'u') {
          if (i + 6 > raw.length) break;
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
          }
          i += 6;
        } else {
          out += next;
          i += 2;
        }
        continue;
      }
      out += ch;
      i += 1;
    }
    return { value: out, complete: false };
  }

  // Fallback when a model streams a fenced verilog block instead of JSON.
  const fenceMatch = /```(?:systemverilog|verilog|sv|v)\s*\r?\n/i.exec(raw);
  if (fenceMatch) {
    const start = fenceMatch.index + fenceMatch[0].length;
    const rest = raw.slice(start);
    const closeIdx = rest.indexOf('```');
    if (closeIdx !== -1) {
      return { value: rest.slice(0, closeIdx).replace(/\r\n/g, '\n'), complete: true };
    }
    return { value: rest.replace(/\r\n/g, '\n'), complete: false };
  }

  return null;
}

const UNSAFE_TAIL_CHAR = /[A-Za-z0-9_$'`<>=!&|^~+\-*/]/;

/**
 * Trims any incomplete trailing lexical unit (partial keyword, identifier, based literal,
 * or multi-char operator) so incremental syntax highlighting never flickers mid-token.
 */
export function extractSafeVerilogPrefix(code: string, isFinal = false): string {
  if (isFinal || !code) return code;
  const normalized = code.replace(/\r\n/g, '\n');
  const lastNewline = normalized.lastIndexOf('\n');
  const tailLine = normalized.slice(lastNewline + 1);

  const commentIdx = tailLine.indexOf('//');
  if (commentIdx !== -1 && commentIdx < tailLine.length - 1) {
    let end = normalized.length;
    while (end > lastNewline + 1 + commentIdx + 2 && /[A-Za-z0-9_']/.test(normalized[end - 1])) {
      end -= 1;
    }
    return normalized.slice(0, end);
  }

  let end = normalized.length;
  while (end > 0 && UNSAFE_TAIL_CHAR.test(normalized[end - 1])) {
    end -= 1;
  }
  return normalized.slice(0, end);
}

/**
 * Returns monotonically increasing end offsets aligned to complete Verilog highlight tokens.
 * Adjacent whitespace is grouped with the next visible token so every frame makes visible progress.
 */
export function collectVerilogTokenBoundaries(code: string): number[] {
  const normalized = code.replace(/\r\n/g, '\n');
  if (!normalized) return [];
  const lines = tokenizeVerilogForHighlight(normalized);
  const boundaries: number[] = [];
  let offset = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const row = lines[lineIdx];
    for (const token of row.tokens) {
      offset += token.value.length;
      if (token.kind === 'plain') continue;
      if (token.kind === 'comment' && token.value.length > 14) {
        // Reveal longer comments in natural chunks instead of jumping a full line at once.
        const start = offset - token.value.length;
        const step = 6;
        for (let pos = start + step; pos < offset; pos += step) {
          boundaries.push(pos);
        }
      }
      boundaries.push(offset);
    }
    if (lineIdx < lines.length - 1) {
      offset += 1; // '\n'
      if (boundaries[boundaries.length - 1] !== offset) {
        boundaries.push(offset);
      }
    }
  }

  if (boundaries[boundaries.length - 1] !== normalized.length) {
    boundaries.push(normalized.length);
  }
  return boundaries;
}
