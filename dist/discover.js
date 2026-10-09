import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.firebase', '.turbo', '.vercel']);
const MAX_DEPTH = 5;
/**
 * Finds rules files the way the Firebase CLI would: from firebase.json
 * ("firestore" and "storage" entries), falling back to any *.rules file.
 */
export function discoverRulesFiles(cwd) {
    const configPath = join(cwd, 'firebase.json');
    if (existsSync(configPath)) {
        let config;
        try {
            config = JSON.parse(readFileSync(configPath, 'utf8'));
        }
        catch (err) {
            throw new Error(`Could not parse firebase.json: ${err.message}`);
        }
        const files = rulesFromConfig(config).map((f) => resolve(cwd, f));
        if (files.length > 0)
            return { files: [...new Set(files)], source: 'firebase.json' };
    }
    return { files: search(cwd, 0).sort(), source: 'search' };
}
function rulesFromConfig(config) {
    if (!config || typeof config !== 'object')
        return [];
    const out = [];
    for (const key of ['firestore', 'storage']) {
        const entry = config[key];
        const entries = Array.isArray(entry) ? entry : [entry];
        for (const e of entries) {
            const rules = e && typeof e === 'object' ? e.rules : undefined;
            if (typeof rules === 'string')
                out.push(rules);
        }
    }
    return out;
}
function search(dir, depth) {
    if (depth > MAX_DEPTH)
        return [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
                out.push(...search(full, depth + 1));
        }
        else if (entry.isFile() && entry.name.endsWith('.rules')) {
            out.push(full);
        }
    }
    return out;
}
