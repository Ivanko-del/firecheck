import type { Expr, FunctionDecl } from './ast.js';

/** What a condition looks at, after inlining user-defined functions. */
export interface Facts {
  /** Reads request.auth in any way. */
  auth: boolean;
  /** Compares request.auth.uid (or email) against hard-coded values. */
  authAllowlist: boolean;
  /** Reads a custom claim or email from request.auth.token. */
  authClaims: boolean;
  /** Reads the existing document/file (`resource`). */
  resource: boolean;
  /** Reads the incoming data (`request.resource`). */
  requestResource: boolean;
  requestResourceSize: boolean;
  requestResourceContentType: boolean;
  /** Compares request.resource.data.<field> (or Storage metadata) with request.auth.uid. */
  ownerFromNewData: boolean;
  /** Calls get(), exists(), getAfter() or existsAfter(). */
  lookup: boolean;
  requestTime: boolean;
  /** timestamp.date(y, m, d) literals found in the condition. */
  dates: Date[];
  /** Path wildcard variables referenced (e.g. userId). */
  pathVars: Set<string>;
}

export interface Scope {
  functions: ReadonlyMap<string, FunctionDecl>;
  /** Wildcards that identify data, excluding {database} and {bucket}. */
  pathVars: ReadonlySet<string>;
}

interface Binding {
  expr: Expr;
  env: Env;
}
type Env = ReadonlyMap<string, Binding>;

const MAX_DEPTH = 40;
// Inlining can grow exponentially when functions call each other repeatedly; cap the work per condition.
const MAX_STEPS = 20_000;
const LOOKUPS = new Set(['get', 'exists', 'getAfter', 'existsAfter', 'firestore.get', 'firestore.exists']);
// Token fields every signed-in user has; reading them is not authorization.
const BENIGN_CLAIMS = new Set(['email_verified', 'firebase', 'auth_time', 'iat', 'exp', 'sub', 'uid', 'phone_number', 'name', 'picture']);
const EMPTY_ENV: Env = new Map();

export function emptyFacts(): Facts {
  return {
    auth: false,
    authAllowlist: false,
    authClaims: false,
    resource: false,
    requestResource: false,
    requestResourceSize: false,
    requestResourceContentType: false,
    ownerFromNewData: false,
    lookup: false,
    requestTime: false,
    dates: [],
    pathVars: new Set(),
  };
}

export function collectFacts(expr: Expr | null, scope: Scope): Facts {
  const facts = emptyFacts();
  if (expr) walk(expr, EMPTY_ENV, 0, { scope, facts, steps: 0 });
  return facts;
}

/**
 * The dotted name an expression refers to, e.g. "request.auth.uid", with
 * let-bindings and function parameters substituted. null when the
 * expression is not a plain chain of names.
 */
export function chainOf(expr: Expr, env: Env = EMPTY_ENV, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  switch (expr.kind) {
    case 'ident': {
      const bound = env.get(expr.name);
      return bound ? chainOf(bound.expr, bound.env, depth + 1) : expr.name;
    }
    case 'member': {
      const base = chainOf(expr.object, env, depth + 1);
      return base === null ? null : `${base}.${expr.property}`;
    }
    case 'index': {
      if (expr.end || expr.index.kind !== 'literal' || typeof expr.index.value !== 'string') return null;
      const base = chainOf(expr.object, env, depth + 1);
      return base === null ? null : `${base}.${expr.index.value}`;
    }
    default:
      return null;
  }
}

function resolve(expr: Expr, env: Env, depth: number): { expr: Expr; env: Env } {
  while (expr.kind === 'ident' && depth++ < MAX_DEPTH) {
    const bound = env.get(expr.name);
    if (!bound) break;
    expr = bound.expr;
    env = bound.env;
  }
  return { expr, env };
}

