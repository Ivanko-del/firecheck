import {
  type AllowStmt,
  type Expr,
  type FunctionDecl,
  type Item,
  type MatchSegment,
  type MatchStmt,
  type PathPiece,
  type RulesFile,
  RulesSyntaxError,
  type Service,
  type Span,
} from './ast.js';
import { type Token, tokenize } from './lexer.js';

export function parse(source: string): RulesFile {
  const { tokens, comments } = tokenize(source);
  const file = new Parser(tokens).file();
  return { ...file, comments };
}

const RELATIONAL = new Set(['<', '<=', '>', '>=']);

class Parser {
  private i = 0;
  private lastEnd = 0;

  constructor(private readonly tokens: Token[]) {}

  file(): Omit<RulesFile, 'comments'> {
    let version: RulesFile['version'] = null;
    const services: Service[] = [];
    while (this.peek().type !== 'eof') {
      if (this.isIdent('rules_version')) {
        const start = this.next().start;
        this.expectPunct('=');
        const value = this.next();
        if (value.type !== 'string') throw this.error(`Expected a string after rules_version =`, value);
        this.optionalPunct(';');
        version = { value: value.value, span: { start, end: this.lastEnd } };
      } else if (this.isIdent('service')) {
        services.push(this.service());
      } else {
        throw this.error(`Expected 'service' or 'rules_version'`, this.peek());
      }
    }
    return { version, services };
  }

  private service(): Service {
    const start = this.next().start;
    let name = this.expectIdent();
    while (this.isPunct('.')) {
      this.next();
      name += '.' + this.expectIdent();
    }
    const body = this.block();
    return { name, body, span: { start, end: this.lastEnd } };
  }

  private block(): Item[] {
    this.expectPunct('{');
    const items: Item[] = [];
    while (!this.isPunct('}')) {
      if (this.isIdent('match')) items.push(this.match());
      else if (this.isIdent('allow')) items.push(this.allow());
      else if (this.isIdent('function')) items.push(this.functionDecl());
      else throw this.error(`Expected 'match', 'allow', 'function' or '}'`, this.peek());
    }
    this.next();
    return items;
  }

  private match(): MatchStmt {
    const start = this.next().start;
    const pathTok = this.next();
    if (pathTok.type !== 'path') throw this.error('Expected a path after match', pathTok);
    const segments = parseMatchPath(pathTok);
    const body = this.block();
    return {
      kind: 'match',
      path: pathTok.value,
      segments,
      pathSpan: { start: pathTok.start, end: pathTok.end },
      body,
      span: { start, end: this.lastEnd },
    };
  }

  private allow(): AllowStmt {
    const start = this.next().start;
    const methods: AllowStmt['methods'] = [];
    do {
      const tok = this.next();
      if (tok.type !== 'ident') throw this.error('Expected a method name such as read or write', tok);
      methods.push({ name: tok.value, span: { start: tok.start, end: tok.end } });
    } while (this.optionalPunct(','));
    let condition: Expr | null = null;
    if (this.optionalPunct(':')) {
      if (!this.isIdent('if')) throw this.error(`Expected 'if'`, this.peek());
      this.next();
      condition = this.expr();
    }
    this.optionalPunct(';');
    return { kind: 'allow', methods, condition, span: { start, end: this.lastEnd } };
  }

  private functionDecl(): FunctionDecl {
    const start = this.next().start;
    const name = this.expectIdent();
    this.expectPunct('(');
    const params: string[] = [];
    if (!this.isPunct(')')) {
      do params.push(this.expectIdent());
      while (this.optionalPunct(','));
    }
    this.expectPunct(')');
    this.expectPunct('{');
    const lets: FunctionDecl['lets'] = [];
    while (this.isIdent('let')) {
      this.next();
      const letName = this.expectIdent();
      this.expectPunct('=');
      lets.push({ name: letName, value: this.expr() });
      this.optionalPunct(';');
    }
    if (!this.isIdent('return')) throw this.error(`Expected 'return'`, this.peek());
    this.next();
    const returns = this.expr();
    this.optionalPunct(';');
    this.expectPunct('}');
    return { kind: 'function', name, params, lets, returns, span: { start, end: this.lastEnd } };
  }

  // ---- expressions ------------------------------------------------------

  /** An expression that must consume every token, used for $( ) interpolations. */
  standaloneExpr(): Expr {
    const expr = this.expr();
    if (this.peek().type !== 'eof') throw this.error(`Unexpected token in $( )`, this.peek());
    return expr;
  }

  expr(): Expr {
    const test = this.binary(0);
    if (!this.isPunct('?')) return test;
    this.next();
    const consequent = this.expr();
    this.expectPunct(':');
    const alternate = this.expr();
    return { kind: 'ternary', test, consequent, alternate, span: this.spanFrom(test.span.start) };
  }

  // Precedence levels, lowest first.
  private static readonly LEVELS: Array<(t: Token) => boolean> = [
    (t) => t.type === 'punct' && t.value === '||',
    (t) => t.type === 'punct' && t.value === '&&',
    (t) => t.type === 'punct' && (t.value === '==' || t.value === '!='),
    (t) => (t.type === 'punct' && RELATIONAL.has(t.value)) || (t.type === 'ident' && (t.value === 'in' || t.value === 'is')),
    (t) => t.type === 'punct' && (t.value === '+' || t.value === '-'),
    (t) => t.type === 'punct' && (t.value === '*' || t.value === '/' || t.value === '%'),
  ];

