/** Character offsets into the source, end exclusive. */
export interface Span {
    start: number;
    end: number;
}
export type Expr = {
    kind: 'literal';
    value: boolean | number | string | null;
    span: Span;
} | {
    kind: 'ident';
    name: string;
    span: Span;
} | {
    kind: 'member';
    object: Expr;
    property: string;
    span: Span;
} | {
    kind: 'index';
    object: Expr;
    index: Expr;
    end?: Expr;
    span: Span;
} | {
    kind: 'call';
    callee: Expr;
    args: Expr[];
    span: Span;
} | {
    kind: 'unary';
    op: '!' | '-';
    operand: Expr;
    span: Span;
} | {
    kind: 'binary';
    op: string;
    left: Expr;
    right: Expr;
    span: Span;
} | {
    kind: 'ternary';
    test: Expr;
    consequent: Expr;
    alternate: Expr;
    span: Span;
} | {
    kind: 'list';
    items: Expr[];
    span: Span;
} | {
    kind: 'map';
    entries: Array<{
        key: Expr;
        value: Expr;
    }>;
    span: Span;
} | {
    kind: 'path';
    pieces: PathPiece[];
    span: Span;
};
/** A document path literal such as /databases/$(database)/documents/users/$(uid). */
export type PathPiece = {
    kind: 'text';
    text: string;
} | {
    kind: 'expr';
    expr: Expr;
};
export type MatchSegment = {
    kind: 'literal';
    text: string;
} | {
    kind: 'wildcard';
    name: string;
} | {
    kind: 'recursive';
    name: string;
};
export interface MatchStmt {
    kind: 'match';
    path: string;
    segments: MatchSegment[];
    pathSpan: Span;
    body: Item[];
    span: Span;
}
export interface AllowStmt {
    kind: 'allow';
    methods: Array<{
        name: string;
        span: Span;
    }>;
    /** null for `allow read;`, which grants access unconditionally. */
    condition: Expr | null;
    span: Span;
}
export interface FunctionDecl {
    kind: 'function';
    name: string;
    params: string[];
    lets: Array<{
        name: string;
        value: Expr;
    }>;
    returns: Expr;
    span: Span;
}
export type Item = MatchStmt | AllowStmt | FunctionDecl;
export interface Service {
    name: string;
    body: Item[];
    span: Span;
}
export interface Comment {
    text: string;
    span: Span;
}
export interface RulesFile {
    version: {
        value: string;
        span: Span;
    } | null;
    services: Service[];
    comments: Comment[];
}
export declare class RulesSyntaxError extends Error {
    readonly offset: number;
    constructor(message: string, offset: number);
}
