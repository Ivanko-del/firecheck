// Renders docs/social-preview.png (1280x640), the image GitHub shows when the
// repository link is shared. Upload it in Settings > General > Social preview.
//
// Needs Playwright with Chromium, see make-gif.mjs.
//   node docs/demo/make-social-preview.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, '..', 'social-preview.png');
const { chromium } = createRequire(import.meta.url)('playwright');

const shield = `<svg width="64" height="72" viewBox="0 0 64 72" fill="none" aria-hidden="true">
  <path d="M32 3 L59 13 V35 C59 52 47 63 32 69 C17 63 5 52 5 35 V13 Z" fill="#ff8a3d" fill-opacity="0.14" stroke="#ff8a3d" stroke-width="4" stroke-linejoin="round"/>
  <path d="M20 36 L28.5 44.5 L45 27" stroke="#ffb27a" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  .card {
    width: 1280px; height: 640px; padding: 64px 72px; overflow: hidden; position: relative;
    background: radial-gradient(900px 500px at 100% 0%, rgba(255, 138, 61, 0.16), transparent 60%), #0d1117;
    color: #e6edf3; font-family: 'DejaVu Sans', sans-serif;
  }
  .brand { display: flex; align-items: center; gap: 22px; }
  .name { font: bold 76px/1 'DejaVu Sans Mono', monospace; letter-spacing: -2px; }
  .tagline { margin-top: 26px; width: 1060px; font-size: 38px; line-height: 1.3; color: #c9d1d9; }
  .tagline b { color: #ffb27a; font-weight: bold; }
  .term {
    margin-top: 38px; width: 1136px; padding: 22px 28px; border-radius: 14px;
    background: #161b22; border: 1px solid #30363d;
    font: 21px/1.6 'DejaVu Sans Mono', monospace; white-space: pre; overflow: hidden;
  }
  .dim { color: #8b949e; } .err { color: #ff7b72; } .cmd { color: #3fb950; } .code { color: #56d4dd; } .sum { color: #ff7b72; font-weight: bold; }
  .chips { position: absolute; left: 72px; bottom: 50px; display: flex; gap: 14px; }
  .chip { padding: 8px 18px; border-radius: 999px; border: 1px solid #30363d; color: #c9d1d9; font-size: 21px; background: #161b22; }
</style></head><body>
  <div class="card">
    <div class="brand">${shield}<span class="name">firecheck</span></div>
    <div class="tagline">Find the holes in your <b>Firebase security rules</b> before someone else does.</div>
    <div class="term"><span class="cmd">$</span> npx firecheck
<span class="dim">10:7 </span> <span class="err">error</span>  Any signed-in user can read and write every document at <span class="code">/orders/{orderId}</span>…
<span class="dim">18:7 </span> <span class="err">error</span>  Test-mode rule: anyone on the internet can read and write documents…
<span class="sum">✖ 5 problems (4 errors, 1 warning, 0 info)</span></div>
    <div class="chips">
      <span class="chip">Cloud Firestore</span><span class="chip">Cloud Storage</span><span class="chip">GitHub Action</span><span class="chip">Zero config</span><span class="chip">MIT</span>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await tab.setContent(page);
  await tab.locator('.card').screenshot({ path: output });
  console.log(`Wrote ${output}`);
} finally {
  await browser.close();
}
