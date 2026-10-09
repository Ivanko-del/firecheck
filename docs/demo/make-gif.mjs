// Regenerates docs/demo.gif from the real output of firecheck on this folder.
//
// Needs a build (npm run build), ffmpeg, and Playwright with Chromium:
//   npm install --no-save playwright && npx playwright install chromium
//   node docs/demo/make-gif.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const output = join(root, 'docs', 'demo.gif');
// CommonJS resolution honours NODE_PATH, so a global Playwright install works too.
const { chromium } = createRequire(import.meta.url)('playwright');

const COMMAND = 'npx firecheck';
const PROMPT = '<span class="dir">~/my-app</span> <span class="dollar">$</span> ';
const WIDTH = 1000;
const SCALE = 2;

// ---- the real output ----------------------------------------------------

const env = { ...process.env, FORCE_COLOR: '1' };
delete env.NO_COLOR;
delete env.GITHUB_WORKSPACE;
const result = spawnSync(process.execPath, [join(root, 'dist', 'cli.js')], { cwd: here, env, encoding: 'utf8' });
if (result.status !== 1) throw new Error(`expected firecheck to find problems, got exit ${result.status}\n${result.stderr}`);

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ansiToHtml(text) {
  let html = '';
  let open = 0;
  let last = 0;
  for (const m of text.matchAll(/\x1b\[(\d+)m/g)) {
    html += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] === '0') {
      html += '</span>'.repeat(open);
      open = 0;
    } else {
      html += `<span class="c${m[1]}">`;
      open++;
    }
  }
  return html + escapeHtml(text.slice(last)) + '</span>'.repeat(open);
}

// Wrapped lines continue under the message, not at the left edge.
function hangingIndent(line) {
  const plain = line.replace(/\x1b\[\d+m/g, '');
  if (/^ {2}\d+:\d+/.test(plain)) return 18;
  if (/^ {18}↳/.test(plain)) return 20;
  return 0;
}

const outputHtml = result.stdout
  .replace(/\n$/, '')
  .split('\n')
  .map((line) => `<div class="line" style="padding-left:${hangingIndent(line)}ch;text-indent:-${hangingIndent(line)}ch">${ansiToHtml(line) || '&nbsp;'}</div>`)
  .join('');

// ---- frames ---------------------------------------------------------------

const cursor = (on) => `<span class="cursor${on ? '' : ' off'}">&nbsp;</span>`;
const promptLine = (typed, cursorOn) => `<div class="line">${PROMPT}${escapeHtml(typed)}${cursorOn === undefined ? '' : cursor(cursorOn)}</div>`;

const frames = [];
frames.push({ html: promptLine('', true), ms: 600 });
frames.push({ html: promptLine('', false), ms: 400 });
for (let i = 1; i <= COMMAND.length; i++) {
  frames.push({ html: promptLine(COMMAND.slice(0, i), true), ms: COMMAND[i - 1] === ' ' ? 140 : 75 });
}
frames.push({ html: promptLine(COMMAND, true), ms: 500 });
const done = (on) => promptLine(COMMAND) + outputHtml + '<div class="line">&nbsp;</div>' + promptLine('', on);
// Long enough to read the findings before the loop restarts.
for (let i = 0; i < 15; i++) frames.push({ html: done(i % 2 === 0), ms: 600 });

// ---- render ---------------------------------------------------------------

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #0d1117; }
  .window { width: ${WIDTH}px; background: #0d1117; color: #e6edf3; font: 14px/1.55 'DejaVu Sans Mono', 'Menlo', monospace; }
  .bar { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #161b22; border-bottom: 1px solid #30363d; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { flex: 1; text-align: center; margin-right: 54px; color: #8b949e; font: 13px 'DejaVu Sans', sans-serif; }
  .screen { padding: 16px 20px 20px; white-space: pre-wrap; overflow-wrap: anywhere; box-sizing: border-box; }
  .dir { color: #58a6ff; } .dollar { color: #3fb950; }
  .cursor { background: #e6edf3; } .cursor.off { background: transparent; }
  .c1 { font-weight: bold; } .c2 { color: #8b949e; } .c4 { text-decoration: underline; }
  .c31 { color: #ff7b72; } .c32 { color: #3fb950; } .c33 { color: #e3b341; } .c34 { color: #79c0ff; } .c36 { color: #56d4dd; }
</style></head><body>
  <div class="window">
    <div class="bar">
      <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
      <span class="title">my-app — bash</span>
    </div>
    <div class="screen" id="screen"></div>
  </div>
</body></html>`;

const workDir = mkdtempSync(join(tmpdir(), 'firecheck-demo-'));
const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: WIDTH, height: 800 }, deviceScaleFactor: SCALE });
  await tab.setContent(page);
  const setScreen = (html) => tab.evaluate((h) => (document.getElementById('screen').innerHTML = h), html);

  // Every frame gets the height of the last (tallest) one.
  await setScreen(frames[frames.length - 1].html);
  const height = await tab.evaluate(() => document.getElementById('screen').getBoundingClientRect().height);
  await tab.evaluate((h) => (document.getElementById('screen').style.height = `${h}px`), height);

  const list = ['ffconcat version 1.0'];
  for (const [i, frame] of frames.entries()) {
    const file = join(workDir, `frame-${String(i).padStart(3, '0')}.png`);
    await setScreen(frame.html);
    await tab.locator('.window').screenshot({ path: file });
    list.push(`file '${file}'`, `duration ${frame.ms / 1000}`);
  }
  // The concat demuxer ignores the duration of the last entry unless it is repeated.
  list.push(list[list.length - 2]);
  writeFileSync(join(workDir, 'frames.txt'), list.join('\n') + '\n');

  const ffmpeg = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', join(workDir, 'frames.txt'),
    '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-fps_mode', 'vfr', '-loop', '0', output,
  ], { stdio: 'inherit' });
  if (ffmpeg.status !== 0) throw new Error('ffmpeg failed');
  console.log(`Wrote ${output}`);
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
