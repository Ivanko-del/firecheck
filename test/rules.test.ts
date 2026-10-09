import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/linter.js';
import type { Diagnostic } from '../src/types.js';

const NOW = new Date('2026-10-09T12:00:00Z');

function firestore(body: string): string {
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${body}\n  }\n}\n`;
}

function storage(body: string): string {
  return `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n${body}\n  }\n}\n`;
}

function check(source: string): Diagnostic[] {
  return lint(source, 'test.rules', { now: NOW });
}

function ids(source: string): string[] {
  return check(source).map((d) => d.ruleId);
}

function only(source: string, ruleId: string): Diagnostic[] {
  return check(source).filter((d) => d.ruleId === ruleId);
}

describe('always-true', () => {
  it('flags public writes as errors', () => {
    const [d] = only(firestore('match /posts/{id} { allow read, write: if true; }'), 'always-true');
    expect(d).toMatchObject({ severity: 'error', line: 4 });
    expect(d!.message).toContain('Anyone on the internet can read and write documents at `/posts/{id}`');
  });

  it('flags public reads as warnings', () => {
    expect(only(firestore('match /posts/{id} { allow read: if true; }'), 'always-true')[0]!.severity).toBe('warning');
  });

  it('flags bare allow statements', () => {
    const [d] = only(storage('match /public/{f} { allow write; }'), 'always-true');
    expect(d!.message).toContain('the rule has no condition');
    expect(d!.message).toContain('files');
  });

  it('sees through constant expressions and helper functions', () => {
    expect(ids(firestore('match /a/{id} { allow write: if request.auth != null || true; }'))).toContain('always-true');
    expect(ids(firestore("match /a/{id} { allow write: if 'x' == 'x'; }"))).toContain('always-true');
    expect(ids(firestore('function open() { return true; } match /a/{id} { allow write: if open(); }'))).toContain('always-true');
  });

  it('ignores conditions that depend on the request', () => {
    expect(ids(firestore('match /a/{id} { allow write: if request.auth.uid == id; }'))).not.toContain('always-true');
    expect(ids(firestore('match /a/{id} { allow write: if false; }'))).toEqual([]);
  });
});

describe('catch-all', () => {
  it('flags an open recursive wildcard', () => {
    const found = check(firestore('match /{document=**} { allow read, write: if true; }'));
    expect(found.map((d) => d.ruleId)).toEqual(['catch-all']);
    expect(found[0]!.message).toContain('overrides every more specific rule');
  });

  it('flags the default storage rules', () => {
    expect(ids(storage('match /{allPaths=**} { allow read: if request.auth != null; }'))).toEqual(['catch-all']);
  });

  it('accepts recursive wildcards scoped to the owner', () => {
    const src = firestore('match /users/{userId}/{doc=**} { allow read: if request.auth.uid == userId; }');
    expect(ids(src)).toEqual([]);
  });

  it('accepts admin-only catch-alls', () => {
    expect(ids(firestore('match /{d=**} { allow read: if request.auth.token.admin == true; }'))).toEqual([]);
  });
});

describe('test-mode', () => {
  it('flags active test mode with the remaining days', () => {
    const [d] = only(firestore('match /{document=**} { allow read, write: if request.time < timestamp.date(2026, 11, 8); }'), 'test-mode');
    expect(d).toMatchObject({ severity: 'error' });
    expect(d!.message).toContain('until 2026-11-08 (30 days left)');
  });

  it('warns about expired test mode', () => {
    const [d] = only(firestore('match /a/{id} { allow read: if request.time < timestamp.date(2025, 1, 1); }'), 'test-mode');
    expect(d).toMatchObject({ severity: 'warning' });
    expect(d!.message).toContain('expired on 2025-01-01');
  });

  it('is not reported as catch-all or auth-only', () => {
    expect(ids(firestore('match /{d=**} { allow read: if request.time < timestamp.date(2026, 11, 8); }'))).toEqual(['test-mode']);
  });

  it('ignores time checks combined with ownership', () => {
    const src = firestore('match /a/{id} { allow read: if request.auth.uid == id && request.time < timestamp.date(2027, 1, 1); }');
    expect(ids(src)).not.toContain('test-mode');
  });
});

describe('auth-only', () => {
  it('flags signed-in-only writes as errors', () => {
    const [d] = only(firestore('match /orders/{id} { allow read, write: if request.auth != null; }'), 'auth-only');
    expect(d).toMatchObject({ severity: 'error' });
    expect(d!.message).toContain('Any signed-in user can read and write every document at `/orders/{id}`');
  });

  it('flags signed-in-only reads as warnings', () => {
    expect(only(firestore('match /orders/{id} { allow read: if request.auth != null; }'), 'auth-only')[0]!.severity).toBe('warning');
  });

  it('sees through helper functions', () => {
    const src = firestore('function signedIn() { return request.auth != null; }\nmatch /a/{id} { allow update: if signedIn(); }');
    expect(ids(src)).toContain('auth-only');
  });

  it('treats email_verified as not being authorization', () => {
    expect(ids(firestore('match /a/{id} { allow delete: if request.auth.token.email_verified == true; }'))).toContain('auth-only');
  });

  it('allows any signed-in user to create', () => {
    expect(ids(firestore('match /a/{id} { allow create: if request.auth != null && request.resource.data.x is string; }'))).toEqual([]);
  });

  it.each([
    ['path variable', 'request.auth.uid == id'],
    ['stored owner', 'resource.data.owner == request.auth.uid'],
    ['role lookup', "get(/databases/$(database)/documents/roles/$(request.auth.uid)).data.role == 'admin'"],
    ['membership lookup', 'exists(/databases/$(database)/documents/members/$(request.auth.uid))'],
    ['cross-service lookup', 'firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.isAdmin == true'],
    ['custom claim', 'request.auth.token.admin == true'],
    ['uid allowlist', "request.auth.uid in ['abc', 'def']"],
    ['email domain', "request.auth.token.email.matches('.*@example[.]com$')"],
  ])('accepts %s', (_, condition) => {
    expect(ids(firestore(`match /a/{id} { allow read, delete: if request.auth != null && ${condition}; }`))).not.toContain('auth-only');
  });

  it('resolves function parameters bound to path variables', () => {
    const src = firestore('function isOwner(uid) { let me = request.auth.uid; return me == uid; }\nmatch /users/{userId} { allow read, delete: if isOwner(userId); }');
    expect(ids(src)).toEqual([]);
  });
});

describe('owner-from-new-data', () => {
  it('flags updates that trust the incoming owner field', () => {
    const [d] = only(firestore('match /p/{id} { allow update: if request.auth.uid == request.resource.data.ownerId; }'), 'owner-from-new-data');
    expect(d).toMatchObject({ severity: 'error' });
    expect(d!.message).toContain('take over existing documents');
  });

  it('accepts updates that also check the stored owner', () => {
    const src = firestore(`match /p/{id} { allow update: if request.auth.uid == resource.data.ownerId
      && request.resource.data.ownerId == resource.data.ownerId; }`);
    expect(ids(src)).toEqual([]);
  });

  it('flags Storage metadata ownership on write', () => {
    const src = storage("match /u/{uid}/{f} { allow write: if request.resource.metadata.owner == request.auth.uid && request.resource.size < 100 && request.resource.contentType == 'image/png'; }");
    const [d] = only(src, 'owner-from-new-data');
    expect(d!.message).toContain('take over existing files');
  });

  it('accepts the same check on create', () => {
    expect(ids(firestore('match /p/{id} { allow create: if request.auth.uid == request.resource.data.ownerId; }'))).toEqual([]);
  });
});

describe('unauthenticated-write', () => {
  it('flags writes that never check request.auth', () => {
    const [d] = only(firestore("match /cities/{id} { allow update: if request.resource.data.diff(resource.data).affectedKeys().hasOnly(['population']); }"), 'unauthenticated-write');
    expect(d).toMatchObject({ severity: 'error' });
    expect(d!.message).toContain('without signing in');
  });

  it('flags anonymous uploads', () => {
    expect(ids(storage('match /f/{name} { allow write: if request.resource.size < 1000; }'))).toContain('unauthenticated-write');
  });

  it('only warns about anonymous create', () => {
    const [d] = only(firestore('match /feedback/{id} { allow create: if request.resource.data.text is string; }'), 'unauthenticated-write');
    expect(d).toMatchObject({ severity: 'warning' });
  });

  it('ignores public reads and authenticated writes', () => {
    expect(ids(firestore("match /a/{id} { allow read: if resource.data.visibility == 'public'; }"))).toEqual([]);
    expect(ids(firestore('match /a/{id} { allow delete: if request.auth.uid == resource.data.owner; }'))).toEqual([]);
  });
});

describe('resource-on-create', () => {
  it('flags create rules that read resource', () => {
    expect(ids(firestore('match /p/{id} { allow create: if resource.data.owner == request.auth.uid; }'))).toContain('resource-on-create');
  });

  it('accepts an existence check', () => {
    const src = firestore('match /p/{id} { allow create: if resource == null && request.auth.uid == request.resource.data.owner; }');
    expect(ids(src)).toEqual([]);
  });

  it('accepts request.resource on create', () => {
    expect(ids(firestore('match /p/{id} { allow create: if request.resource.data.owner == request.auth.uid; }'))).not.toContain('resource-on-create');
  });
});

describe('storage-upload-limits', () => {
  it('flags uploads without size and type checks', () => {
    const [d] = only(storage('match /u/{uid}/{f} { allow write: if request.auth.uid == uid; }'), 'storage-upload-limits');
    expect(d!.message).toContain('no size limit and no content-type check');
  });

  it('names only what is missing', () => {
    const [d] = only(storage('match /u/{uid}/{f} { allow write: if request.auth.uid == uid && request.resource.size < 1000; }'), 'storage-upload-limits');
    expect(d!.message).toContain('no content-type check');
    expect(d!.message).not.toContain('size limit');
  });

  it('accepts uploads with both checks', () => {
    const src = storage("match /u/{uid}/{f} { allow write: if request.auth.uid == uid && request.resource.size < 1000 && request.resource.contentType.matches('image/.*'); }");
    expect(ids(src)).toEqual([]);
  });

  it('ignores reads and Firestore', () => {
    expect(ids(storage('match /u/{uid}/{f} { allow read: if request.auth.uid == uid; }'))).toEqual([]);
    expect(ids(firestore('match /u/{uid} { allow write: if request.auth.uid == uid && request.resource.data.a is int; }'))).toEqual([]);
  });
});

describe('no-validation', () => {
  it('notes owner-checked writes that accept any data', () => {
    const [d] = only(firestore('match /u/{uid} { allow write: if request.auth.uid == uid; }'), 'no-validation');
    expect(d).toMatchObject({ severity: 'info' });
  });

  it('accepts validated writes and plain deletes', () => {
    expect(ids(firestore("match /u/{uid} { allow write: if request.auth.uid == uid && request.resource.data.keys().hasOnly(['a']); }"))).toEqual([]);
    expect(ids(firestore('match /u/{uid} { allow delete: if request.auth.uid == uid; }'))).toEqual([]);
  });
});

describe('rules-version', () => {
  it('warns when missing or outdated', () => {
    const src = 'service cloud.firestore { match /databases/{database}/documents { } }';
    expect(check(src)[0]).toMatchObject({ ruleId: 'rules-version', severity: 'warning', line: 1, column: 1 });
    expect(check(`rules_version = '1';\n${src}`)[0]!.message).toContain("'1' is outdated");
    expect(check(`rules_version = '2';\n${src}`)).toEqual([]);
  });
});

describe('unknown-method', () => {
  it('flags typos in method names', () => {
    const [d] = only(firestore('match /a/{id} { allow rad: if false; }'), 'unknown-method');
    expect(d).toMatchObject({ severity: 'error', line: 4, column: 23 });
    expect(d!.message).toBe("Unknown method 'rad'.");
  });
});

describe('suppressions', () => {
  const rule = 'match /posts/{id} { allow read: if true; }';

  it('supports disable-next-line with a reason', () => {
    expect(ids(firestore(`// firecheck-disable-next-line always-true -- public feed\n${rule}`))).toEqual([]);
  });

  it('supports disable-line and block comments', () => {
    expect(ids(firestore(`${rule} /* firecheck-disable-line */`))).toEqual([]);
  });

  it('supports file-wide disables', () => {
    expect(ids(`// firecheck-disable rules-version, always-true\n${firestore(rule)}`)).toEqual([]);
  });

  it('only disables the named rules', () => {
    expect(ids(firestore(`// firecheck-disable-next-line auth-only\n${rule}`))).toEqual(['always-true']);
  });

  it('supports the disable option', () => {
    expect(lint(firestore(rule), 'x', { disable: ['always-true'] })).toEqual([]);
  });
});

describe('performance', () => {
  it('stays fast when functions call each other repeatedly', () => {
    const fns = Array.from({ length: 30 }, (_, i) => `function f${i}() { return f${i + 1}() && f${i + 1}() || f${i + 1}(); }`).join('\n');
    const src = firestore(`${fns}\nfunction f30() { return request.auth != null; }\nmatch /a/{id} { allow read: if f0(); }`);
    const start = performance.now();
    check(src);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('examples', () => {
  const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');

  it('finds every problem in insecure.rules', () => {
    expect(new Set(ids(example('insecure.rules')))).toEqual(
      new Set(['rules-version', 'test-mode', 'auth-only', 'owner-from-new-data', 'resource-on-create', 'no-validation', 'catch-all']),
    );
  });

  it('finds nothing in secure.rules', () => {
    expect(check(example('secure.rules'))).toEqual([]);
  });

  it('flags the default storage rules in storage.rules', () => {
    expect(ids(example('storage.rules'))).toEqual(['catch-all', 'storage-upload-limits', 'auth-only']);
  });
});
