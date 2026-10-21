// Throwaway smoke: product build in real Chromium via vite preview.
// Asserts: welcome screen renders from real IndexedDB, no COOP/COEP headers,
// zero third-party requests. Screenshot proof to /tmp/yaw-smoke.png.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const CHROME =
  process.env.YAW_CHROME ??
  (() => {
    const cache = `${homedir()}/.cache/ms-playwright`;
    const revs = existsSync(cache)
      ? readdirSync(cache)
          .filter((d) => /^chromium-\d+$/.test(d))
          .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
      : [];
    for (const rev of revs) {
      for (const p of [`${cache}/${rev}/chrome-linux64/chrome`, `${cache}/${rev}/chrome-linux/chrome`]) {
        if (existsSync(p)) return p;
      }
    }
    return undefined;
  })();
if (CHROME === undefined) {
  console.error('no chromium found');
  process.exit(1);
}

const APP = 'http://127.0.0.1:4173/';
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const requests = [];
page.on('request', (r) => requests.push(r.url()));
const failed = [];
page.on('response', (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
});
const errors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // the browser's automatic /favicon.ico probe 404s; not an app error
  if (m.text().includes('404') && m.location()?.url?.endsWith('/favicon.ico')) return;
  errors.push(`console: ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => errors.push(String(e)));

const res = await page.goto(APP, { waitUntil: 'networkidle' });
const headers = res.headers();
await page.waitForSelector('[aria-label="welcome"]', { timeout: 10_000 });
await page.screenshot({ path: '/tmp/yaw-smoke.png' });

const coop = headers['cross-origin-opener-policy'];
const coep = headers['cross-origin-embedder-policy'];
const thirdParty = requests.filter((u) => !u.startsWith(APP));

console.log('COOP header present:', coop !== undefined);
console.log('COEP header present:', coep !== undefined);
console.log('requests:', requests.length, 'third-party:', thirdParty);
console.log('failed responses:', failed.length === 0 ? 'none' : failed);
console.log('page errors:', errors.length === 0 ? 'none' : errors);
const text = await page.textContent('body');
console.log('welcome visible:', text.includes('Zcash Wallet') && text.includes('Create a new Wallet'));
// favicon 404 is the browser's automatic probe; not an app request.
const appFailures = failed.filter((f) => !f.endsWith('/favicon.ico'));
await browser.close();
if (coop !== undefined || coep !== undefined || thirdParty.length > 0 || errors.length > 0 || appFailures.length > 0)
  process.exit(1);
