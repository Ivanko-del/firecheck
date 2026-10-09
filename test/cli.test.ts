import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const OPEN = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{d=**} { allow read, write: if true; }\n  }\n}\n";
const READ_ONLY = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /posts/{id} { allow read: if true; }\n  }\n}\n";
const CLEAN = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /users/{uid} { allow read: if request.auth.uid == uid; }\n  }\n}\n";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'firecheck-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function exec2(dirs: { cwd: string; root?: string }, ...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { ...dirs, color: false, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

function exec(cwd: string, ...argv: string[]) {
  return exec2({ cwd }, ...argv);
}

describe('cli', () => {
  it('reads rules paths from firebase.json', () => {
    const cwd = project({
      'firebase.json': JSON.stringify({ firestore: { rules: 'config/db.rules' }, storage: [{ bucket: 'b', rules: 'config/clean.rules' }] }),
      'config/db.rules': OPEN,
      'config/clean.rules': CLEAN,
      'ignored.rules': OPEN,
    });
    const { code, stdout } = exec(cwd);
    expect(code).toBe(1);
    expect(stdout).toContain(join('config', 'db.rules'));
    expect(stdout).toContain('catch-all');
    expect(stdout).not.toContain('ignored.rules');
  });

  it('falls back to searching for *.rules files', () => {
    const cwd = project({ 'firestore.rules': CLEAN, 'node_modules/pkg/x.rules': OPEN });
    const { code, stdout } = exec(cwd);
    expect(code).toBe(0);
    expect(stdout).toContain('No problems found in 1 file.');
  });

  it('fails on errors by default but not on warnings', () => {
    const cwd = project({ 'firestore.rules': READ_ONLY });
    expect(exec(cwd).code).toBe(0);
    expect(exec(cwd, '--fail-on', 'warning').code).toBe(1);
    expect(exec(cwd, '--fail-on=never', 'firestore.rules').code).toBe(0);
  });

  it('prints JSON', () => {
    const cwd = project({ 'a.rules': OPEN });
    const { stdout } = exec(cwd, '--format', 'json', 'a.rules');
    const parsed = JSON.parse(stdout);
    expect(parsed[0]).toMatchObject({ ruleId: 'catch-all', file: 'a.rules', line: 4, column: 21 });
  });

  it('prints GitHub annotations', () => {
    const cwd = project({ 'a.rules': OPEN });
    const { stdout } = exec(cwd, '-f', 'github', 'a.rules');
    expect(stdout).toMatch(/^::error file=a\.rules,line=4,col=21,endLine=4,endColumn=\d+,title=firecheck%3A catch-all::Catch-all rule/m);
    expect(stdout).toContain('%0A%0AFix: ');
  });

  it('prints paths relative to the root directory', () => {
    const root = project({ 'app/firestore.rules': OPEN });
    const { stdout } = exec2({ cwd: join(root, 'app'), root }, '-f', 'github');
    expect(stdout).toContain(`::error file=${join('app', 'firestore.rules')},`);
  });

  it('prints SARIF', () => {
    const cwd = project({ 'a.rules': OPEN });
    const sarif = JSON.parse(exec(cwd, '--format', 'sarif', 'a.rules').stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: 'catch-all',
      level: 'error',
      locations: [{ physicalLocation: { artifactLocation: { uri: 'a.rules' }, region: { startLine: 4 } } }],
    });
    expect(sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)).toContain('auth-only');
  });

  it('filters to errors with --quiet', () => {
    const cwd = project({ 'a.rules': READ_ONLY });
    expect(exec(cwd, '--quiet', 'a.rules').stdout).toContain('No problems found');
  });

  it('disables rules with --disable', () => {
    const cwd = project({ 'a.rules': OPEN });
    expect(exec(cwd, '--disable', 'catch-all', 'a.rules').code).toBe(0);
    expect(exec(cwd, '--disable', 'nope', 'a.rules')).toMatchObject({ code: 2, stderr: expect.stringContaining("unknown rule 'nope'") });
  });

  it('exits 2 on usage and I/O errors', () => {
    const cwd = project({});
    expect(exec(cwd)).toMatchObject({ code: 2, stderr: expect.stringContaining('no rules files found') });
    expect(exec(cwd, 'missing.rules')).toMatchObject({ code: 2, stderr: expect.stringContaining('ENOENT') });
    expect(exec(cwd, '--wat').code).toBe(2);
    expect(exec(cwd, '--format', 'xml').code).toBe(2);
    expect(exec(cwd, '--format').code).toBe(2);
  });

  it('prints help, version and the rule list', () => {
    const cwd = project({});
    expect(exec(cwd, '--help').stdout).toContain('Usage: firecheck');
    expect(exec(cwd, '--version').stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(exec(cwd, '--list-rules').stdout).toContain('owner-from-new-data');
  });
});
