import { describeRules } from './rules.js';
export const FORMATS = ['pretty', 'json', 'github', 'sarif'];
export function format(name, diagnostics, options) {
    switch (name) {
        case 'pretty':
            return pretty(diagnostics, options);
        case 'json':
            return JSON.stringify(diagnostics, null, 2) + '\n';
        case 'github':
            return pretty(diagnostics, options) + github(diagnostics);
        case 'sarif':
            return JSON.stringify(sarif(diagnostics, options), null, 2) + '\n';
    }
}
// ---- pretty --------------------------------------------------------------
const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m', green: '\x1b[32m', underline: '\x1b[4m' };
function pretty(diagnostics, options) {
    const paint = (codes, text) => (options.color ? codes + text + ANSI.reset : text);
    const code = (text) => (options.color ? text.replace(/`([^`]+)`/g, (_, c) => paint(ANSI.cyan, c)) : text);
    const severityColor = { error: ANSI.red, warning: ANSI.yellow, info: ANSI.blue };
    const byFile = new Map();
    for (const d of diagnostics)
        byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
    let out = '';
    for (const [file, list] of byFile) {
        out += '\n' + paint(ANSI.underline, file) + '\n';
        for (const d of list) {
            const pos = `${d.line}:${d.column}`.padEnd(7);
            const sev = paint(severityColor[d.severity], d.severity.padEnd(7));
            out += `  ${paint(ANSI.dim, pos)} ${sev} ${code(d.message)}  ${paint(ANSI.dim, d.ruleId)}\n`;
            if (d.help)
                out += `  ${' '.repeat(15)} ${paint(ANSI.dim, '↳')} ${code(d.help)}\n`;
        }
    }
    const count = (s) => diagnostics.filter((d) => d.severity === s).length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (diagnostics.length === 0) {
        out += paint(ANSI.green, `✔ No problems found in ${plural(options.files.length, 'file')}.`) + '\n';
    }
    else {
        const errors = count('error');
        const summary = `${errors ? '✖' : '⚠'} ${plural(diagnostics.length, 'problem')} (${plural(errors, 'error')}, ${plural(count('warning'), 'warning')}, ${count('info')} info)`;
        out += '\n' + paint(ANSI.bold + (errors ? ANSI.red : ANSI.yellow), summary) + '\n';
    }
    return out;
}
// ---- GitHub Actions workflow commands ----------------------------------
function escapeData(s) {
    return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(s) {
    return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}
function github(diagnostics) {
    const command = { error: 'error', warning: 'warning', info: 'notice' };
    return diagnostics
        .map((d) => {
        const props = [
            `file=${escapeProperty(d.file)}`,
            `line=${d.line}`,
            `col=${d.column}`,
            `endLine=${d.endLine}`,
            `endColumn=${d.endColumn}`,
            `title=${escapeProperty(`firecheck: ${d.ruleId}`)}`,
        ].join(',');
        const message = d.help ? `${d.message}\n\nFix: ${d.help}` : d.message;
        return `::${command[d.severity]} ${props}::${escapeData(message)}\n`;
    })
        .join('');
}
// ---- SARIF 2.1.0 (GitHub code scanning) -------------------------------
function sarif(diagnostics, options) {
    const level = { error: 'error', warning: 'warning', info: 'note' };
    return {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: 'firecheck',
                        version: options.version,
                        informationUri: 'https://github.com/ivanko-del/firecheck',
                        rules: describeRules().map((r) => ({
                            id: r.id,
                            shortDescription: { text: r.description },
                            defaultConfiguration: { level: level[r.severity] },
                        })),
                    },
                },
                results: diagnostics.map((d) => ({
                    ruleId: d.ruleId,
                    level: level[d.severity],
                    message: { text: d.help ? `${d.message} Fix: ${d.help}` : d.message },
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: { uri: d.file.split('\\').join('/') },
                                region: { startLine: d.line, startColumn: d.column, endLine: d.endLine, endColumn: d.endColumn },
                            },
                        },
                    ],
                })),
            },
        ],
    };
}
