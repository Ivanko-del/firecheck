# firecheck

**Find the holes in your Firebase security rules before someone else does.**

[![CI](https://github.com/ivanko-del/firecheck/actions/workflows/ci.yml/badge.svg)](https://github.com/ivanko-del/firecheck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

firecheck is a security linter for **Cloud Firestore** and **Cloud Storage** rules. It reads your `firestore.rules` and `storage.rules`, understands what each condition actually checks, and tells you who can read or write your data, in plain English.

```sh
npx firecheck
```

No config, no Firebase login, no emulator. It reads `firebase.json` to find your rules, runs in under a second, and has zero runtime dependencies.

```
$ npx firecheck examples/insecure.rules

examples/insecure.rules
  1:1     warning Missing rules_version = '2'. Without it, version 1 is used: recursive wildcards behave differently and collection group queries don't work.  rules-version
                  ↳ Add `rules_version = '2';` as the first line.
  6:7     error   Test-mode rule: anyone on the internet can read and write documents at `/drafts/{draftId}` until 2027-01-01 (84 days left).  test-mode
                  ↳ Replace it with real rules before launch. An expiry date is not access control.
  11:7    error   Any signed-in user can read and write every document at `/orders/{orderId}`, including other users' data. Anyone can create an account in your app, so "signed in" is not access control.  auth-only
                  ↳ Check ownership: `request.auth.uid == userId` (path variable) or `resource.data.ownerId == request.auth.uid`.
  16:7    error   Ownership at `/profiles/{profileId}` is checked only on the incoming data. Any signed-in user can take over existing documents by sending their own uid as the owner.  owner-from-new-data
                  ↳ Also check the stored document on update: `resource.data.ownerId == request.auth.uid`. Checking `request.resource.data` alone is only safe on create.
  21:7    warning `resource` is null on create (nothing is stored yet), so this create rule at `/posts/{postId}` will deny requests.  resource-on-create
                  ↳ Use `request.resource.data` for the incoming document on create.
  21:7    info    Create at `/posts/{postId}` accepts any data: the condition never checks `request.resource.data`, so clients can write any fields of any size.  no-validation
                  ↳ Validate the shape, e.g. `request.resource.data.keys().hasOnly(['title', 'body']) && request.resource.data.title is string && request.resource.data.title.size() <= 200`.
  26:7    error   Catch-all rule at `/{document=**}` lets anyone on the internet read and write every document below it. Rules are OR'ed, so it overrides every more specific rule in this file.  catch-all
                  ↳ Delete the catch-all and write explicit rules per collection. Paths without a matching rule are denied by default.

✖ 7 problems (4 errors, 2 warnings, 1 info)
```

## Why

Firebase apps talk to the database straight from the browser. The security rules are the only thing standing between your users' data and anyone who opens DevTools. The mistakes are always the same ones: test-mode rules that ship to production, a leftover `/{document=**}` catch-all, `request.auth != null` used as if it were access control. Firebase's own docs list them in [Avoid insecure rules](https://firebase.google.com/docs/rules/insecure-rules).

Rules tests in the emulator are great, but you only test what you thought of. firecheck catches the known mistakes on every commit, with no tests to write.

## What it catches

| Rule | Severity | What it means |
| --- | --- | --- |
| [`catch-all`](#catch-all) | error | A permissive `/{document=**}` rule overrides every other rule in the file |
| [`always-true`](#always-true) | error / warning | `if true`, or no condition at all: anyone on the internet has access |
| [`test-mode`](#test-mode) | error | Access depends only on a date (Firebase "test mode") |
| [`auth-only`](#auth-only) | error / warning | Checks that a user is signed in, but not that they own the data |
| [`unauthenticated-write`](#unauthenticated-write) | error / warning | A write rule never looks at `request.auth` |
| [`owner-from-new-data`](#owner-from-new-data) | error | An update rule trusts the owner field sent by the client |
| [`resource-on-create`](#resource-on-create) | warning | A create rule reads `resource`, which is null on create |
| [`storage-upload-limits`](#storage-upload-limits) | warning | Uploads have no size limit or content-type check |
| [`rules-version`](#rules-version) | warning | Missing `rules_version = '2'` |
| [`unknown-method`](#unknown-method) | error | Typo in a method name, e.g. `allow rad` |
| [`no-validation`](#no-validation) | info | A write rule never validates the incoming data |
| `parse-error` | error | The file has a syntax error |

firecheck parses the rules language properly. It follows your helper functions, their parameters and `let` bindings, so `allow write: if isOwner(userId)` is understood the same as writing the check inline.

## Use it in GitHub Actions

Problems show up as annotations on the pull request, right on the offending line.

```yaml
# .github/workflows/firebase-rules.yml
name: Firebase rules
on: [push, pull_request]

jobs:
  firecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ivanko-del/firecheck@main
        # Optional:
        # with:
        #   files: firestore.rules storage.rules   # default: read firebase.json
        #   fail-on: warning                       # error (default), warning, info, never
        #   disable: no-validation                 # comma-separated rule ids
        #   working-directory: ./backend           # where firebase.json lives
```

### GitHub code scanning (SARIF)

```yaml
      - run: npx firecheck --format sarif --fail-on never > firecheck.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: firecheck.sarif
```

## CLI

```
firecheck [files...] [options]

  -f, --format <name>     pretty (default), json, github, sarif
      --fail-on <level>   exit 1 on problems at this level or above:
                          error (default), warning, info, never
      --disable <ids>     comma-separated rule ids to skip
  -q, --quiet             report errors only
      --list-rules        print all rules and exit
```

With no files, firecheck reads the `firestore` and `storage` entries of `firebase.json` (multiple databases and buckets are supported). Without a `firebase.json`, it checks every `*.rules` file in the project.

Exit codes: `0` no problems at the `--fail-on` level, `1` problems found, `2` usage error or unreadable file.

## Suppressing a finding

Some data really is public. Say so in the rules file, and leave a reason for the next person:

```
match /products/{productId} {
  // firecheck-disable-next-line always-true -- public product catalog
  allow read: if true;
}
```

- `// firecheck-disable-next-line [rule-ids]` covers the next line
- `// firecheck-disable-line [rule-ids]` covers the same line
- `// firecheck-disable [rule-ids]` covers the whole file

Without rule ids, every rule is suppressed. Anything after `--` is ignored.

## Rules

### catch-all

Rules are OR'ed: if *any* matching rule allows a request, it goes through. A permissive recursive wildcard therefore cancels every careful rule you wrote for individual collections.

```
// ❌ every document is public, whatever the rules above say
match /{document=**} {
  allow read, write: if true;
}

// ❌ the default Storage rules: any signed-in user can read and overwrite every file
match /{allPaths=**} {
  allow read, write: if request.auth != null;
}
```

Fix: delete the catch-all. Paths that no rule matches are denied by default.

### always-true

```
allow write: if true;      // ❌ anyone on the internet
allow read, write;         // ❌ no condition means no restriction
allow read: if true;       // ⚠️ warning: fine for public data, suppress it if intended
```

Writes are errors, reads are warnings.

### test-mode

```
// ❌ open to everyone until the date, then everything breaks
allow read, write: if request.time < timestamp.date(2026, 11, 8);
```

Active test mode is an error. Once the date has passed it becomes a warning, because every request to that path is now denied and your app is probably broken.

### auth-only

Anyone can create an account in your app, usually with one click. "Signed in" is not the same as "allowed".

```
// ❌ any user can read and delete every order
match /orders/{orderId} {
  allow read, write: if request.auth != null;
}

// ✅
match /orders/{orderId} {
  allow read, delete: if request.auth != null && resource.data.userId == request.auth.uid;
}
```

firecheck accepts a rule as authorization when it compares against a path variable (`request.auth.uid == userId`), reads the stored document (`resource.data`), looks something up (`get()`/`exists()`), checks a custom claim (`request.auth.token.admin`), or checks the uid or email against fixed values. `create` is not flagged, since letting any user create records is a normal pattern. Writes are errors, reads are warnings.

### unauthenticated-write

```
// ❌ no sign-in needed to change anyone's data
allow update: if request.resource.data.diff(resource.data).affectedKeys().hasOnly(['likes']);
```

Anonymous `create` is only a warning, because contact forms and waitlists sometimes need it. Anonymous update and delete are errors.

### owner-from-new-data

`request.resource.data` is whatever the client sent. On update, checking the owner only there lets anyone overwrite someone else's document by putting their own uid in the request.

```
// ❌ take over any profile
allow update: if request.auth.uid == request.resource.data.ownerId;

// ✅ check the stored owner, and keep it from changing
allow update: if request.auth.uid == resource.data.ownerId
  && request.resource.data.ownerId == resource.data.ownerId;
```

### resource-on-create

On create, nothing is stored yet, so `resource` is null and the rule denies every request.

```
allow create: if resource.data.authorId == request.auth.uid;          // ❌ never passes
allow create: if request.resource.data.authorId == request.auth.uid;  // ✅
```

### storage-upload-limits

Without limits, any user who passes your rule can upload a 5 GB video into your avatar folder, and you pay for storing and serving it.

```
allow write: if request.auth.uid == userId
  && request.resource.size < 5 * 1024 * 1024
  && request.resource.contentType.matches('image/.*');
```

### rules-version

Without `rules_version = '2';`, Firestore uses version 1: recursive wildcards match differently and collection group queries don't work.

### unknown-method

Valid methods are `read`, `get`, `list`, `write`, `create`, `update` and `delete`.

### no-validation

Informational. A write rule that checks the owner but never looks at `request.resource.data` lets the owner store any fields of any size:

```
allow write: if request.auth.uid == userId
  && request.resource.data.keys().hasOnly(['name', 'bio'])
  && request.resource.data.name is string
  && request.resource.data.name.size() <= 100;
```

## Node.js API

```ts
import { lint } from 'firecheck';

const problems = lint(source, 'firestore.rules');
// [{ ruleId, severity, message, help, file, line, column, endLine, endColumn }]
```

`parse(source)` returns the syntax tree if you want to build your own checks.

## Limitations

firecheck is static analysis. It finds known patterns of mistakes, not every logic bug, and it is not a replacement for [rules unit tests](https://firebase.google.com/docs/rules/unit-tests). Realtime Database rules (`database.rules.json`) are not supported yet.

## Roadmap

- Realtime Database rules
- Cost checks for client code: unbounded `onSnapshot` listeners, queries without `limit()`
- VS Code extension
- pre-commit hook

Ideas and false-positive reports are welcome in [issues](https://github.com/ivanko-del/firecheck/issues).

## Contributing

```sh
npm install
npm test        # vitest
npm run check   # typecheck + tests + build
```

Each rule lives in [`src/rules.ts`](src/rules.ts) and gets a test in [`test/rules.test.ts`](test/rules.test.ts), with at least one case it must flag and one it must not. The GitHub Action runs the committed `dist/`, so run `npm run build` before you commit.

## License

[MIT](LICENSE)
