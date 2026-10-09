import type { Rule, Severity } from './types.js';
export declare const rules: Rule[];
export declare const ruleIds: string[];
export declare function describeRules(): Array<{
    id: string;
    severity: Severity;
    description: string;
}>;
