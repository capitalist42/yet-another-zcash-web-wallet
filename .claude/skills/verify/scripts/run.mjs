#!/usr/bin/env node
// verify-skill driver: doctor -> launch -> drive ONE mapped feature ->
// evidence -> cleanup (browser closed here; preview stays until you kill the
// pidfile, per SKILL.md). Exit 0 pass, 1 doctor/launch, 2 journey step failed.
// Usage: node run.mjs --port 4317 --feature create-wallet [--network mainnet|testnet]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findChrome, LAUNCH_ARGS, ENDPOINTS } from './lib.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const port = Number(arg('port', process.env.YAW_PORT ?? 4173));
const feature = arg('feature', 'create-wallet');
const BASE = `http://127.0.0.1:${port}`;

const FEATURES = {
  'create-wallet': { network: 'mainnet', drive: driveCreateWallet },
};
if (!(feature in FEATURES)) {
  console.error(`unknown feature "${feature}". implemented: ${Object.keys(FEATURES).join(', ')}.`);
  console.error('For other mapped features, drive by hand per features/<id>.md (the map is the recipe).');
  process.exit(1);
}

// ---- doctor gate ----------------------------------------------------------
const doc = spawnSync(process.execPath, [new URL('./doctor.mjs', import.meta.url).pathname, '--port', String(port)], {
  stdio: 'inherit',
});
if (doc.status !== 0) process.exit(1);

const network = arg('network', FEATURES[feature].network);
const ENDPOINT = ENDPOINTS[network];

// ---- evidence scratch ------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = `.claude/skills/verify/evidence/${stamp}-${feature}`;
mkdirSync(evidenceDir, { recursive: true });
const logLines = [];
const log = (...parts) => {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  logLines.push(line);
  console.log(line);
};
log(`command: ${process.argv.slice(2).join(' ')}`);
log(`feature=${feature} network=${network} base=${BASE} endpoint=${ENDPOINT}`);
log(`gitRev=${spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()}`);

const failures = [];
let finalPage = null;

// ---- browser / page with full error + network capture -----------------------
const chrome = findChrome();
if (chrome === undefined || !existsSync(chrome)) {
  log('FATAL: no chromium found (doctor should have caught this)');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath: chrome, args: LAUNCH_ARGS });
const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });

const pageErrors = [];
const appErrors = []; // console errors + worker exceptions: app-fault candidates
const requests = [];
const failedResponses = [];
const isAppNoise = (t) => t.includes('favicon.ico'); // browser's automatic probe, not the app

