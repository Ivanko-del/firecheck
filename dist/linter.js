import { collectFacts, constantValue } from './analysis.js';
import { RulesSyntaxError } from './ast.js';
import { parse } from './parser.js';
import { rules } from './rules.js';
const RANK = { info: 0, warning: 1, error: 2 };
export function lint(source, file = 'firestore.rules', options = {}) {
    const lineStarts = computeLineStarts(source);
    const diagnostic = (ruleId, severity, message, span, help) => {
        const start = position(lineStarts, span.start);
        const end = position(lineStarts, span.end);
        return { ruleId, severity, message, help, file, line: start.line, column: start.column, endLine: end.line, endColumn: end.column };
    };
    let ast;
    try {
        ast = parse(source);
    }
    catch (err) {
        if (!(err instanceof RulesSyntaxError))
            throw err;
        return [diagnostic('parse-error', 'error', err.message, { start: err.offset, end: err.offset })];
    }
    const disabled = new Set(options.disable ?? []);
    const ctx = { file: ast, allows: collectAllows(ast), now: options.now ?? new Date() };
    const results = [];
    for (const rule of rules) {
        if (disabled.has(rule.id))
            continue;
        rule.check(ctx, (r) => results.push(diagnostic(rule.id, r.severity ?? rule.severity, r.message, r.span, r.help)));
    }
    const suppressed = suppressions(ast, lineStarts);
    return results
        .filter((d) => !suppressed.isSuppressed(d.ruleId, d.line))
        .sort((a, b) => a.line - b.line || a.column - b.column || RANK[b.severity] - RANK[a.severity] || a.ruleId.localeCompare(b.ruleId));
}
function serviceKind(name) {
    if (name === 'cloud.firestore')
        return 'firestore';
    if (name === 'firebase.storage')
        return 'storage';
    return 'unknown';
}
/** /databases/{database}/documents or /b/{bucket}/o */
function isServiceRoot(segments) {
    const [a, b, c] = segments;
    if (segments.length !== 3 || a?.kind !== 'literal' || b?.kind !== 'wildcard' || c?.kind !== 'literal')
        return false;
    return (a.text === 'databases' && c.text === 'documents') || (a.text === 'b' && c.text === 'o');
}
function collectAllows(ast) {
    const allows = [];
    const visit = (items, state) => {
        const functions = new Map(state.functions);
        for (const item of items)
            if (item.kind === 'function')
                functions.set(item.name, item);
        for (const item of items) {
            if (item.kind === 'match') {
                const root = state.topLevel && isServiceRoot(item.segments);
                const pathVars = new Set(state.pathVars);
                if (!root)
                    for (const seg of item.segments)
                        if (seg.kind !== 'literal')
                            pathVars.add(seg.name);
                visit(item.body, {
                    service: state.service,
                    functions,
                    pathVars,
                    path: root ? '' : state.path + item.path,
                    recursive: item.segments.some((s) => s.kind === 'recursive') ? item : state.recursive,
                    topLevel: false,
                });
            }
            else if (item.kind === 'allow') {
                const scope = { functions, pathVars: state.pathVars };
                allows.push({
                    stmt: item,
                    service: state.service,
                    methods: item.methods.map((m) => m.name),
                    path: state.path || '/',
                    recursive: state.recursive,
                    facts: collectFacts(item.condition, scope),
                    constant: constantValue(item.condition, scope),
                });
            }
        }
    };
    for (const service of ast.services) {
        visit(service.body, {
            service: serviceKind(service.name),
            functions: new Map(),
            pathVars: new Set(),
            path: '',
            recursive: null,
            topLevel: true,
        });
    }
    return allows;
}
// ---- inline suppressions -------------------------------------------------
const DIRECTIVE = /^\s*firecheck-(disable-next-line|disable-line|disable)\b(.*)$/;
function suppressions(ast, lineStarts) {
    const fileWide = new Set();
    const byLine = new Map();
    const ALL = '*';
    for (const comment of ast.comments) {
        const text = comment.text.replace(/\*\/$/, '');
        const m = DIRECTIVE.exec(text);
        if (!m)
            continue;
        // Anything after "--" is a free-form reason.
        const ids = (m[2] ?? '').split('--')[0].split(/[\s,]+/).filter(Boolean);
        const targets = ids.length ? ids : [ALL];
        const line = position(lineStarts, comment.span.start).line;
        if (m[1] === 'disable') {
            targets.forEach((id) => fileWide.add(id));
        }
        else {
            const target = m[1] === 'disable-next-line' ? line + 1 : line;
            const set = byLine.get(target) ?? new Set();
            targets.forEach((id) => set.add(id));
            byLine.set(target, set);
        }
    }
    return {
        isSuppressed(ruleId, line) {
            if (fileWide.has(ALL) || fileWide.has(ruleId))
                return true;
            const set = byLine.get(line);
            return !!set && (set.has(ALL) || set.has(ruleId));
        },
    };
}
// ---- positions -----------------------------------------------------------
function computeLineStarts(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++)
        if (source[i] === '\n')
            starts.push(i + 1);
    return starts;
}
function position(lineStarts, offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset)
            lo = mid;
        else
            hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}
