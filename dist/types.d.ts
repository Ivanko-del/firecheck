import type { Facts } from './analysis.js';
import type { AllowStmt, MatchStmt, RulesFile, Span } from './ast.js';
export type Severity = 'error' | 'warning' | 'info';
export interface Diagnostic {
    ruleId: string;
    severity: Severity;
    message: string;
    /** How to fix it. */
    help?: string;
    file: string;
    /** 1-based. */
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
}
export type ServiceKind = 'firestore' | 'storage' | 'unknown';
export interface AllowInfo {
    stmt: AllowStmt;
    service: ServiceKind;
    methods: string[];
    /** Path below the database or bucket root, e.g. /users/{userId}. */
    path: string;
    /** Innermost enclosing match with a {name=**} wildcard. */
    recursive: MatchStmt | null;
    facts: Facts;
    /** true/false when the condition doesn't depend on the request. */
    constant: boolean | undefined;
}
export interface RuleContext {
    file: RulesFile;
    allows: AllowInfo[];
    now: Date;
}
export interface Report {
    message: string;
    help?: string;
    span: Span;
    severity?: Severity;
}
export interface Rule {
    id: string;
    severity: Severity;
    description: string;
    check(ctx: RuleContext, report: (r: Report) => void): void;
}
