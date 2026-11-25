import type { LintIssue } from '../types/contracts';
import type {
  AlwaysBlock,
  AssignStmt,
  BinaryOp,
  CaseItem,
  Expr,
  LValue,
  ModuleAst,
  ParamDecl,
  PortDecl,
  PortDirection,
  RangeSpec,
  SignalDecl,
  SignalKind,
  SourceLoc,
  Stmt,
  UnaryOp,
} from './ast';

type TokenKind =
  | 'ident'
  | 'sysfn'
  | 'number'
  | 'keyword'
  | 'op'
  | 'punct'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  loc: SourceLoc;
  numInfo?: {
    value: number;
    width: number;
    sized: boolean;
    signed: boolean;
  };
}

const KEYWORDS = new Set([
  'module',
  'endmodule',
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'signed',
  'unsigned',
  'parameter',
  'localparam',
  'assign',
  'always',
  'always_comb',
  'always_ff',
  'posedge',
  'negedge',
  'or',
  'begin',
  'end',
  'if',
  'else',
  'case',
  'casez',
  'default',
  'endcase',
]);

class ParseError extends Error {
  readonly issue: LintIssue;

  constructor(loc: SourceLoc, message: string, hint: string) {
    super(message);
    this.issue = {
      code: 'PARSE_ERROR',
      severity: 'error',
      line: loc.line,
      column: loc.column,
      message,
      hint,
    };
  }
}

export interface ParseResult {
  ast?: ModuleAst;
  errors: LintIssue[];
}

function parseBasedLiteral(
  widthStr: string | null,
  baseSpec: string,
  digitsRaw: string,
  loc: SourceLoc
): { value: number; width: number; sized: boolean; signed: boolean } {
  let signed = false;
  let baseChar = baseSpec.toLowerCase();
  if (baseChar.startsWith('s')) {
    signed = true;
    baseChar = baseChar.slice(1);
  }

  let radix: number;
  let validRe: RegExp;
  let baseLabel: string;
  switch (baseChar) {
    case 'b':
      radix = 2;
      validRe = /^[01_]+$/;
      baseLabel = '二进制';
      break;
    case 'o':
      radix = 8;
      validRe = /^[0-7_]+$/;
      baseLabel = '八进制';
      break;
    case 'd':
      radix = 10;
      validRe = /^[0-9_]+$/;
      baseLabel = '十进制';
      break;
    case 'h':
      radix = 16;
      validRe = /^[0-9a-fA-F_]+$/;
      baseLabel = '十六进制';
      break;
    default:
      throw new ParseError(
        loc,
        `第 ${loc.line} 行不支持的数字进制标识 "'${baseSpec}"`,
        '请使用合法的 Verilog 进制：\'b(二进制)、\'o(八进制)、\'d(十进制) 或 \'h(十六进制)。'
      );
  }

  const cleaned = digitsRaw.replace(/_/g, '');
  if (cleaned.length === 0 || !validRe.test(digitsRaw)) {
    throw new ParseError(
      loc,
      `第 ${loc.line} 行${baseLabel}字面量 "${digitsRaw}" 包含非法数字字符`,
      `当前仿真引擎仅支持二值逻辑（不支持 x/z），请检查${baseLabel}数字拼写。`
    );
  }

  const parsed = Number.parseInt(cleaned, radix);
  if (!Number.isFinite(parsed)) {
    throw new ParseError(
      loc,
      `第 ${loc.line} 行数字字面量超出可表示范围`,
      '请将字面量位宽控制在 32 位以内。'
    );
  }

  const sized = widthStr !== null;
  const width = sized ? Number.parseInt(widthStr, 10) : 32;
  if (sized && (width <= 0 || width > 32)) {
    throw new ParseError(
      loc,
      `第 ${loc.line} 行字面量位宽 ${width} 不合法`,
      '教学仿真子集支持的位宽范围为 1 到 32 位。'
    );
  }

  const masked = maskValue(parsed, width);
  return { value: masked, width, sized, signed };
}

