const READ_METHODS = new Set(['read', 'get', 'list']);
const WRITE_METHODS = new Set(['write', 'create', 'update', 'delete']);
const DAY_MS = 24 * 60 * 60 * 1000;
function grantsWrite(methods) {
    return methods.some((m) => WRITE_METHODS.has(m));
}
function verbs(methods) {
    const words = [...new Set(methods.map((m) => (m === 'get' ? 'read' : m)))];
    if (words.length <= 1)
        return words[0] ?? '';
    return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
function nouns(a) {
    return a.service === 'storage' ? 'files' : 'documents';
}
function at(a) {
    return `\`${a.path}\``;
}
function isTestMode(a) {
    const f = a.facts;
    return f.requestTime && f.dates.length > 0 && !f.auth && !f.resource && !f.lookup && f.pathVars.size === 0;
}
/** Checks that someone is signed in, but not who they are. */
function isAuthOnly(a) {
    const f = a.facts;
    return (a.constant === undefined &&
        f.auth &&
        !f.resource &&
        !f.lookup &&
        !f.authClaims &&
        !f.authAllowlist &&
        !f.ownerFromNewData &&
        f.pathVars.size === 0);
}
const SIGN_UP_NOTE = 'Anyone can create an account in your app, so "signed in" is not access control.';
export const rules = [
    {
        id: 'rules-version',
        severity: 'warning',
        description: "Rules file doesn't declare rules_version = '2'.",
        check(ctx, report) {
            if (ctx.file.services.length === 0)
                return;
            const version = ctx.file.version;
            if (version?.value === '2')
                return;
            report({
                message: version
                    ? `rules_version '${version.value}' is outdated; use '2'.`
                    : "Missing rules_version = '2'. Without it, version 1 is used: recursive wildcards behave differently and collection group queries don't work.",
                help: "Add `rules_version = '2';` as the first line.",
                span: version?.span ?? { start: 0, end: 0 },
            });
        },
    },
    {
        id: 'unknown-method',
        severity: 'error',
        description: 'allow statement uses a method that does not exist.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                for (const m of a.stmt.methods) {
                    if (READ_METHODS.has(m.name) || WRITE_METHODS.has(m.name))
                        continue;
                    report({
                        message: `Unknown method '${m.name}'.`,
                        help: 'Valid methods: read, get, list, write, create, update, delete.',
                        span: m.span,
                    });
                }
            }
        },
    },
    {
        id: 'catch-all',
        severity: 'error',
        description: 'Permissive rule on a recursive wildcard such as /{document=**}.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                if (!a.recursive)
                    continue;
                const who = a.constant === true ? 'anyone on the internet' : isAuthOnly(a) ? 'any signed-in user' : null;
                if (!who)
                    continue;
                report({
                    message: `Catch-all rule at ${at(a)} lets ${who} ${verbs(a.methods)} every ${a.service === 'storage' ? 'file' : 'document'} below it. Rules are OR'ed, so it overrides every more specific rule in this file.`,
                    help: 'Delete the catch-all and write explicit rules per collection. Paths without a matching rule are denied by default.',
                    span: a.stmt.span,
                });
            }
        },
    },
    {
        id: 'always-true',
        severity: 'error',
        description: 'Condition is always true (or missing), so access is public.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                if (a.constant !== true || a.recursive)
                    continue;
                const reason = a.stmt.condition ? 'the condition is always true' : 'the rule has no condition';
                const write = grantsWrite(a.methods);
                report({
                    severity: write ? 'error' : 'warning',
                    message: `Anyone on the internet can ${verbs(a.methods)} ${nouns(a)} at ${at(a)}: ${reason}.`,
                    help: write
                        ? 'Require the owner, e.g. `request.auth != null && request.auth.uid == userId`.'
                        : 'If this data is meant to be public, add `// firecheck-disable-next-line always-true` above the rule.',
                    span: a.stmt.span,
                });
            }
        },
    },
    {
        id: 'test-mode',
        severity: 'error',
        description: 'Access is controlled only by a date (Firebase "test mode").',
        check(ctx, report) {
            for (const a of ctx.allows) {
                if (!isTestMode(a))
                    continue;
                const until = new Date(Math.max(...a.facts.dates.map((d) => d.getTime())));
                const date = until.toISOString().slice(0, 10);
                const days = Math.ceil((until.getTime() - ctx.now.getTime()) / DAY_MS);
                if (days > 0) {
                    report({
                        message: `Test-mode rule: anyone on the internet can ${verbs(a.methods)} ${nouns(a)} at ${at(a)} until ${date} (${days} day${days === 1 ? '' : 's'} left).`,
                        help: 'Replace it with real rules before launch. An expiry date is not access control.',
                        span: a.stmt.span,
                    });
                }
                else {
                    report({
                        severity: 'warning',
                        message: `Test-mode rule expired on ${date}: every request to ${at(a)} is now denied.`,
                        help: 'Your app is probably failing right now. Replace this with real rules.',
                        span: a.stmt.span,
                    });
                }
            }
        },
    },
    {
        id: 'auth-only',
        severity: 'error',
        description: 'Checks that the user is signed in, but not that they own the data.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                if (a.recursive || !isAuthOnly(a))
                    continue;
                // Letting any user create (their own) records is a normal pattern.
                const methods = a.methods.filter((m) => m !== 'create');
                if (methods.length === 0)
                    continue;
                const write = grantsWrite(methods);
                report({
                    severity: write ? 'error' : 'warning',
                    message: `Any signed-in user can ${verbs(methods)} every ${a.service === 'storage' ? 'file' : 'document'} at ${at(a)}, including other users' data. ${SIGN_UP_NOTE}`,
                    help: write
                        ? 'Check ownership: `request.auth.uid == userId` (path variable) or `resource.data.ownerId == request.auth.uid`.'
                        : 'If every signed-in user may read this, add `// firecheck-disable-next-line auth-only`. Otherwise check ownership.',
                    span: a.stmt.span,
                });
            }
        },
    },
    {
        id: 'unauthenticated-write',
        severity: 'error',
        description: 'Write rule never checks request.auth, so no sign-in is needed.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                if (a.constant !== undefined || a.facts.auth || isTestMode(a) || !grantsWrite(a.methods))
                    continue;
                const methods = a.methods.filter((m) => WRITE_METHODS.has(m));
                // Anonymous create can be intentional (contact forms, sign-up queues); changing existing data rarely is.
                const createOnly = methods.every((m) => m === 'create');
                report({
                    severity: createOnly ? 'warning' : 'error',
                    message: `Anyone on the internet can ${verbs(methods)} ${nouns(a)} at ${at(a)} without signing in: the condition never checks \`request.auth\`.`,
                    help: createOnly
                        ? 'If anonymous submissions are intended, validate the data strictly and consider App Check. Otherwise require `request.auth != null`.'
                        : 'Require a signed-in owner, e.g. `request.auth != null && resource.data.ownerId == request.auth.uid`.',
                    span: a.stmt.span,
                });
            }
        },
    },
    {
        id: 'owner-from-new-data',
        severity: 'error',
        description: 'Update rule trusts the owner field sent by the client.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                const f = a.facts;
                if (!a.methods.includes('update') && !a.methods.includes('write'))
                    continue;
                if (!f.ownerFromNewData || f.resource || f.lookup || f.authClaims || f.authAllowlist || f.pathVars.size > 0)
                    continue;
                report({
                    message: `Ownership at ${at(a)} is checked only on the incoming data. Any signed-in user can take over existing ${nouns(a)} by sending their own uid as the owner.`,
                    help: a.service === 'storage'
                        ? 'Tie the file to its owner through the path: `match /users/{userId}/{file}` with `request.auth.uid == userId`.'
                        : 'Also check the stored document on update: `resource.data.ownerId == request.auth.uid`. Checking `request.resource.data` alone is only safe on create.',
                    span: a.stmt.span,
                });
            }
        },
    },
    {
        id: 'resource-on-create',
        severity: 'warning',
        description: 'create rule reads `resource`, which is null on create.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                if (!a.methods.includes('create') || !a.facts.resource || a.constant !== undefined)
                    continue;
                report({
                    message: `\`resource\` is null on create (nothing is stored yet), so this create rule at ${at(a)} will deny requests.`,
                    help: 'Use `request.resource.data` for the incoming document on create.',
                    span: a.stmt.span,
                });
            }
        },
    },
    {
        id: 'storage-upload-limits',
        severity: 'warning',
        description: 'Storage upload rule has no size or content-type limit.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                if (a.service !== 'storage' || a.constant === false)
                    continue;
                if (!a.methods.some((m) => m === 'write' || m === 'create' || m === 'update'))
                    continue;
                const missing = [];
                if (!a.facts.requestResourceSize)
                    missing.push('size limit');
                if (!a.facts.requestResourceContentType)
                    missing.push('content-type check');
                if (missing.length === 0)
                    continue;
                report({
                    message: `Uploads to ${at(a)} have no ${missing.join(' and no ')}: files of any ${missing.length === 2 ? 'size and type' : missing[0] === 'size limit' ? 'size' : 'type'} are accepted, and you pay for the storage and bandwidth.`,
                    help: "Add e.g. `request.resource.size < 5 * 1024 * 1024 && request.resource.contentType.matches('image/.*')`.",
                    span: a.stmt.span,
                });
            }
        },
    },
    {
        id: 'no-validation',
        severity: 'info',
        description: 'Write rule never validates the incoming data.',
        check(ctx, report) {
            for (const a of ctx.allows) {
                if (a.service !== 'firestore' || a.constant !== undefined || a.facts.requestResource)
                    continue;
                // Reported more severely by other rules; admins (custom claims) are trusted.
                if (!a.facts.auth || isAuthOnly(a) || isTestMode(a) || a.facts.authClaims)
                    continue;
                const methods = a.methods.filter((m) => m === 'write' || m === 'create' || m === 'update');
                if (methods.length === 0)
                    continue;
                report({
                    message: `${capitalize(verbs(methods))} at ${at(a)} accepts any data: the condition never checks \`request.resource.data\`, so clients can write any fields of any size.`,
                    help: "Validate the shape, e.g. `request.resource.data.keys().hasOnly(['title', 'body']) && request.resource.data.title is string && request.resource.data.title.size() <= 200`.",
                    span: a.stmt.span,
                });
            }
        },
    },
];
export const ruleIds = ['parse-error', ...rules.map((r) => r.id)];
export function describeRules() {
    return [
        { id: 'parse-error', severity: 'error', description: 'The rules file has a syntax error.' },
        ...rules.map(({ id, severity, description }) => ({ id, severity, description })),
    ];
}
