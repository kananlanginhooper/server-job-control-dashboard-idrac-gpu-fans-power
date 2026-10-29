// Screenshot every chart of the demo build, for the before/after comparison in docs/refactor/.
//   node demo/shoot.mjs <url> <out-dir> [browser.exe]
// Uses a locally installed Chrome/Edge (playwright-core, no browser download). Charts are found by tag name
// inside the app's shadow root; each is saved as NN-<card heading>.png, plus one with the hover tooltip.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [url, out, exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] =
  process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

const charts = page.locator('app-line-chart, app-track-chart, [app-line-chart], [app-track-chart]');
const n = await charts.count();
const slug = (s) =>
  (s || 'chart')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
for (let i = 0; i < n; i++) {
  const c = charts.nth(i);
  if (!(await c.isVisible())) continue; // e.g. the PSU voltage chart, shown only in Low Power
  await c.scrollIntoViewIfNeeded();
  const title = await c.evaluate((el) => {
    const h = el.closest('.srvchart, .rem, section, .server')?.querySelector('h4, h3, h2, .l');
    return (
      el.getAttribute('aria-label') ||
      el.querySelector('svg, div')?.getAttribute('aria-label') ||
      h?.textContent ||
      ''
    ).trim();
  });
  await c.screenshot({ path: `${out}/${String(i + 1).padStart(2, '0')}-${slug(title)}.png` });
}
// one hover: the first chart, pointer at 70% of its width
for (let i = 0; i < n; i++) {
  const c = charts.nth(i);
  if (!(await c.isVisible())) continue;
  await c.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -150));
  const b = await c.boundingBox();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.5);
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `${out}/00-hover-first-chart.png`,
    clip: {
      x: Math.max(0, b.x - 10),
      y: Math.max(0, b.y - 10),
      width: Math.min(1590 - b.x, b.width + 300),
      height: Math.min(990 - b.y, b.height + 220),
    },
  });
  break;
}
console.log(`${n} charts -> ${out}`);
await browser.close();
