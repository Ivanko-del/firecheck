export interface RunIO {
    cwd: string;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    color: boolean;
    /** Paths are printed relative to this directory (e.g. the repository root in CI). Defaults to cwd. */
    root?: string;
    now?: Date;
}
export declare function version(): string;
/** Runs the CLI and returns the exit code: 0 clean, 1 problems found, 2 usage or I/O error. */
export declare function run(argv: string[], io: RunIO): number;
