import { chromium } from 'playwright';

const URL = process.env.DEV_URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error' || msg.type() === 'warning' || /\[ambient\]|procedural|\[dbg\]|map\]/.test(text)) {
    console.log(`[console.${msg.type()}] ${text}`);
  }
});
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (window).__map != null, null, { timeout: 20000 });
// Dense urban: City of London, pitch 60, z16.6 — the worst case the ambient layer targets.
await page.evaluate(() => {
  const map = window.__map;
  map.jumpTo({ center: [-0.092, 51.513], zoom: 16.6, pitch: 60, bearing: -20 });
});
// Pixel-truth check: two settled frames at (near-)identical cameras, one with
// the models layer, one without. Uses compositor screenshots (WebGL canvas
// toDataURL is unreliable without preserveDrawingBuffer).
async function shotAfterMove() {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.__map.once('idle', () => resolve(null));
        window.__map.jumpTo({ zoom: window.__map.getZoom() + 0.001 });
      }),
  );
  await page.waitForTimeout(300);
}

await shotAfterMove();
const withModels = await page.screenshot();

await page.evaluate(() => window.__map.removeLayer('procedural-buildings-3d'));
await shotAfterMove();
const withoutModels = await page.screenshot();

const fs = await import('node:fs');
fs.mkdirSync('debug', { recursive: true });
fs.writeFileSync('debug/shot-with-models.png', withModels);
fs.writeFileSync('debug/shot-without-models.png', withoutModels);
const changed = Buffer.compare(withModels, withoutModels) !== 0;
console.log(`frames differ with vs. without models layer: ${changed}`);
await browser.close();
