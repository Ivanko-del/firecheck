import type { Diagnostic } from './types.js';
export interface LintOptions {
    /** Rule ids to skip. */
    disable?: string[];
    /** Reference time for test-mode expiry checks. Defaults to now. */
    now?: Date;
}
export declare function lint(source: string, file?: string, options?: LintOptions): Diagnostic[];
