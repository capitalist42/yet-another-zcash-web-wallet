// Throwaway smoke: restore with a birthday 120 blocks under the live tip,
// then sample the sync widget while the scan runs. Proves the bar shows real
// overall percent of the birthday->tip range, shrinking blocks-to-go, and the
// up-to-date flip.
import { chromium } from 'playwright-core';
import { findChrome, LAUNCH_ARGS, ENDPOINTS, lightdHeight } from '/home/capitalist42/.omp/wt/syncing-wallet-progress-bar-0e8cefe/.claude/skills/verify/scripts/lib.mjs';

const BASE = 'http://127.0.0.1:4317';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TIP = await lightdHeight(ENDPOINTS.mainnet);
const BIRTHDAY = TIP - 120;
console.log(`tip=${TIP} birthday=${BIRTHDAY}`);
const browser = await chromium.launch({ executablePath: findChrome(), args: LAUNCH_ARGS });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

const sample = async () => {
  const s = await page.evaluate(() => {
    const w = document.querySelector('[aria-label="sync"]');
    if (w === null) return null;
    const bar = w.querySelector('[role="progressbar"]');
    return {
      label: w.querySelector('.row span')?.textContent ?? '',
      pct: w.querySelector('.sync-pct')?.textContent ?? '',
      valuenow: bar?.getAttribute('aria-valuenow') ?? null,
      valuetext: bar?.getAttribute('aria-valuetext') ?? null,
      fill: bar?.querySelector('.sync-fill')?.getAttribute('style') ?? '',
      detail: w.querySelector('.sync-detail')?.textContent ?? '',
    };
  });
  return s;
};

await page.goto(`${BASE}/?network=mainnet`, { waitUntil: 'load', timeout: 30_000 });
await page.waitForSelector('[aria-label="welcome"]', { timeout: 15_000 });
await page.click('text=Restore');
await page.waitForSelector('[aria-label="restore"]', { timeout: 5_000 });
await page.uncheck('input[type="checkbox"]'); // birthday height mode
await page.locator('[aria-label="restore"] textarea').fill(PHRASE);
await page.getByLabel('Birthday height').fill(String(BIRTHDAY));
console.log('form:', await page.evaluate(() => {
  const t = document.querySelector('[aria-label="restore"] textarea');
  const inputs = [...document.querySelectorAll('[aria-label="restore"] input')].map((i) => i.value);
  return JSON.stringify({ words: t === null || t === void 0 ? null : t.value.trim().split(' ').length, inputs });
}));
await page.locator('[aria-label="restore"]').getByRole('button', { name: 'Restore' }).click();
console.log('restore submitted; waiting for wallet screen…');
try {
  await page.waitForSelector('[aria-label="wallet"]', { timeout: 240_000 });
} catch (e) {
  console.log('SCREEN DUMP:\n', await page.evaluate(() => document.body.innerText));
  console.log('ERRORS:', await page.evaluate(() => [...document.querySelectorAll('.error')].map((el) => el.textContent)));
  throw e;
}

const seen = new Set();
let last = null;
const started = Date.now();
while (Date.now() - started < 480_000) {
  const s = await sample();
  if (s !== null) {
    const key = `${s.pct}|${s.valuenow}|${s.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`t+${((Date.now() - started) / 1000).toFixed(0)}s`, JSON.stringify(s));
      last = s;
    }
    if (/up to date/.test(s.detail)) break;
  }
  await page.waitForTimeout(1_000);
}
await page.screenshot({ path: '/tmp/syncbar-final.png' });
console.log('final:', JSON.stringify(last));
console.log('distinct samples:', seen.size);
await browser.close();
