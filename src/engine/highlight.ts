export type HighlightTokenKind =
  | 'keyword'
  | 'type'
  | 'port'
  | 'number'
  | 'string'
  | 'comment'
  | 'directive'
  | 'attribute'
  | 'sysfn'
  | 'operator'
  | 'punctuation'
  | 'identifier'
  | 'plain';

export interface HighlightToken {
  kind: HighlightTokenKind;
  value: string;
}

export interface HighlightedLine {
  line: number;
  tokens: HighlightToken[];
}

const CONTROL_KEYWORDS = new Set([
  'module',
  'endmodule',
  'assign',
  'always',
  'always_comb',
  'always_ff',
  'always_latch',
  'posedge',
  'negedge',
  'or',
  'begin',
  'end',
  'if',
  'else',
  'case',
  'casez',
  'casex',
  'default',
  'endcase',
  'for',
  'while',
  'repeat',
  'forever',
  'generate',
  'endgenerate',
  'function',
  'endfunction',
  'task',
  'endtask',
  'initial',
]);

const TYPE_KEYWORDS = new Set([
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'integer',
  'int',
  'genvar',
  'signed',
  'unsigned',
  'parameter',
  'localparam',
]);

const BOARD_PORTS = new Set(['clk', 'rst_n', 'key', 'sw', 'led', 'traffic', 'seg']);

const THREE_CHAR_OPS = new Set(['===', '!==', '>>>', '<<<']);
const TWO_CHAR_OPS = new Set([
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '<<',
  '>>',
  '~&',
  '~|',
  '~^',
  '^~',
  '+:',
  '-:',
  '**',
]);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=', '?', ':', '@', '#']);
const PUNCTUATION = new Set(['(', ')', '[', ']', '{', '}', ';', ',', '.']);

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9') || ch === '$';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isBasedDigit(ch: string): boolean {
  return (
    (ch >= '0' && ch <= '9') ||
    (ch >= 'a' && ch <= 'f') ||
    (ch >= 'A' && ch <= 'F') ||
    ch === '_' ||
    ch === 'x' ||
    ch === 'X' ||
    ch === 'z' ||
    ch === 'Z' ||
    ch === '?'
  );
}

function pushToken(tokens: HighlightToken[], kind: HighlightTokenKind, value: string): void {
  if (!value) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    last.value += value;
  } else {
    tokens.push({ kind, value });
  }
}

function matchBasedLiteral(src: string, start: number): number {
  let i = start;
  while (i < src.length && (isDigit(src[i]) || src[i] === '_')) i++;
  if (src[i] !== "'") return -1;
  i++;
  if (src[i] === 's' || src[i] === 'S') i++;
  const base = src[i]?.toLowerCase();
  if (base !== 'b' && base !== 'o' && base !== 'd' && base !== 'h') return -1;
  i++;
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  const digitStart = i;
  while (i < src.length && isBasedDigit(src[i])) i++;
  return i > digitStart ? i : -1;
}

export function tokenizeVerilogForHighlight(code: string): HighlightedLine[] {
  const normalized = code.replace(/\r\n/g, '\n');
  const rawLines = normalized.split('\n');
  const result: HighlightedLine[] = [];

  let inBlockComment = false;
  let inAttribute = false;

  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const src = rawLines[lineIdx];
    const tokens: HighlightToken[] = [];
    let i = 0;
    let lastNonPlain: HighlightToken | undefined;

    const emit = (kind: HighlightTokenKind, value: string): void => {
      pushToken(tokens, kind, value);
      if (kind !== 'plain') {
        lastNonPlain = { kind, value };
      }
    };

    while (i < src.length) {
      if (inBlockComment) {
        const end = src.indexOf('*/', i);
        if (end === -1) {
          emit('comment', src.slice(i));
          i = src.length;
        } else {
          emit('comment', src.slice(i, end + 2));
          i = end + 2;
          inBlockComment = false;
        }
        continue;
      }

      if (inAttribute) {
        const end = src.indexOf('*)', i);
        if (end === -1) {
          emit('attribute', src.slice(i));
          i = src.length;
        } else {
          emit('attribute', src.slice(i, end + 2));
          i = end + 2;
          inAttribute = false;
        }
        continue;
      }

      const ch = src[i];

      if (ch === ' ' || ch === '\t' || ch === '\r') {
        const start = i;
        while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) i++;
        emit('plain', src.slice(start, i));
        continue;
      }

      if (ch === '/' && src[i + 1] === '/') {
        emit('comment', src.slice(i));
        i = src.length;
        continue;
      }

      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) {
          emit('comment', src.slice(i));
          i = src.length;
          inBlockComment = true;
        } else {
          emit('comment', src.slice(i, end + 2));
          i = end + 2;
        }
        continue;
      }

      if (
        ch === '(' &&
        src[i + 1] === '*' &&
        src[i + 2] !== ')' &&
        lastNonPlain?.value !== '@'
      ) {
        const end = src.indexOf('*)', i + 2);
        if (end === -1) {
          emit('attribute', src.slice(i));
          i = src.length;
          inAttribute = true;
        } else {
          emit('attribute', src.slice(i, end + 2));
          i = end + 2;
        }
        continue;
      }

      if (ch === '"') {
        const start = i;
        i++;
        while (i < src.length) {
          if (src[i] === '\\' && i + 1 < src.length) {
            i += 2;
            continue;
          }
          if (src[i] === '"') {
            i++;
            break;
          }
          i++;
        }
        emit('string', src.slice(start, i));
        continue;
      }

      if (ch === '`') {
        const start = i;
        i++;
        while (i < src.length && isIdentPart(src[i])) i++;
        emit('directive', src.slice(start, i));
        continue;
      }

      if (ch === '$' && i + 1 < src.length && isIdentStart(src[i + 1])) {
        const start = i;
        i++;
        while (i < src.length && isIdentPart(src[i])) i++;
        emit('sysfn', src.slice(start, i));
        continue;
      }

      if (isDigit(ch) || ch === "'") {
        const basedEnd = matchBasedLiteral(src, i);
        if (basedEnd !== -1) {
          emit('number', src.slice(i, basedEnd));
          i = basedEnd;
          continue;
        }
        if (isDigit(ch)) {
          const start = i;
          while (i < src.length && (isDigit(src[i]) || src[i] === '_')) i++;
          emit('number', src.slice(start, i));
          continue;
        }
      }

      if (isIdentStart(ch)) {
        const start = i;
        while (i < src.length && isIdentPart(src[i])) i++;
        const word = src.slice(start, i);
        if (CONTROL_KEYWORDS.has(word)) {
          emit('keyword', word);
        } else if (TYPE_KEYWORDS.has(word)) {
          emit('type', word);
        } else if (BOARD_PORTS.has(word)) {
          emit('port', word);
        } else {
          emit('identifier', word);
        }
        continue;
      }

      const three = src.slice(i, i + 3);
      if (THREE_CHAR_OPS.has(three)) {
        emit('operator', three);
        i += 3;
        continue;
      }

      const two = src.slice(i, i + 2);
      if (TWO_CHAR_OPS.has(two)) {
        emit('operator', two);
        i += 2;
        continue;
      }

      if (ONE_CHAR_OPS.has(ch)) {
        emit('operator', ch);
        i++;
        continue;
      }

      if (PUNCTUATION.has(ch)) {
        emit('punctuation', ch);
        i++;
        continue;
      }

      emit('plain', ch);
      i++;
    }

    result.push({ line: lineIdx + 1, tokens });
  }

  return result;
}