function maskValue(value: number, width: number): number {
  if (width >= 32) return value >>> 0;
  return (value >>> 0) & ((1 << width) - 1);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const len = source.length;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < len) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < len && source[i] !== '\n') advance();
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const startLoc: SourceLoc = { line, column: col };
      advance(2);
      let closed = false;
      while (i < len) {
        if (source[i] === '*' && source[i + 1] === '/') {
          advance(2);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        throw new ParseError(
          startLoc,
          `第 ${startLoc.line} 行多行注释 "/*" 未闭合`,
          '请在注释结尾补上 "*/"。'
        );
      }
      continue;
    }

    if (ch === '`') {
      while (i < len && source[i] !== '\n') advance();
      continue;
    }

    const loc: SourceLoc = { line, column: col };

    if (ch === '$') {
      let end = i + 1;
      while (end < len && /[a-zA-Z0-9_]/.test(source[end])) end++;
      const name = source.slice(i, end);
      advance(end - i);
      tokens.push({ kind: 'sysfn', value: name, loc });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let end = i + 1;
      while (end < len && /[a-zA-Z0-9_$]/.test(source[end])) end++;
      const word = source.slice(i, end);
      advance(end - i);
      tokens.push({
        kind: KEYWORDS.has(word) ? 'keyword' : 'ident',
        value: word,
        loc,
      });
      continue;
    }

    if (ch === "'" || /[0-9]/.test(ch)) {
      const start = i;
      let widthStr: string | null = null;
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < len && /[0-9_]/.test(source[j])) j++;
        const intPart = source.slice(i, j);
        let k = j;
        while (k < len && (source[k] === ' ' || source[k] === '\t')) k++;
        if (k < len && source[k] === "'") {
          widthStr = intPart.replace(/_/g, '');
          advance(k - i);
        } else {
          const val = Number.parseInt(intPart.replace(/_/g, ''), 10);
          advance(j - i);
          tokens.push({
            kind: 'number',
            value: intPart,
            loc,
            numInfo: { value: val >>> 0, width: 32, sized: false, signed: true },
          });
          continue;
        }
      }

      if (source[i] === "'") {
        advance();
        if (widthStr === null && (source[i] === '0' || source[i] === '1') && !/[a-zA-Z0-9_]/.test(source[i + 1] ?? '')) {
          const bit = source[i] === '1' ? 1 : 0;
          advance();
          tokens.push({
            kind: 'number',
            value: `'${bit}`,
            loc,
            numInfo: { value: bit, width: 1, sized: false, signed: false },
          });
          continue;
        }

        let baseSpec = '';
        if (i < len && (source[i] === 's' || source[i] === 'S')) {
          baseSpec += source[i];
          advance();
        }
        if (i < len && /[bBoOdDhH]/.test(source[i])) {
          baseSpec += source[i];
          advance();
        } else {
          throw new ParseError(
            loc,
            `第 ${loc.line} 行单引号 "'" 后缺少进制标识`,
            '请写成如 4\'b1010、8\'hFF 或 3\'d5 的格式。'
          );
        }

        while (i < len && (source[i] === ' ' || source[i] === '\t')) advance();
        const digStart = i;
        while (i < len && /[0-9a-fA-FxXzZ?_]/.test(source[i])) advance();
        const digitsRaw = source.slice(digStart, i);
        const raw = source.slice(start, i);
        const numInfo = parseBasedLiteral(widthStr, baseSpec, digitsRaw, loc);
        tokens.push({ kind: 'number', value: raw, loc, numInfo });
        continue;
      }
    }

    const three = source.slice(i, i + 3);
    if (three === '<<<' || three === '>>>') {
      advance(3);
      tokens.push({ kind: 'op', value: three, loc });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (
      two === '<=' ||
      two === '>=' ||
      two === '==' ||
      two === '!=' ||
      two === '&&' ||
      two === '||' ||
      two === '<<' ||
      two === '>>'
    ) {
      advance(2);
      tokens.push({ kind: 'op', value: two, loc });
      continue;
    }

    if ('()[]{},;:?@#'.includes(ch)) {
      advance();
      tokens.push({ kind: 'punct', value: ch, loc });
      continue;
    }

    if ('+-*/%&|^~!<>='.includes(ch)) {
      advance();
      tokens.push({ kind: 'op', value: ch, loc });
      continue;
    }

    throw new ParseError(
      loc,
      `第 ${loc.line} 行第 ${loc.column} 列出现无法识别的字符 "${ch}"`,
      '请检查是否误输入了中文标点或不支持的符号。'
    );
  }

  tokens.push({ kind: 'eof', value: '', loc: { line, column: col } });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const tok = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return tok;
  }

  private check(kind: TokenKind, value?: string): boolean {
    const t = this.peek();
    if (t.kind !== kind) return false;
    return value === undefined || t.value === value;
  }

  private match(kind: TokenKind, value?: string): Token | null {
    if (this.check(kind, value)) return this.next();
    return null;
  }

  private expect(kind: TokenKind, value: string | undefined, hint: string): Token {
    const t = this.peek();
    if (t.kind === kind && (value === undefined || t.value === value)) {
      return this.next();
    }
    const expectedDesc = value ? `"${value}"` : kind;
    const actualDesc = t.kind === 'eof' ? '文件末尾' : `"${t.value}"`;
    throw new ParseError(
      t.loc,
      `第 ${t.loc.line} 行期望出现 ${expectedDesc}，但遇到了 ${actualDesc}`,
      hint
    );
  }

  parseModule(): ModuleAst {
    const modTok = this.expect(
      'keyword',
      'module',
      '代码顶层必须包含 "module top (...);" 定义。'
    );
    const nameTok = this.expect(
      'ident',
      undefined,
      'module 关键字后需要紧跟模块名（例如 module top）。'
    );

    const params: ParamDecl[] = [];
    const ports: PortDecl[] = [];
    const signals: SignalDecl[] = [];
    const assigns: AssignStmt[] = [];
    const alwaysBlocks: AlwaysBlock[] = [];

    if (this.match('punct', '#')) {
      this.expect('punct', '(', '参数列表 #( ... ) 缺少左括号 "("。');
      while (!this.check('punct', ')') && !this.check('eof')) {
        this.match('keyword', 'parameter');
        const signed = Boolean(this.match('keyword', 'signed'));
        const range = this.parseOptionalRange();
        const pName = this.expect('ident', undefined, '参数声明缺少名称。');
        this.expect('op', '=', `参数 ${pName.value} 缺少 "=" 初始值。`);
        const value = this.parseExpr();
        params.push({ name: pName.value, isLocal: false, signed, range, value, loc: pName.loc });
        if (!this.match('punct', ',')) break;
      }
      this.expect('punct', ')', '参数列表 #( ... ) 缺少右括号 ")"。');
    }

    if (this.match('punct', '(')) {
      this.parsePortList(ports);
      this.expect('punct', ')', '模块端口列表缺少右括号 ")"。');
    }

    this.expect('punct', ';', '模块头部声明末尾缺少分号 ";"。');

    while (!this.check('keyword', 'endmodule') && !this.check('eof')) {
      const tok = this.peek();
      if (tok.kind === 'keyword' && (tok.value === 'parameter' || tok.value === 'localparam')) {
        this.parseParamDecls(params);
      } else if (
        tok.kind === 'keyword' &&
        (tok.value === 'input' ||
          tok.value === 'output' ||
          tok.value === 'wire' ||
          tok.value === 'reg' ||
          tok.value === 'logic')
      ) {
        this.parseSignalDecls(signals);
      } else if (tok.kind === 'keyword' && tok.value === 'assign') {
        assigns.push(this.parseAssignStmt());
      } else if (
        tok.kind === 'keyword' &&
        (tok.value === 'always' || tok.value === 'always_comb' || tok.value === 'always_ff')
      ) {
        alwaysBlocks.push(this.parseAlwaysBlock());
      } else if (this.match('punct', ';')) {
        continue;
      } else {
        throw new ParseError(
          tok.loc,
          `第 ${tok.loc.line} 行模块体内出现无法解析的语句起点 "${tok.value}"`,
          '模块体内仅支持 parameter/localparam、端口与 wire/reg 声明、assign 及 always 块。'
        );
      }
    }

    this.expect('keyword', 'endmodule', '模块定义末尾缺少 "endmodule" 关键字。');

    return {
      name: nameTok.value,
      ports,
      params,
      signals,
      assigns,
      alwaysBlocks,
      loc: modTok.loc,
    };
  }

  private parsePortList(ports: PortDecl[]): void {
    if (this.check('punct', ')')) return;

    let currentDir: PortDirection | undefined;
    let currentKind: SignalKind | undefined;
    let currentSigned = false;
    let currentRange: RangeSpec | null = null;

    while (!this.check('punct', ')') && !this.check('eof')) {
      const startLoc = this.peek().loc;
      let hasHeaderAttr = false;

      if (this.check('keyword', 'input') || this.check('keyword', 'output')) {
        currentDir = this.next().value as PortDirection;
        currentKind = undefined;
        currentSigned = false;
        currentRange = null;
        hasHeaderAttr = true;
      }

      if (this.check('keyword', 'wire') || this.check('keyword', 'reg') || this.check('keyword', 'logic')) {
        const k = this.next().value;
        currentKind = k === 'wire' ? 'wire' : 'reg';
        hasHeaderAttr = true;
      }

      if (this.match('keyword', 'signed')) {
        currentSigned = true;
        hasHeaderAttr = true;
      } else if (this.match('keyword', 'unsigned')) {
        currentSigned = false;
        hasHeaderAttr = true;
      }

      const range = this.parseOptionalRange();
      if (range !== null) {
        currentRange = range;
        hasHeaderAttr = true;
      }

      const nameTok = this.expect(
        'ident',
        undefined,
        '端口列表中缺少端口名，或多余的逗号。'
      );

      ports.push({
        name: nameTok.value,
        direction: currentDir,
        kind: currentKind ?? (currentDir ? 'wire' : undefined),
        signed: currentSigned,
        range: currentRange,
        loc: hasHeaderAttr ? startLoc : nameTok.loc,
      });

      if (!this.match('punct', ',')) break;
    }
  }

  private parseOptionalRange(): RangeSpec | null {
    if (!this.match('punct', '[')) return null;
    const msb = this.parseExpr();
    this.expect('punct', ':', '位宽声明 [msb:lsb] 缺少冒号 ":"。');
    const lsb = this.parseExpr();
    this.expect('punct', ']', '位宽声明 [msb:lsb] 缺少右中括号 "]"。');
    return { msb, lsb };
  }

  private parseParamDecls(params: ParamDecl[]): void {
    const kw = this.next();
    const isLocal = kw.value === 'localparam';
    const signed = Boolean(this.match('keyword', 'signed'));
    const range = this.parseOptionalRange();

    while (true) {
      const nameTok = this.expect('ident', undefined, `${kw.value} 声明缺少参数名称。`);
      this.expect('op', '=', `${kw.value} ${nameTok.value} 缺少 "=" 赋值。`);
      const value = this.parseExpr();
      params.push({
        name: nameTok.value,
        isLocal,
        signed,
        range,
        value,
        loc: nameTok.loc,
      });
      if (!this.match('punct', ',')) break;
    }

    this.expect('punct', ';', `${kw.value} 声明末尾缺少分号 ";"。`);
  }

  private parseSignalDecls(signals: SignalDecl[]): void {
    const startLoc = this.peek().loc;
    let direction: PortDirection | undefined;
    let kind: SignalKind = 'wire';
    let explicitKind = false;

    if (this.check('keyword', 'input') || this.check('keyword', 'output')) {
      direction = this.next().value as PortDirection;
    }

    if (this.check('keyword', 'wire') || this.check('keyword', 'reg') || this.check('keyword', 'logic')) {
      const k = this.next().value;
      kind = k === 'wire' ? 'wire' : 'reg';
      explicitKind = true;
    }

    const signed = Boolean(this.match('keyword', 'signed'));
    this.match('keyword', 'unsigned');
    const range = this.parseOptionalRange();

    while (true) {
      const nameTok = this.expect('ident', undefined, '信号声明缺少标识符名称。');
      let init: Expr | undefined;
      if (this.match('op', '=')) {
        init = this.parseExpr();
      }
      signals.push({
        name: nameTok.value,
        direction,
        kind: explicitKind ? kind : 'wire',
        signed,
        range,
        init,
        loc: startLoc,
      });
      if (!this.match('punct', ',')) break;
    }

    this.expect('punct', ';', '信号声明末尾缺少分号 ";"。');
  }

  private parseAssignStmt(): AssignStmt {
    const kw = this.expect('keyword', 'assign', '缺少 assign 关键字。');
    const target = this.parseLValue();
    this.expect('op', '=', 'assign 连续赋值语句必须使用 "="。');
    const value = this.parseExpr();
    this.expect('punct', ';', 'assign 语句末尾缺少分号 ";"。');
    return { target, value, loc: kw.loc };
  }

  private parseAlwaysBlock(): AlwaysBlock {
    const kw = this.next();
    let sensitivity: 'comb' | 'seq' = 'comb';
    let hasAsyncReset = false;
    let resetSignal: string | undefined;
    let resetActiveLow: boolean | undefined;
    let clockSignal: string | undefined;
    let clockFalling: boolean | undefined;

    if (kw.value === 'always_comb') {
      sensitivity = 'comb';
    } else {
      this.expect('punct', '@', `${kw.value} 后缺少敏感列表 "@"`);
      if (this.match('op', '*')) {
        sensitivity = 'comb';
      } else {
        this.expect('punct', '(', 'always @ 后缺少 "(" 或 "*"。');
        if (this.match('op', '*')) {
          sensitivity = 'comb';
        } else {
          const items: Array<{ edge?: 'posedge' | 'negedge'; name: string }> = [];
          while (!this.check('punct', ')') && !this.check('eof')) {
            let edge: 'posedge' | 'negedge' | undefined;
            if (this.check('keyword', 'posedge') || this.check('keyword', 'negedge')) {
              edge = this.next().value as 'posedge' | 'negedge';
            }
            const sig = this.expect('ident', undefined, '敏感列表中缺少信号名。');
            items.push({ edge, name: sig.value });
            if (this.match('keyword', 'or') || this.match('punct', ',')) {
              continue;
            }
            break;
          }
          const clock = items.find((it) => it.edge && it.name === 'clk') ?? items.find((it) => it.edge);
          if (clock) {
            sensitivity = 'seq';
            clockSignal = clock.name;
            clockFalling = clock.edge === 'negedge';
            const rstItem = items.find((it) => it.edge && it.name !== clock.name);
            if (rstItem) {
              hasAsyncReset = true;
              resetSignal = rstItem.name;
              resetActiveLow = rstItem.edge === 'negedge';
            }
          } else {
            sensitivity = 'comb';
          }
        }
        this.expect('punct', ')', 'always 敏感列表缺少右括号 ")"。');
      }
    }

    const body = this.parseStmt();
    return {
      sensitivity,
      clockSignal,
      clockFalling,
      hasAsyncReset,
      resetSignal,
      resetActiveLow,
      body,
      loc: kw.loc,
    };
  }

  private parseStmt(): Stmt {
    const tok = this.peek();

    if (this.match('punct', ';')) {
      return { type: 'empty', loc: tok.loc };
    }

    if (this.match('keyword', 'begin')) {
      if (this.match('punct', ':')) {
        this.expect('ident', undefined, '命名块 begin : 后缺少块名称。');
      }
      const statements: Stmt[] = [];
      while (!this.check('keyword', 'end') && !this.check('eof')) {
        statements.push(this.parseStmt());
      }
      this.expect('keyword', 'end', `第 ${tok.loc.line} 行的 begin 块缺少对应的 "end"。`);
      return { type: 'block', statements, loc: tok.loc };
    }

    if (this.match('keyword', 'if')) {
      this.expect('punct', '(', 'if 语句条件缺少左括号 "("。');
      const condition = this.parseExpr();
      this.expect('punct', ')', 'if 语句条件缺少右括号 ")"。');
      const thenBranch = this.parseStmt();
      let elseBranch: Stmt | undefined;
      if (this.match('keyword', 'else')) {
        elseBranch = this.parseStmt();
      }
      return { type: 'if', condition, thenBranch, elseBranch, loc: tok.loc };
    }

    if (this.check('keyword', 'case') || this.check('keyword', 'casez')) {
      const kind = this.next().value as 'case' | 'casez';
      this.expect('punct', '(', `${kind} 语句缺少左括号 "("。`);
      const expr = this.parseExpr();
      this.expect('punct', ')', `${kind} 语句缺少右括号 ")"。`);

      const items: CaseItem[] = [];
      let defaultBranch: Stmt | undefined;

      while (!this.check('keyword', 'endcase') && !this.check('eof')) {
        if (this.match('keyword', 'default')) {
          this.match('punct', ':');
          defaultBranch = this.parseStmt();
        } else {
          const itemLoc = this.peek().loc;
          const patterns: Expr[] = [this.parseExpr()];
          while (this.match('punct', ',')) {
            patterns.push(this.parseExpr());
          }
          this.expect('punct', ':', 'case 分支标签后缺少冒号 ":"。');
          const body = this.parseStmt();
          items.push({ patterns, body, loc: itemLoc });
        }
      }

      this.expect('keyword', 'endcase', `第 ${tok.loc.line} 行的 ${kind} 缺少对应的 "endcase"。`);
      return { type: 'case', kind, expr, items, defaultBranch, loc: tok.loc };
    }

    if (tok.kind === 'ident' || (tok.kind === 'punct' && tok.value === '{')) {
      const target = this.parseLValue();
      const opTok = this.peek();
      if (opTok.kind === 'op' && (opTok.value === '=' || opTok.value === '<=')) {
        this.next();
        const value = this.parseExpr();
        this.expect('punct', ';', `第 ${opTok.loc.line} 行赋值语句末尾缺少分号 ";"。`);
        return {
          type: 'assign',
          kind: opTok.value === '<=' ? 'nonblocking' : 'blocking',
          target,
          value,
          loc: opTok.loc,
        };
      }
      throw new ParseError(
        opTok.loc,
        `第 ${opTok.loc.line} 行期望赋值运算符 "=" 或 "<="，但遇到了 "${opTok.value || '文件末尾'}"`,
        '请检查赋值语句写法，时序块使用 "<="，组合块使用 "="。'
      );
    }

    throw new ParseError(
      tok.loc,
      `第 ${tok.loc.line} 行无法解析语句 "${tok.value || '文件末尾'}"`,
      '请检查是否缺少分号、end 或使用了不支持的语法。'
    );
  }

  private parseLValue(): LValue {
    const tok = this.peek();
    if (this.match('punct', '{')) {
      const items: LValue[] = [this.parseLValue()];
      while (this.match('punct', ',')) {
        items.push(this.parseLValue());
      }
      this.expect('punct', '}', '左值位拼接缺少右花括号 "}"。');
      return { type: 'concat', items, loc: tok.loc };
    }

    const id = this.expect('ident', undefined, '赋值左侧必须是信号名或位拼接。');
    if (this.match('punct', '[')) {
      const first = this.parseExpr();
      if (this.match('punct', ':')) {
        const lsb = this.parseExpr();
        this.expect('punct', ']', '位切片缺少右中括号 "]"。');
        return { type: 'slice', name: id.value, msb: first, lsb, loc: id.loc };
      }
      this.expect('punct', ']', '位选择缺少右中括号 "]"。');
      return { type: 'index', name: id.value, index: first, loc: id.loc };
    }

    return { type: 'ident', name: id.value, loc: id.loc };
  }

  private parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const cond = this.parseLogicalOr();
    if (this.match('punct', '?')) {
      const thenExpr = this.parseExpr();
      this.expect('punct', ':', '三目运算符 "? :" 缺少冒号 ":"。');
      const elseExpr = this.parseTernary();
      return { type: 'ternary', condition: cond, thenExpr, elseExpr, loc: cond.loc };
    }
    return cond;
  }

  private parseLogicalOr(): Expr {
    let left = this.parseLogicalAnd();
    while (this.match('op', '||')) {
      const right = this.parseLogicalAnd();
      left = { type: 'binary', op: '||', left, right, loc: left.loc };
    }
    return left;
  }

  private parseLogicalAnd(): Expr {
    let left = this.parseBitOr();
    while (this.match('op', '&&')) {
      const right = this.parseBitOr();
      left = { type: 'binary', op: '&&', left, right, loc: left.loc };
    }
    return left;
  }

  private parseBitOr(): Expr {
    let left = this.parseBitXor();
    while (this.match('op', '|')) {
      const right = this.parseBitXor();
      left = { type: 'binary', op: '|', left, right, loc: left.loc };
    }
    return left;
  }

  private parseBitXor(): Expr {
    let left = this.parseBitAnd();
    while (this.match('op', '^')) {
      const right = this.parseBitAnd();
      left = { type: 'binary', op: '^', left, right, loc: left.loc };
    }
    return left;
  }

  private parseBitAnd(): Expr {
    let left = this.parseEquality();
    while (this.match('op', '&')) {
      const right = this.parseEquality();
      left = { type: 'binary', op: '&', left, right, loc: left.loc };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseRelational();
    while (this.check('op', '==') || this.check('op', '!=')) {
      const op = this.next().value as BinaryOp;
      const right = this.parseRelational();
      left = { type: 'binary', op, left, right, loc: left.loc };
    }
    return left;
  }

  private parseRelational(): Expr {
    let left = this.parseShift();
    while (
      this.check('op', '<') ||
      this.check('op', '<=') ||
      this.check('op', '>') ||
      this.check('op', '>=')
    ) {
      const op = this.next().value as BinaryOp;
      const right = this.parseShift();
      left = { type: 'binary', op, left, right, loc: left.loc };
    }
    return left;
  }

  private parseShift(): Expr {
    let left = this.parseAddSub();
    while (
      this.check('op', '<<') ||
      this.check('op', '>>') ||
      this.check('op', '<<<') ||
      this.check('op', '>>>')
    ) {
      const op = this.next().value as BinaryOp;
      const right = this.parseAddSub();
      left = { type: 'binary', op, left, right, loc: left.loc };
    }
    return left;
  }

  private parseAddSub(): Expr {
    let left = this.parseMulDiv();
    while (this.check('op', '+') || this.check('op', '-')) {
      const op = this.next().value as BinaryOp;
      const right = this.parseMulDiv();
      left = { type: 'binary', op, left, right, loc: left.loc };
    }
    return left;
  }

  private parseMulDiv(): Expr {
    let left = this.parseUnary();
    while (this.check('op', '*') || this.check('op', '/') || this.check('op', '%')) {
      const op = this.next().value as BinaryOp;
      const right = this.parseUnary();
      left = { type: 'binary', op, left, right, loc: left.loc };
    }
    return left;
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (
      tok.kind === 'op' &&
      (tok.value === '~' ||
        tok.value === '!' ||
        tok.value === '&' ||
        tok.value === '|' ||
        tok.value === '^' ||
        tok.value === '-' ||
        tok.value === '+')
    ) {
      this.next();
      const operand = this.parseUnary();
      return { type: 'unary', op: tok.value as UnaryOp, operand, loc: tok.loc };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (this.match('punct', '[')) {
      const first = this.parseExpr();
      if (this.match('punct', ':')) {
        const lsb = this.parseExpr();
        this.expect('punct', ']', '位切片表达式缺少右中括号 "]"。');
        expr = { type: 'slice', target: expr, msb: first, lsb, loc: expr.loc };
      } else {
        this.expect('punct', ']', '位选择表达式缺少右中括号 "]"。');
        expr = { type: 'index', target: expr, index: first, loc: expr.loc };
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const tok = this.peek();

    if (tok.kind === 'number' && tok.numInfo) {
      this.next();
      return {
        type: 'number',
        value: tok.numInfo.value,
        width: tok.numInfo.width,
        sized: tok.numInfo.sized,
        signed: tok.numInfo.signed,
        raw: tok.value,
        loc: tok.loc,
      };
    }

    if (tok.kind === 'ident') {
      this.next();
      return { type: 'ident', name: tok.value, loc: tok.loc };
    }

    if (tok.kind === 'sysfn') {
      this.next();
      if (tok.value !== '$signed' && tok.value !== '$unsigned') {
        throw new ParseError(
          tok.loc,
          `第 ${tok.loc.line} 行不支持系统函数 "${tok.value}"`,
          '可综合教学子集仅支持 $signed(...) 和 $unsigned(...)。'
        );
      }
      this.expect('punct', '(', `${tok.value} 缺少左括号 "("。`);
      const arg = this.parseExpr();
      this.expect('punct', ')', `${tok.value} 缺少右括号 ")"。`);
      return { type: 'sysfn', name: tok.value, arg, loc: tok.loc };
    }

    if (this.match('punct', '(')) {
      const inner = this.parseExpr();
      this.expect('punct', ')', `第 ${tok.loc.line} 行括号表达式缺少右括号 ")"。`);
      return inner;
    }

    if (this.match('punct', '{')) {
      const first = this.parseExpr();
      if (this.match('punct', '{')) {
        const items: Expr[] = [this.parseExpr()];
        while (this.match('punct', ',')) {
          items.push(this.parseExpr());
        }
        this.expect('punct', '}', '位复制表达式内层缺少 "}"。');
        this.expect('punct', '}', '位复制表达式外层缺少 "}"。');
        return { type: 'repeat', count: first, items, loc: tok.loc };
      }
      const items: Expr[] = [first];
      while (this.match('punct', ',')) {
        items.push(this.parseExpr());
      }
      this.expect('punct', '}', `第 ${tok.loc.line} 行位拼接缺少右花括号 "}"。`);
      return { type: 'concat', items, loc: tok.loc };
    }

    throw new ParseError(
      tok.loc,
      `第 ${tok.loc.line} 行表达式中遇到意外符号 "${tok.value || '文件末尾'}"`,
      '请检查运算符两侧是否缺少操作数或存在多余符号。'
    );
  }
}

export function parseVerilog(code: string): ParseResult {
  try {
    const tokens = tokenize(code);
    const parser = new Parser(tokens);
    const ast = parser.parseModule();
    return { ast, errors: [] };
  } catch (err) {
    if (err instanceof ParseError) {
      return { errors: [err.issue] };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      errors: [
        {
          code: 'PARSE_ERROR',
          severity: 'error',
          line: 1,
          message: `解析失败：${msg}`,
          hint: '请检查 Verilog 语法是否正确。',
        },
      ],
    };
  }
}
