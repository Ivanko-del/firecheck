#!/usr/bin/env node
import { run } from './run.js';

const color = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || !!process.env.GITHUB_ACTIONS || process.stdout.isTTY === true);

process.exitCode = run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  color,
  root: process.env.GITHUB_WORKSPACE || undefined,
});
