import { describe, expect, it } from 'vitest';
import type { AllowStmt, Expr, FunctionDecl, MatchStmt } from '../src/ast.js';
import { lint } from '../src/linter.js';
import { parse } from '../src/parser.js';

function conditionOf(rule: string): Expr {
  const file = parse(`service cloud.firestore { match /x/{id} { allow read: if ${rule}; } }`);
  const match = file.services[0]!.body[0] as MatchStmt;
  return (match.body[0] as AllowStmt).condition!;
}

describe('parser', () => {
  it('parses version, services and nested matches', () => {
    const file = parse(`
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /users/{userId}/{rest=**} {
            allow read, write: if false;
          }
        }
      }`);
    expect(file.version?.value).toBe('2');
    expect(file.services[0]!.name).toBe('cloud.firestore');
    const root = file.services[0]!.body[0] as MatchStmt;
    expect(root.segments).toEqual([
      { kind: 'literal', text: 'databases' },
      { kind: 'wildcard', name: 'database' },
      { kind: 'literal', text: 'documents' },
    ]);
    const users = root.body[0] as MatchStmt;
    expect(users.path).toBe('/users/{userId}/{rest=**}');
    expect(users.segments[2]).toEqual({ kind: 'recursive', name: 'rest' });
    const allow = users.body[0] as AllowStmt;
    expect(allow.methods.map((m) => m.name)).toEqual(['read', 'write']);
    expect(allow.condition).toMatchObject({ kind: 'literal', value: false });
  });

  it('treats a bare allow as having no condition', () => {
    const file = parse('service firebase.storage { match /b/{bucket}/o { allow read; } }');
    const allow = (file.services[0]!.body[0] as MatchStmt).body[0] as AllowStmt;
    expect(allow.condition).toBeNull();
  });

  it('parses functions with let bindings', () => {
    const file = parse(`service cloud.firestore {
      function isOwner(uid) {
        let me = request.auth.uid;
        return me == uid;
      }
    }`);
    const fn = file.services[0]!.body[0] as FunctionDecl;
    expect(fn.name).toBe('isOwner');
    expect(fn.params).toEqual(['uid']);
    expect(fn.lets.map((l) => l.name)).toEqual(['me']);
    expect(fn.returns).toMatchObject({ kind: 'binary', op: '==' });
  });

  it('parses path literals with interpolation', () => {
    const expr = conditionOf("get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin'");
    expect(expr).toMatchObject({
      kind: 'binary',
      op: '==',
      left: {
        kind: 'member',
        property: 'role',
        object: { kind: 'member', property: 'data', object: { kind: 'call', callee: { kind: 'ident', name: 'get' } } },
      },
    });
    const call = ((expr as { left: { object: { object: Expr } } }).left.object.object) as Extract<Expr, { kind: 'call' }>;
    const path = call.args[0] as Extract<Expr, { kind: 'path' }>;
    expect(path.pieces).toMatchObject([
      { kind: 'text', text: '/databases/' },
      { kind: 'expr', expr: { kind: 'ident', name: 'database' } },
      { kind: 'text', text: '/documents/users/' },
      { kind: 'expr', expr: { kind: 'member', property: 'uid' } },
    ]);
  });

  it('parses (default) path segments', () => {
    const expr = conditionOf('firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))');
    expect(expr).toMatchObject({ kind: 'call', args: [{ kind: 'path', pieces: [{ text: '/databases/(default)/documents/users/' }, { kind: 'expr' }] }] });
  });

  it('distinguishes division from paths', () => {
    expect(conditionOf('request.resource.size / 1024 < 10')).toMatchObject({
      kind: 'binary',
      op: '<',
      left: { kind: 'binary', op: '/', right: { kind: 'literal', value: 1024 } },
    });
  });

  it('applies operator precedence', () => {
    expect(conditionOf('a || b && !c')).toMatchObject({
      kind: 'binary',
      op: '||',
      left: { kind: 'ident', name: 'a' },
      right: { kind: 'binary', op: '&&', right: { kind: 'unary', op: '!' } },
    });
    expect(conditionOf('a + b * c == d')).toMatchObject({
      op: '==',
      left: { op: '+', right: { op: '*' } },
    });
  });

  it('parses ternaries, maps, lists, slices, is and raw strings', () => {
    expect(conditionOf("x ? {'a': 1, 'b': [1, 2]} : null")).toMatchObject({
      kind: 'ternary',
      consequent: { kind: 'map', entries: [{ key: { value: 'a' } }, { value: { kind: 'list' } }] },
    });
    expect(conditionOf('list[1:3].size() == 2 && x is string')).toMatchObject({ op: '&&', right: { op: 'is' } });
    expect(conditionOf("name.matches(r'^\\w+$')")).toMatchObject({ kind: 'call', args: [{ value: '^\\w+$' }] });
  });

  it('collects comments', () => {
    const file = parse('// one\nservice cloud.firestore { /* two */ }');
    expect(file.comments.map((c) => c.text)).toEqual([' one', ' two ']);
  });

  it('reports syntax errors with a position', () => {
    const [d] = lint("service cloud.firestore {\n  match /x {\n    allow read: if ;\n  }\n}\n", 'bad.rules');
    expect(d).toMatchObject({ ruleId: 'parse-error', severity: 'error', line: 3, column: 20 });
    expect(d!.message).toContain("found ';'");
  });

  it('reports unterminated strings and comments', () => {
    expect(lint("service cloud.firestore { match /x { allow read: if x == 'a; } }")[0]!.message).toBe('Unterminated string');
    expect(lint('service cloud.firestore { /* oops }')[0]!.message).toBe('Unterminated block comment');
  });
});
