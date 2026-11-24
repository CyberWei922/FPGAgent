export interface SourceLoc {
  line: number;
  column: number;
}

export type PortDirection = 'input' | 'output';
export type SignalKind = 'wire' | 'reg';
export type AssignKind = 'blocking' | 'nonblocking';

export interface RangeSpec {
  msb: Expr;
  lsb: Expr;
}

export interface PortDecl {
  name: string;
  direction?: PortDirection;
  kind?: SignalKind;
  signed: boolean;
  range: RangeSpec | null;
  loc: SourceLoc;
}

export interface ParamDecl {
  name: string;
  isLocal: boolean;
  signed: boolean;
  range: RangeSpec | null;
  value: Expr;
  loc: SourceLoc;
}

export interface SignalDecl {
  name: string;
  direction?: PortDirection;
  kind: SignalKind;
  signed: boolean;
  range: RangeSpec | null;
  init?: Expr;
  loc: SourceLoc;
}

export interface AssignStmt {
  target: LValue;
  value: Expr;
  loc: SourceLoc;
}

export interface AlwaysBlock {
  sensitivity: 'comb' | 'seq';
  hasAsyncReset: boolean;
  resetSignal?: string;
  resetActiveLow?: boolean;
  body: Stmt;
  loc: SourceLoc;
}

export interface ModuleAst {
  name: string;
  ports: PortDecl[];
  params: ParamDecl[];
  signals: SignalDecl[];
  assigns: AssignStmt[];
  alwaysBlocks: AlwaysBlock[];
  loc: SourceLoc;
}

export type LValue =
  | { type: 'ident'; name: string; loc: SourceLoc }
  | { type: 'index'; name: string; index: Expr; loc: SourceLoc }
  | { type: 'slice'; name: string; msb: Expr; lsb: Expr; loc: SourceLoc }
  | { type: 'concat'; items: LValue[]; loc: SourceLoc };

export type Stmt =
  | { type: 'block'; statements: Stmt[]; loc: SourceLoc }
  | { type: 'assign'; kind: AssignKind; target: LValue; value: Expr; loc: SourceLoc }
  | { type: 'if'; condition: Expr; thenBranch: Stmt; elseBranch?: Stmt; loc: SourceLoc }
  | {
      type: 'case';
      kind: 'case' | 'casez';
      expr: Expr;
      items: CaseItem[];
      defaultBranch?: Stmt;
      loc: SourceLoc;
    }
  | { type: 'empty'; loc: SourceLoc };

export interface CaseItem {
  patterns: Expr[];
  body: Stmt;
  loc: SourceLoc;
}

export type UnaryOp = '~' | '!' | '&' | '|' | '^' | '-' | '+';

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '&'
  | '|'
  | '^'
  | '&&'
  | '||'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '<<'
  | '>>'
  | '<<<'
  | '>>>';

export type Expr =
  | {
      type: 'number';
      value: number;
      width: number;
      sized: boolean;
      signed: boolean;
      raw: string;
      loc: SourceLoc;
    }
  | { type: 'ident'; name: string; loc: SourceLoc }
  | { type: 'index'; target: Expr; index: Expr; loc: SourceLoc }
  | { type: 'slice'; target: Expr; msb: Expr; lsb: Expr; loc: SourceLoc }
  | { type: 'concat'; items: Expr[]; loc: SourceLoc }
  | { type: 'repeat'; count: Expr; items: Expr[]; loc: SourceLoc }
  | { type: 'unary'; op: UnaryOp; operand: Expr; loc: SourceLoc }
  | { type: 'binary'; op: BinaryOp; left: Expr; right: Expr; loc: SourceLoc }
  | { type: 'ternary'; condition: Expr; thenExpr: Expr; elseExpr: Expr; loc: SourceLoc }
  | { type: 'sysfn'; name: '$signed' | '$unsigned'; arg: Expr; loc: SourceLoc };
