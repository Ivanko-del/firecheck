import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { discoverRulesFiles } from './discover.js';
import { format, FORMATS, type FormatName } from './format.js';
import { lint } from './linter.js';
import { describeRules, ruleIds } from './rules.js';
import type { Diagnostic, Severity } from './types.js';

export interface RunIO {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  /** Paths are printed relative to this directory (e.g. the repository root in CI). Defaults to cwd. */
  root?: string;
  now?: Date;
}

const HELP = `Usage: firecheck [files...] [options]

Security linter for Firebase rules (Cloud Firestore and Cloud Storage).
With no files, reads the rules paths from firebase.json, or finds *.rules files.

Options:
  -f, --format <name>     pretty (default), json, github, sarif
      --fail-on <level>   exit 1 on problems at this level or above:
                          error (default), warning, info, never
      --disable <ids>     comma-separated rule ids to skip
  -q, --quiet             report errors only
      --list-rules        print all rules and exit
  -v, --version           print the version
  -h, --help              print this help

Suppress a finding in the rules file:
  // firecheck-disable-next-line always-true -- public product catalog
`;

const RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

export function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Runs the CLI and returns the exit code: 0 clean, 1 problems found, 2 usage or I/O error. */
export function run(argv: string[], io: RunIO): number {
  let formatName: FormatName = 'pretty';
  let failOn: Severity | 'never' = 'error';
  let quiet = false;
  const disable: string[] = [];
  const files: string[] = [];

  const usageError = (message: string) => {
    io.stderr(`firecheck: ${message}\nRun 'firecheck --help' for usage.\n`);
    return 2;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    try {
      switch (flag) {
        case '-h':
        case '--help':
          io.stdout(HELP);
          return 0;
        case '-v':
        case '--version':
          io.stdout(version() + '\n');
          return 0;
        case '--list-rules':
          for (const r of describeRules()) io.stdout(`${r.id.padEnd(22)} ${r.severity.padEnd(8)} ${r.description}\n`);
          return 0;
        case '-f':
        case '--format': {
          const v = value();
          if (!FORMATS.includes(v as FormatName)) return usageError(`unknown format '${v}' (expected ${FORMATS.join(', ')})`);
          formatName = v as FormatName;
          break;
        }
        case '--fail-on': {
          const v = value();
          if (!['error', 'warning', 'info', 'never'].includes(v)) return usageError(`unknown --fail-on level '${v}'`);
          failOn = v as Severity | 'never';
          break;
        }
        case '--disable': {
          const ids = value().split(',').map((s) => s.trim()).filter(Boolean);
          const unknown = ids.filter((id) => !ruleIds.includes(id));
          if (unknown.length) return usageError(`unknown rule '${unknown.join("', '")}' (see --list-rules)`);
          disable.push(...ids);
          break;
        }
        case '-q':
        case '--quiet':
          quiet = true;
          break;
        default:
          if (arg.startsWith('-') && arg !== '-') return usageError(`unknown option '${arg}'`);
          files.push(arg);
      }
    } catch (err) {
      return usageError((err as Error).message);
    }
  }

  let paths: string[];
  if (files.length > 0) {
    paths = files.map((f) => (isAbsolute(f) ? f : resolve(io.cwd, f)));
  } else {
    try {
      paths = discoverRulesFiles(io.cwd).files;
    } catch (err) {
      io.stderr(`firecheck: ${(err as Error).message}\n`);
      return 2;
    }
    if (paths.length === 0) {
      io.stderr('firecheck: no rules files found. Pass a path, e.g. `firecheck firestore.rules`.\n');
      return 2;
    }
  }

  const display = (p: string) => {
    const rel = relative(io.root ?? io.cwd, p);
    return rel && !rel.startsWith('..') ? rel : p;
  };

  let diagnostics: Diagnostic[] = [];
  for (const path of paths) {
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (err) {
      io.stderr(`firecheck: cannot read ${display(path)}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}\n`);
      return 2;
    }
    diagnostics.push(...lint(source, display(path), { disable, now: io.now }));
  }
  if (quiet) diagnostics = diagnostics.filter((d) => d.severity === 'error');

  io.stdout(format(formatName, diagnostics, { files: paths.map(display), color: io.color && formatName !== 'json' && formatName !== 'sarif', version: version() }));

  if (failOn === 'never') return 0;
  return diagnostics.some((d) => RANK[d.severity] >= RANK[failOn as Severity]) ? 1 : 0;
}
