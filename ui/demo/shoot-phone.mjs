// Phone screenshots of the demo build (DASHBOARD-REQUIREMENTS 5a): every card at 390x844 with touch, for the
// before/after comparison in docs/mobile/.
//   node demo/shoot-phone.mjs <url> <out-dir> [browser.exe]
// Uses a locally installed Chrome/Edge (playwright-core, no browser download). Cards are found inside the app's
// shadow root; each is saved as NN-<card heading>.png, plus the top of the page as 00-top.png.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [url, out, exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] =
  process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/00-top.png` });

const slug = (s) =>
  (s || 'card')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
const cards = page.locator('section.card');
const n = await cards.count();
for (let i = 0; i < n; i++) {
  const c = cards.nth(i);
  if (!(await c.isVisible())) continue;
  await c.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const title = await c.evaluate((el) => el.querySelector('h2')?.textContent?.trim() || '');
  await c.screenshot({ path: `${out}/${String(i + 1).padStart(2, '0')}-${slug(title)}.png` });
}
const sw = await page.evaluate(() => document.documentElement.scrollWidth);
console.log(`${n} cards, page scrollWidth ${sw} at 390`);
await browser.close();
