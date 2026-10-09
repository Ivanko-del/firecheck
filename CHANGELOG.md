# Changelog

## 0.1.0

First release.

- Rules: `catch-all`, `always-true`, `test-mode`, `auth-only`, `unauthenticated-write`, `owner-from-new-data`, `resource-on-create`, `storage-upload-limits`, `rules-version`, `unknown-method`, `no-validation`.
- Follows helper functions, their parameters and `let` bindings.
- Finds rules files through `firebase.json`, including multiple databases and buckets.
- Output formats: pretty, JSON, GitHub annotations, SARIF.
- GitHub Action.
- Inline suppressions: `firecheck-disable-next-line`, `firecheck-disable-line`, `firecheck-disable`.