/** A hard-coded string or list of strings, as in `request.auth.uid in ['abc', 'def']`. */
function isLiteralish(expr: Expr): boolean {
  if (expr.kind === 'literal') return typeof expr.value === 'string';
  if (expr.kind === 'list') return expr.items.length > 0 && expr.items.every(isLiteralish);
  return false;
}

function isNullCheckOf(subject: Expr, other: Expr, env: Env): boolean {
  return chainOf(subject, env) === 'resource' && other.kind === 'literal' && other.value === null;
}

function startsWith(chain: string, prefix: string): boolean {
  return chain === prefix || chain.startsWith(prefix + '.');
}

/** Environment for a call to a user function: parameters bound to arguments, then lets. */
function callEnv(fn: FunctionDecl, args: Expr[], callerEnv: Env): Env {
  const env = new Map<string, Binding>();
  fn.params.forEach((param, i) => {
    const arg = args[i];
    if (arg) env.set(param, { expr: arg, env: callerEnv });
  });
  for (const { name, value } of fn.lets) env.set(name, { expr: value, env: new Map(env) });
  return env;
}

function userFunction(expr: Expr, env: Env, scope: Scope): FunctionDecl | undefined {
  if (expr.kind !== 'call' || expr.callee.kind !== 'ident' || env.has(expr.callee.name)) return undefined;
  return scope.functions.get(expr.callee.name);
}

interface WalkState {
  scope: Scope;
  facts: Facts;
  steps: number;
}

function recordChain(chain: string, scope: Scope, facts: Facts): void {
  if (startsWith(chain, 'request.auth')) {
    facts.auth = true;
    const claim = /^request\.auth\.token\.([A-Za-z_]\w*)/.exec(chain);
    if (claim && !BENIGN_CLAIMS.has(claim[1]!)) facts.authClaims = true;
  } else if (startsWith(chain, 'request.resource')) {
    facts.requestResource = true;
    if (startsWith(chain, 'request.resource.size')) facts.requestResourceSize = true;
    if (startsWith(chain, 'request.resource.contentType')) facts.requestResourceContentType = true;
  } else if (startsWith(chain, 'resource')) {
    facts.resource = true;
  } else if (startsWith(chain, 'request.time')) {
    facts.requestTime = true;
  } else {
    const root = chain.split('.')[0]!;
    if (scope.pathVars.has(root)) facts.pathVars.add(root);
  }
}

