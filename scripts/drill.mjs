// Ticket #2 kill-drill runner: drives the spike UI in real Chromium (OPFS worker,
// WASM engine, real chain — mainnet by default; testnet via ?network=testnet).
// Throwaway; run with the vite dev/preview server up:
//   node scripts/drill.mjs [stepName ...]
// No args => run every step in order. S4 toggles the dev-server hang proxy around
// the submit; S5 closes the tab (via the UI close+reload button), then reopens
// the wallet through S5 to prove reload survival. S5b arms a mid-scan snapshot,
// kills the tab RAW mid-flight (button, no closeAll), then resumes after load.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const CHROME = `${homedir()}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`;
const APP = process.env.YAW_APP ?? 'http://127.0.0.1:4173/';
// Button substrings (unique) per step.
const LABELS = {
  'S1a-create-A': 'S1a open A',
  'S1b-current-null': 'S1b current()',
  'S1c-next-mints': 'S1c next()',
  'S1d-sync-tip': 'S1d sync',
  'FAUCET-t': 'Faucet drip',
  'P1-shield-disallow': 'P1 shield()',
  'P2-shield-allow-owned': 'P2 reopen',
  'P3-direct-transparent-send': 'P3 t-spend',
  'P4-shield-execute': 'P4 reviewed',
  'S3-shield-send': 'S3 open B',
  'S3b-memo-send': 'S3b memo',
  'S3c-history-both': 'S3c history',
  'S4-submit-unknown': 'S4 send via hang',
  'S4b-resume-mined': 'S4b reopen',
  'S5-reload-sane': 'S5 reopen',
  'S5b-midsync-arm': 'S5b arm mid-scan',
  'S5b-midsync-resume': 'S5b resume after',
};
const ORDER = Object.keys(LABELS);

const drill = (mode) => fetch(`${APP}drill/${mode}`).then((r) => r.json());

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--disable-dev-shm-usage',
    '--enable-features=SharedArrayBuffer', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(APP, { waitUntil: 'networkidle' });

const button = (label) => page.locator('button', { hasText: label }).first();

const clickAndWait = async (label, timeoutMs) => {
  console.log(`\n=== ${label} ===`);
  await button(label).click();
  await page.waitForFunction(
    () => !document.body.textContent.includes('running…'),
    undefined,
    { timeout: timeoutMs, polling: 2_000 },
  );
  const detail = await button(label)
    .locator('xpath=../div')
    .first()
    .textContent()
    .catch(() => '(no detail)');
  console.log((detail ?? '(no detail)').trim());
  return detail ?? '';
};

const wanted = process.argv.slice(2);
const steps = wanted.length > 0 ? ORDER.filter((s) => wanted.includes(s)) : ORDER;

for (const step of steps) {
  const label = LABELS[step];
  if (step === 'S4-submit-unknown') {
    console.log('drill on:', await drill('on'));
    try {
      await clickAndWait(label, 300_000);
    } finally {
      console.log('drill off:', await drill('off'));
    }
    continue;
  }
  if (step === 'S5-reload-sane') {
    // Tab death: UI button closes clients (releases OPFS) then reloads the page.
    await page.locator('button', { hasText: 'close + reload' }).click();
    await page.waitForLoadState('networkidle');
    await clickAndWait(label, 180_000);
    continue;
  }
  if (step === 'S5b-midsync-arm') {
    // Arm records the mid-scan snapshot, then THIS kills the tab mid-flight:
    // raw reload button (no closeAll), so the scan worker dies uncleanly.
    await clickAndWait(label, 360_000);
    await page.locator('button', { hasText: 'reload mid-scan (kill)' }).click();
    await page.waitForLoadState('networkidle');
    continue;
  }
  if (step === 'S5b-midsync-resume') {
    // Fresh page after the mid-sync kill: reopen C from durable DB.
    await clickAndWait(label, 180_000);
    continue;
  }
  await clickAndWait(label, step === 'FAUCET-t' ? 300_000 : 360_000);
}

const summary = await page.evaluate(() => {
  const ctx = JSON.parse(sessionStorage.getItem('yaw-spike-ctx') ?? '{}');
  return ctx.steps ?? {};
});
console.log('\n=== summary ===');
for (const [k, v] of Object.entries(summary)) {
  console.log(`${v.ok ? 'PASS' : 'FAIL'} ${k} :: ${v.detail.slice(0, 160)}`);
}
if (existsSync('drill/HANG')) console.log('WARNING: drill/HANG left on');
await browser.close();
