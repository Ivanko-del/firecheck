import type { Diagnostic } from './types.js';
export type FormatName = 'pretty' | 'json' | 'github' | 'sarif';
export declare const FORMATS: FormatName[];
export interface FormatOptions {
    /** Files that were checked, relative paths as they should be printed. */
    files: string[];
    color?: boolean;
    version?: string;
}
export declare function format(name: FormatName, diagnostics: Diagnostic[], options: FormatOptions): string;
