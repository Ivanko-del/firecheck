import { RulesSyntaxError } from './ast.js';
// Longest first, so "==" wins over "=".
const PUNCTUATORS = [
    '==', '!=', '<=', '>=', '&&', '||',
    '{', '}', '(', ')', '[', ']', ';', ',', '.', ':', '?', '!', '=', '<', '>', '+', '-', '*', '/', '%',
];
// After these keywords a "/" starts a path, not a division.
const PATH_KEYWORDS = new Set(['match', 'return', 'if', 'in']);
const PATH_CHAR = /[A-Za-z0-9_\-.~%]/;
function isIdentStart(c) {
    return c !== undefined && /[A-Za-z_]/.test(c);
}
function isIdentPart(c) {
    return c !== undefined && /[A-Za-z0-9_]/.test(c);
}
function isDigit(c) {
    return c !== undefined && c >= '0' && c <= '9';
}
function operandExpected(prev) {
    if (!prev)
        return true;
    if (prev.type === 'punct')
        return prev.value !== ')' && prev.value !== ']' && prev.value !== '}';
    if (prev.type === 'ident')
        return PATH_KEYWORDS.has(prev.value);
    return false;
}
export function tokenize(source) {
    const lexer = new Lexer(source);
    const tokens = lexer.run();
    return { tokens, comments: lexer.comments };
}
class Lexer {
    src;
    pos = 0;
    comments = [];
    constructor(src) {
        this.src = src;
    }
    run() {
        const out = [];
        for (;;) {
            const tok = this.next(out[out.length - 1]);
            out.push(tok);
            if (tok.type === 'eof')
                return out;
        }
    }
    next(prev) {
        this.skipTrivia();
        const { src } = this;
        const start = this.pos;
        if (start >= src.length)
            return { type: 'eof', value: '', start, end: start };
        const c = src[start];
        if (isIdentStart(c)) {
            let p = start + 1;
            while (isIdentPart(src[p]))
                p++;
            const word = src.slice(start, p);
            if (word === 'r' && (src[p] === "'" || src[p] === '"')) {
                this.pos = p;
                return this.string(start, true);
            }
            this.pos = p;
            return { type: 'ident', value: word, start, end: p };
        }
        if (isDigit(c))
            return this.number(start);
        if (c === "'" || c === '"')
            return this.string(start, false);
        if (c === '/' && operandExpected(prev))
            return this.path(start);
        for (const p of PUNCTUATORS) {
            if (src.startsWith(p, start)) {
                this.pos = start + p.length;
                return { type: 'punct', value: p, start, end: this.pos };
            }
        }
        throw new RulesSyntaxError(`Unexpected character '${c}'`, start);
    }
    skipTrivia() {
        const { src } = this;
        while (this.pos < src.length) {
            const c = src[this.pos];
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
                this.pos++;
            }
            else if (c === '/' && src[this.pos + 1] === '/') {
                const start = this.pos;
                const nl = src.indexOf('\n', start);
                const end = nl === -1 ? src.length : nl;
                this.comments.push({ text: src.slice(start + 2, end), span: { start, end } });
                this.pos = end;
            }
            else if (c === '/' && src[this.pos + 1] === '*') {
                const start = this.pos;
                const close = src.indexOf('*/', start + 2);
                if (close === -1)
                    throw new RulesSyntaxError('Unterminated block comment', start);
                this.comments.push({ text: src.slice(start + 2, close), span: { start, end: close + 2 } });
                this.pos = close + 2;
            }
            else {
                return;
            }
        }
    }
    number(start) {
        const { src } = this;
        let p = start;
        while (isDigit(src[p]))
            p++;
        if (src[p] === '.' && isDigit(src[p + 1])) {
            p++;
            while (isDigit(src[p]))
                p++;
        }
        if ((src[p] === 'e' || src[p] === 'E') && (isDigit(src[p + 1]) || ((src[p + 1] === '+' || src[p + 1] === '-') && isDigit(src[p + 2])))) {
            p += 2;
            while (isDigit(src[p]))
                p++;
        }
        this.pos = p;
        return { type: 'number', value: src.slice(start, p), start, end: p };
    }
    string(start, raw) {
        const { src } = this;
        const quote = src[this.pos];
        let p = this.pos + 1;
        let value = '';
        for (;;) {
            const c = src[p];
            if (c === undefined || c === '\n')
                throw new RulesSyntaxError('Unterminated string', start);
            if (c === quote)
                break;
            if (c === '\\' && !raw) {
                const e = src[p + 1];
                const escapes = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
                if (e !== undefined && e in escapes) {
                    value += escapes[e];
                    p += 2;
                    continue;
                }
                value += c;
                p++;
                continue;
            }
            value += c;
            p++;
        }
        this.pos = p + 1;
        return { type: 'string', value, start, end: this.pos };
    }
    /**
     * Lexes a path such as `/users/{userId}`, `/{document=**}` or
     * `/databases/$(database)/documents/users/$(request.auth.uid)`.
     */
    path(start) {
        const { src } = this;
        const pieces = [];
        let text = '';
        let p = start;
        const flush = () => {
            if (text)
                pieces.push({ kind: 'text', text });
            text = '';
        };
        while (src[p] === '/') {
            text += '/';
            p++;
            if (src[p] === '{') {
                const close = src.indexOf('}', p);
                if (close === -1)
                    throw new RulesSyntaxError('Unterminated path wildcard', p);
                text += src.slice(p, close + 1);
                p = close + 1;
                continue;
            }
            for (;;) {
                const c = src[p];
                if (c === '$' && src[p + 1] === '(') {
                    flush();
                    this.pos = p + 2;
                    pieces.push({ kind: 'interp', tokens: this.interpolation(p) });
                    p = this.pos;
                }
                else if (c === '(') {
                    // Literal parenthesised segments, e.g. /databases/(default)/documents.
                    const close = src.indexOf(')', p);
                    if (close === -1 || !/^\([A-Za-z0-9_\-]*\)$/.test(src.slice(p, close + 1)))
                        break;
                    text += src.slice(p, close + 1);
                    p = close + 1;
                }
                else if (c !== undefined && PATH_CHAR.test(c)) {
                    text += c;
                    p++;
                }
                else {
                    break;
                }
            }
        }
        flush();
        this.pos = p;
        return { type: 'path', value: src.slice(start, p), start, end: p, pieces };
    }
    /** Tokens of a `$( ... )` interpolation; leaves pos just after the closing paren. */
    interpolation(start) {
        const out = [];
        let depth = 0;
        for (;;) {
            const tok = this.next(out[out.length - 1] ?? { type: 'punct', value: '(', start, end: start });
            if (tok.type === 'eof')
                throw new RulesSyntaxError('Unterminated $( in path', start);
            if (tok.type === 'punct' && tok.value === '(')
                depth++;
            if (tok.type === 'punct' && tok.value === ')') {
                if (depth === 0) {
                    out.push({ type: 'eof', value: '', start: tok.start, end: tok.start });
                    return out;
                }
                depth--;
            }
            out.push(tok);
        }
    }
}
