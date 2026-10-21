// Throwaway live leg: drive the REAL engine in the product preview build.
// Create a wallet, pass the backup gate, watch for the wallet screen (or the
// honest engine error). Usage: node scripts/live.mjs [network]
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const CHROME = (() => {
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

const network = process.argv[2] ?? 'mainnet';
const APP = `http://127.0.0.1:4173/?network=${network}`;
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
const page = await context.newPage();
const errors = [];
const onMsg = (m, pg) => {
  const tag = m.type();
  const where = pg === page ? 'page' : 'other';
  if (tag === 'error') errors.push(`console[${where}]: ${m.text().slice(0, 400)}`);
  else console.log(`  [${tag}:${where}] ${m.text().slice(0, 300)}`);
};
context.on('console', onMsg);
page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
context.on('weberror', (e) => errors.push(`weberror: ${String(e.error()).slice(0, 400)}`));

// dedicated workers are invisible to page/context console events — go CDP
const cdp = await context.newCDPSession(page);
await cdp.send('Runtime.enable');
cdp.on('Runtime.consoleAPICalled', (e) =>
  console.log(`  [cdp:${e.type}] ${e.args.map((a) => a.description ?? a.value ?? a.type).join(' ').slice(0, 400)}`),
);
cdp.on('Runtime.exceptionThrown', (e) =>
  errors.push(`cdp-exception: ${e.exceptionDetails.exception?.description ?? e.exceptionDetails.text}`.slice(0, 500)),
);
await page.goto(APP, { waitUntil: 'networkidle' });
await page.waitForSelector('[aria-label="welcome"]', { timeout: 15_000 });
console.log('welcome rendered; clicking Create');

await page.click('text=Create a new Wallet');
await page.waitForSelector('[aria-label="backup gate"]', { timeout: 60_000 });
console.log('backup gate shown (phrase generated via real engine signer)');
await page.waitForFunction(
  () => document.querySelectorAll('[aria-label="backup gate"] ol.phrase li').length === 24,
  { timeout: 30_000 },
);
const words = await page.$$eval('[aria-label="backup gate"] ol.phrase li', (lis) =>
  lis.map((li) => li.textContent.trim().replace(/^\d+\s+/, '')),
);
if (words.length !== 24) {
  await page.screenshot({ path: '/tmp/yaw-live-fail.png' });
  console.error('expected 24 words, got', words.length);
  process.exit(1);
}
await page.fill('[aria-label="backup gate"] textarea', words.join(' '));
await page.click('text=I saved my phrase');
console.log('gate confirmed; waiting for wallet screen (wasm+OPFS+lightd)…');

// Either the wallet screen appears, or an honest error shows up.
const outcome = await Promise.race([
  page.waitForSelector('[aria-label="wallet"]', { timeout: 240_000 }).then(() => 'wallet'),
  page
    .waitForFunction(() => document.querySelector('.error')?.textContent?.trim() ?? '', { timeout: 240_000 })
    .then(() => 'error'),
]).catch(() => 'timeout');

const body = await page.textContent('body');
console.log('outcome:', outcome);
if (outcome === 'wallet') {
  console.log('wallet screen text:', body.slice(0, 500).replace(/\s+/g, ' '));
} else {
  const errText = await page.$eval('.error', (el) => el.textContent).catch(() => '(none)');
  console.log('error element:', errText);
  console.log('body:', body.slice(-700).replace(/\s+/g, ' '));
}

// reload persistence + second-tab lease collision (manual checklist legs)
if (outcome === 'wallet') {
  const page2 = await context.newPage();
  await page2.goto(APP, { waitUntil: 'networkidle' });
  const busy = await page2
    .waitForSelector('[aria-label="storage busy"]', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  console.log('second tab storage-busy screen:', busy);
  await page2.close();
  await page.reload({ waitUntil: 'networkidle' });
  const reborn = await page
    .waitForSelector('[aria-label="wallet"]', { timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  console.log('reload boots straight into wallet:', reborn);
  if (!busy || !reborn) process.exitCode = 3;
}
await page.screenshot({ path: '/tmp/yaw-live.png' });
await browser.close();
process.exit(process.exitCode ?? (outcome === 'wallet' ? 0 : 2));
