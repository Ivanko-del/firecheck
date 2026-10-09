import { type Comment } from './ast.js';
export type TokenType = 'ident' | 'number' | 'string' | 'punct' | 'path' | 'eof';
export type PathTokenPiece = {
    kind: 'text';
    text: string;
} | {
    kind: 'interp';
    tokens: Token[];
};
export interface Token {
    type: TokenType;
    /** Identifier name, punctuator, decoded string, number text or raw path. */
    value: string;
    start: number;
    end: number;
    pieces?: PathTokenPiece[];
}
export declare function tokenize(source: string): {
    tokens: Token[];
    comments: Comment[];
};