function walk(expr: Expr, env: Env, depth: number, state: WalkState): void {
  if (depth > MAX_DEPTH || ++state.steps > MAX_STEPS) return;
  const { scope, facts } = state;
  const chain = chainOf(expr, env);
  if (chain !== null) {
    recordChain(chain, scope, facts);
    return;
  }
  const next = (e: Expr, en: Env = env) => walk(e, en, depth + 1, state);

  switch (expr.kind) {
    case 'literal':
      return;
    case 'ident': {
      const bound = env.get(expr.name);
      if (bound) next(bound.expr, bound.env);
      return;
    }
    case 'member':
      return next(expr.object);
    case 'index':
      next(expr.object);
      next(expr.index);
      if (expr.end) next(expr.end);
      return;
    case 'call': {
      const fn = userFunction(expr, env, scope);
      if (fn) {
        next(fn.returns, callEnv(fn, expr.args, env));
        return;
      }
      const callee = chainOf(expr.callee, env);
      if (callee !== null && LOOKUPS.has(callee)) facts.lookup = true;
      if (callee === 'timestamp.date') {
        const parts = expr.args.map((a) => resolve(a, env, depth).expr);
        if (parts.length === 3 && parts.every((p) => p.kind === 'literal' && typeof p.value === 'number')) {
          const [y, m, d] = parts.map((p) => (p as { value: number }).value) as [number, number, number];
          facts.dates.push(new Date(Date.UTC(y, m - 1, d)));
        }
      }
      // Method calls such as request.resource.data.keys(): the receiver matters.
      if (expr.callee.kind !== 'ident') next(expr.callee);
      for (const arg of expr.args) next(arg);
      return;
    }
    case 'unary':
      return next(expr.operand);
    case 'binary': {
      // `resource == null` only asks whether the document exists.
      if ((expr.op === '==' || expr.op === '!=') && (isNullCheckOf(expr.left, expr.right, env) || isNullCheckOf(expr.right, expr.left, env))) {
        return;
      }
      if (expr.op === '==' || expr.op === 'in') {
        const left = chainOf(expr.left, env);
        const right = chainOf(expr.right, env);
        const isUid = (c: string | null) => c === 'request.auth.uid' || c === 'request.auth.token.sub';
        const isNewData = (c: string | null) =>
          c !== null && (c.startsWith('request.resource.data.') || c.startsWith('request.resource.metadata.'));
        if (expr.op === '==' && ((isUid(left) && isNewData(right)) || (isUid(right) && isNewData(left)))) {
          facts.ownerFromNewData = true;
        }
        const isIdentity = (c: string | null) => isUid(c) || c === 'request.auth.token.email';
        const l = resolve(expr.left, env, depth).expr;
        const r = resolve(expr.right, env, depth).expr;
        if ((isIdentity(left) && isLiteralish(r)) || (isIdentity(right) && isLiteralish(l))) {
          facts.authAllowlist = true;
        }
      }
      next(expr.left);
      next(expr.right);
      return;
    }
    case 'ternary':
      next(expr.test);
      next(expr.consequent);
      next(expr.alternate);
      return;
    case 'list':
      for (const item of expr.items) next(item);
      return;
    case 'map':
      for (const { key, value } of expr.entries) {
        next(key);
        next(value);
      }
      return;
    case 'path':
      for (const piece of expr.pieces) if (piece.kind === 'expr') next(piece.expr);
      return;
  }
}

/**
 * Evaluates a condition when its value doesn't depend on the request:
 * true, false, or undefined when it can't be decided statically.
 */
export function constantValue(expr: Expr | null, scope: Scope): boolean | undefined {
  if (expr === null) return true;
  return evaluate(expr, EMPTY_ENV, 0, { scope, steps: 0 });
}

function evaluate(expr: Expr, env: Env, depth: number, state: { scope: Scope; steps: number }): boolean | undefined {
  if (depth > MAX_DEPTH || ++state.steps > MAX_STEPS) return undefined;
  const { scope } = state;
  const ev = (e: Expr, en: Env = env) => evaluate(e, en, depth + 1, state);
  switch (expr.kind) {
    case 'literal':
      return typeof expr.value === 'boolean' ? expr.value : undefined;
    case 'ident': {
      const bound = env.get(expr.name);
      return bound ? ev(bound.expr, bound.env) : undefined;
    }
    case 'unary': {
      if (expr.op !== '!') return undefined;
      const v = ev(expr.operand);
      return v === undefined ? undefined : !v;
    }
    case 'ternary': {
      const test = ev(expr.test);
      if (test === undefined) return undefined;
      return ev(test ? expr.consequent : expr.alternate);
    }
    case 'call': {
      const fn = userFunction(expr, env, scope);
      return fn ? ev(fn.returns, callEnv(fn, expr.args, env)) : undefined;
    }
    case 'binary': {
      if (expr.op === '||' || expr.op === '&&') {
        const l = ev(expr.left);
        const r = ev(expr.right);
        if (expr.op === '||') {
          if (l === true || r === true) return true;
          return l === false && r === false ? false : undefined;
        }
        if (l === false || r === false) return false;
        return l === true && r === true ? true : undefined;
      }
      if (expr.op === '==' || expr.op === '!=') {
        const l = resolve(expr.left, env, depth).expr;
        const r = resolve(expr.right, env, depth).expr;
        if (l.kind === 'literal' && r.kind === 'literal') {
          return (l.value === r.value) === (expr.op === '==');
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
