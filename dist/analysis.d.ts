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
export declare function emptyFacts(): Facts;
export declare function collectFacts(expr: Expr | null, scope: Scope): Facts;
/**
 * The dotted name an expression refers to, e.g. "request.auth.uid", with
 * let-bindings and function parameters substituted. null when the
 * expression is not a plain chain of names.
 */
export declare function chainOf(expr: Expr, env?: Env, depth?: number): string | null;
/**
 * Evaluates a condition when its value doesn't depend on the request:
 * true, false, or undefined when it can't be decided statically.
 */
export declare function constantValue(expr: Expr | null, scope: Scope): boolean | undefined;
export {};