  private binary(level: number): Expr {
    const matches = Parser.LEVELS[level];
    if (!matches) return this.unary();
    let left = this.binary(level + 1);
    while (matches(this.peek())) {
      const op = this.next().value;
      const right = this.binary(level + 1);
      left = { kind: 'binary', op, left, right, span: this.spanFrom(left.span.start) };
    }
    return left;
  }

  private unary(): Expr {
    if (this.isPunct('!') || this.isPunct('-')) {
      const tok = this.next();
      const operand = this.unary();
      return { kind: 'unary', op: tok.value as '!' | '-', operand, span: this.spanFrom(tok.start) };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let expr = this.primary();
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const property = this.expectIdent();
        expr = { kind: 'member', object: expr, property, span: this.spanFrom(expr.span.start) };
      } else if (this.isPunct('[')) {
        this.next();
        const index = this.expr();
        let end: Expr | undefined;
        if (this.optionalPunct(':')) end = this.expr();
        this.expectPunct(']');
        expr = { kind: 'index', object: expr, index, end, span: this.spanFrom(expr.span.start) };
      } else if (this.isPunct('(')) {
        this.next();
        const args = this.list(')');
        expr = { kind: 'call', callee: expr, args, span: this.spanFrom(expr.span.start) };
      } else {
        return expr;
      }
    }
  }

  private primary(): Expr {
    const tok = this.next();
    const span: Span = { start: tok.start, end: tok.end };
    switch (tok.type) {
      case 'number':
        return { kind: 'literal', value: Number(tok.value), span };
      case 'string':
        return { kind: 'literal', value: tok.value, span };
      case 'ident':
        if (tok.value === 'true') return { kind: 'literal', value: true, span };
        if (tok.value === 'false') return { kind: 'literal', value: false, span };
        if (tok.value === 'null') return { kind: 'literal', value: null, span };
        return { kind: 'ident', name: tok.value, span };
      case 'path':
        return { kind: 'path', pieces: (tok.pieces ?? []).map(toPathPiece), span };
      case 'punct':
        if (tok.value === '(') {
          const inner = this.expr();
          this.expectPunct(')');
          return { ...inner, span: this.spanFrom(tok.start) };
        }
        if (tok.value === '[') {
          const items = this.list(']');
          return { kind: 'list', items, span: this.spanFrom(tok.start) };
        }
        if (tok.value === '{') {
          const entries: Array<{ key: Expr; value: Expr }> = [];
          while (!this.isPunct('}')) {
            const key = this.expr();
            this.expectPunct(':');
            entries.push({ key, value: this.expr() });
            if (!this.optionalPunct(',')) break;
          }
          this.expectPunct('}');
          return { kind: 'map', entries, span: this.spanFrom(tok.start) };
        }
        break;
      case 'eof':
        throw this.error('Unexpected end of file', tok);
    }
    throw this.error(`Unexpected '${tok.value}'`, tok);
  }

  /** Comma-separated expressions up to and including `close`. */
  private list(close: string): Expr[] {
    const items: Expr[] = [];
    while (!this.isPunct(close)) {
      items.push(this.expr());
      if (!this.optionalPunct(',')) break;
    }
    this.expectPunct(close);
    return items;
  }

  // ---- token helpers ----------------------------------------------------

  private peek(): Token {
    return this.tokens[this.i] ?? this.tokens[this.tokens.length - 1]!;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.type !== 'eof') this.i++;
    this.lastEnd = tok.end;
    return tok;
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }

  private isIdent(value: string): boolean {
    const t = this.peek();
    return t.type === 'ident' && t.value === value;
  }

  private optionalPunct(value: string): boolean {
    if (!this.isPunct(value)) return false;
    this.next();
    return true;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.type !== 'punct' || tok.value !== value) throw this.error(`Expected '${value}'`, tok);
  }

  private expectIdent(): string {
    const tok = this.next();
    if (tok.type !== 'ident') throw this.error('Expected an identifier', tok);
    return tok.value;
  }

  private spanFrom(start: number): Span {
    return { start, end: this.lastEnd };
  }

  private error(message: string, tok: Token): RulesSyntaxError {
    const found = tok.type === 'eof' ? 'end of file' : `'${tok.value}'`;
    return new RulesSyntaxError(`${message}, found ${found}`, tok.start);
  }
}

function toPathPiece(piece: NonNullable<Token['pieces']>[number]): PathPiece {
  if (piece.kind === 'text') return piece;
  return { kind: 'expr', expr: new Parser(piece.tokens).standaloneExpr() };
}

function parseMatchPath(tok: Token): MatchSegment[] {
  if (tok.pieces?.some((p) => p.kind === 'interp')) {
    throw new RulesSyntaxError('$( ) is not allowed in a match path', tok.start);
  }
  const parts = tok.value.split('/').slice(1);
  return parts.map((part) => {
    const wildcard = /^\{([A-Za-z_][A-Za-z0-9_]*)(=\*\*)?\}$/.exec(part);
    if (wildcard) {
      const name = wildcard[1]!;
      return wildcard[2] ? { kind: 'recursive', name } : { kind: 'wildcard', name };
    }
    if (!part || /[{}]/.test(part)) {
      throw new RulesSyntaxError(`Invalid path segment '${part}' in ${tok.value}`, tok.start);
    }
    return { kind: 'literal', text: part };
  });
}