const attach = (page, label = 'page') => {
  page.on('request', (r) => requests.push(`${label} ${r.method()} ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) failedResponses.push(`${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !isAppNoise(m.text())) appErrors.push(`console: ${m.text().slice(0, 300)}`);
    log(`[${label}:console.${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => {
    pageErrors.push(`pageerror: ${String(e).slice(0, 300)}`);
    log(`[${label}:pageerror] ${String(e).slice(0, 300)}`);
  });
};

const page = await context.newPage();
finalPage = page;
attach(page);
page.on('weberror', (e) => appErrors.push(`weberror: ${String(e.error()).slice(0, 400)}`));
// dedicated workers are invisible to page/context events — go CDP
const cdp = await context.newCDPSession(page);
await cdp.send('Runtime.enable');
cdp.on('Runtime.exceptionThrown', (e) =>
  appErrors.push(`cdp-exception: ${(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)}`.slice(0, 500)),
);

// ---- step machinery ---------------------------------------------------------
const step = async (name, fn) => {
  const started = Date.now();
  try {
    const note = await fn();
    log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)${note ? ` — ${note}` : ''}`);
    return note;
  } catch (e) {
    failures.push(`${name}: ${String(e).slice(0, 400)}`);
    log(`FAIL ${name}: ${String(e).slice(0, 400)}`);
    if (finalPage !== null) {
      await finalPage.screenshot({ path: `${evidenceDir}/failure-${failures.length}.png`, fullPage: true }).catch(() => {});
      log('body tail:', (await finalPage.textContent('body').catch(() => '')).slice(-600).replace(/\s+/g, ' '));
    }
    throw e; // stop at first failed step; the map forbids silently continuing
  }
};

const snap = async (name) => {
  const yaml = await finalPage.locator('body').ariaSnapshot();
  writeFileSync(`${evidenceDir}/state-${name}.aria.yml`, yaml);
  log(`snapshot -> state-${name}.aria.yml`);
};

// =============================================================================
// create-wallet — features/create-wallet.md
// welcome -> Create -> forced backup gate (24 words, wrong-phrase rejected,
// right phrase opens the engine) -> wallet screen (or, on testnet, the honest
// SYNC_REQUIRED) -> second tab storage-busy -> reload boots straight back.
// =============================================================================
async function driveCreateWallet() {
  let fpBefore = ''; // fingerprint chip observed before reload; equality proves same wallet
  let staleError = ''; // .error text left over from the wrong-phrase leg; the outcome race must not match it
  const url = `${BASE}/?network=${network}`;

  await step('open-welcome', async () => {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForSelector('[aria-label="welcome"]', { timeout: 15_000 });
    const net = await page.getAttribute('main.app', 'data-network');
    if (net !== network) throw new Error(`data-network="${net}", expected "${network}"`);
    return `welcome rendered, data-network=${net}`;
  });
  await snap('welcome');

  await step('create-generate-gate', async () => {
    await page.click('text=Create a new Wallet');
    await page.waitForSelector('[aria-label="backup gate"]', { timeout: 60_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="backup gate"] ol.phrase li').length === 24,
      undefined,
      { timeout: 30_000 },
    );
    const words = await page.$$eval('[aria-label="backup gate"] ol.phrase li', (lis) =>
      lis.map((li) => li.textContent.trim().replace(/^\d+\s+/, '')),
    );
    if (new Set(words).size > 24 || words.some((w) => !/^[a-z]+$/.test(w)))
      throw new Error(`implausible phrase words: ${words.slice(0, 4)}...`);
    globalThis.__words = words;
    return `gate shown; 24 words generated by the real engine signer (phrase not logged)`;
  });
  await snap('gate');

  await step('gate-rejects-wrong-phrase', async () => {
    await page.fill('[aria-label="backup gate"] textarea', 'wrong words do not open a wallet');
    await page.click('text=I saved my phrase');
    await page.waitForSelector('.error', { timeout: 15_000 });
    const stillGate = await page.locator('[aria-label="backup gate"]').count();
    if (stillGate !== 1) throw new Error('gate vanished despite wrong phrase');
    staleError = (await page.textContent('.error')).trim();
    return `error shown: "${staleError}"`;
  });

  await step('gate-confirm', async () => {
    await page.fill('[aria-label="backup gate"] textarea', globalThis.__words.join(' '));
    await page.click('text=I saved my phrase');
    log('gate confirmed; waiting for wallet screen (wasm + OPFS + lightd)…');
  });

  // Either the wallet screen appears, or an honest error does. mainnet must
  // land on the wallet; testnet MUST land on the honest SYNC_REQUIRED while
  // the rc.5 codec tops out below NU7 (docs/manual-verification.md NO-GO).
  const outcome = await step('engine-open-outcome', async () => {
    const race = await Promise.race([
      page.waitForSelector('[aria-label="wallet"]', { timeout: 240_000 }).then(() => 'wallet'),
      page
        .waitForFunction(
          (stale) => {
            const t = (document.querySelector('.error')?.textContent ?? '').trim();
            return t !== '' && t !== stale; // fresh error only — the wrong-phrase text may linger until resolution
          },
          staleError,
          { timeout: 240_000 },
        )
        .then(() => 'error'),
    ]).catch(() => 'timeout');
    const bodyText = await page.textContent('body');
    if (network === 'testnet') {
      if (race !== 'error') throw new Error(`testnet leg expected the honest error path, got "${race}" (was the codec/NO-GO expectation updated?)`);
      const err = (await page.textContent('.error')).trim();
      // the UI renders EngineError.message — for SYNC_REQUIRED the SDK's text
      // is "Sync the wallet before continuing; retain any existing payment operation."
      if (!/SYNC_REQUIRED|Sync the wallet before continuing/i.test(err + bodyText))
        throw new Error(`testnet error is not the honest sync failure: "${err}"`);
      return `honest testnet failure observed: "${err.slice(0, 160)}"`;
    }
    if (race !== 'wallet') {
      const err = await page
        .textContent('.error')
        .then((t) => t.trim())
        .catch(() => '(none)');
      throw new Error(`expected wallet, got "${race}" (error: ${err})`);
    }
    return 'wallet screen rendered';
  });
  await snap('after-open');

  if (outcome !== undefined && network === 'mainnet') {
    await step('wallet-screen-state', async () => {
      const net = await page.getAttribute('main.app', 'data-network');
      if (net !== network) throw new Error(`data-network flipped to "${net}"`);
      const fp = await page.locator('[aria-label="wallet"] header .chip').first().textContent();
      fpBefore = fp.trim();
      if (!/^[a-z2-7]{4}$/.test(fp.trim())) throw new Error(`fingerprint chip looks wrong: "${fp}"`);
      await page.waitForFunction(
        () => {
          const a = document.querySelector('[data-testid="receive-address"]');
          return a !== null && a.textContent.trim().length > 20 && !a.textContent.includes('preparing');
        },
        undefined,
        { timeout: 30_000 },
      );
      const addr = (await page.textContent('[data-testid="receive-address"]')).trim();
      const send = page.locator('button', { hasText: 'Send' });
      const disabled = await send.getAttribute('disabled');
      const title = await send.getAttribute('title');
      if (disabled === null || !/next milestone/.test(title ?? ''))
        throw new Error(`Send must be disabled-with-explanation (disabled=${disabled}, title=${title})`);
      const history = await page.locator('[aria-label="history"]').count();
      const noHistory = await page.locator('text=No transactions yet.').count();
      if (history + noHistory === 0) throw new Error('neither history list nor its empty state rendered');
      const syncLine = await page.locator('[aria-label="wallet"] p.muted').first().textContent();
      return `fingerprint=${fp.trim()} addr=${addr.slice(0, 10)}…${addr.slice(-6)} send=disabled sync="${syncLine.trim()}"`;
    });

    await step('lightd-live-and-no-third-party', async () => {
      const toEndpoint = requests.filter((r) => r.includes(ENDPOINT));
      if (toEndpoint.length === 0) throw new Error(`zero requests to ${ENDPOINT} — not actually syncing`);
      const allowedHosts = new Set([new URL(BASE).host, new URL(ENDPOINT).host]);
      const thirdParty = requests.filter((r) => {
        const u = new URL(r.split(' ').pop());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return false; // blob:/data: worker URLs are not network requests
        return !allowedHosts.has(u.host);
      });
      if (thirdParty.length > 0) throw new Error(`third-party requests: ${thirdParty.slice(0, 5)}`);
      if (failedResponses.length > 0) throw new Error(`failed responses: ${failedResponses.slice(0, 5)}`);
      return `${toEndpoint.length} requests to lightd; zero third-party; zero failed responses`;
    });

    await step('second-tab-storage-busy', async () => {
      const page2 = await context.newPage(); // same profile: OPFS lease collision
      attach(page2, 'tab2');
      await page2.goto(url, { waitUntil: 'load', timeout: 30_000 });
      const busy = await page2
        .waitForSelector('[aria-label="storage busy"]', { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      await page2.close();
      if (!busy) throw new Error('second tab did not render the storage-busy screen');
      return 'second tab shows "Wallet storage is busy"';
    });

    await step('reload-boots-into-wallet', async () => {
      await page.reload({ waitUntil: 'load', timeout: 30_000 });
      await page.waitForSelector('[aria-label="wallet"]', { timeout: 120_000 });
      const fp2 = (await page.locator('[aria-label="wallet"] header .chip').first().textContent()).trim();
      if (fpBefore !== '' && fp2 !== fpBefore) throw new Error(`fingerprint changed across reload: ${fpBefore} -> ${fp2}`);
      return `reload boots straight into the same wallet (fingerprint ${fp2})`;
    });
  }

}

// ---- wrap up ----------------------------------------------------------------
let crashed = false;
try {
  await FEATURES[feature].drive();
} catch {
  crashed = true;
}
if (finalPage !== null && !crashed) {
  await finalPage.screenshot({ path: `${evidenceDir}/final.png`, fullPage: true }).catch(() => {});
  const yaml = await finalPage.locator('body').ariaSnapshot().catch(() => '(unavailable)');
  writeFileSync(`${evidenceDir}/state-final.aria.yml`, yaml);
}
if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join(' | ')}`);
if (appErrors.length > 0) failures.push(`app console/worker errors: ${appErrors.join(' | ')}`);
log(`pageErrors=${pageErrors.length} appErrors=${appErrors.length} requests=${requests.length} failedResponses=${failedResponses.length}`);

writeFileSync(`${evidenceDir}/console.log`, logLines.join('\n') + '\n');
writeFileSync(`${evidenceDir}/meta.json`, JSON.stringify({
  command: process.argv.slice(2).join(' '),
  port,
  network,
  endpoint: ENDPOINT,
  gitRev: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  outcome: crashed ? 'FAIL' : 'PASS',
  failures,
}, null, 2) + '\n');
await browser.close(); // cleanup: only the instance THIS run launched
log(`evidence: ${evidenceDir}`);
if (crashed) {
  console.error(`JOURNEY FAILED (${failures.length} failure(s)) — see ${evidenceDir}`);
  process.exit(2);
}
console.log('PASS');
