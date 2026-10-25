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
  // Form legs only. Confirm spends shielded funds and stays operator-run.
  send: { network: 'mainnet', drive: driveCreateWallet },
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

// Classification-only fixtures. Nothing here is a funded recipient, and this
// driver never clicks confirm-send. Body length clears classifyAddress.
const SEND_SAPLING = `zs1${'q'.repeat(40)}`;
const SEND_TRANSPARENT = `t1${'1'.repeat(32)}`;
const SEND_MEMO_B64 = 'VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg';

async function driveSendForm() {
  const form = () => page.locator('[aria-label="send"]');

  await step('send-memo', async () => {
    await form().locator('[data-testid="send-recipient"]').fill(SEND_SAPLING);
    await form().locator('[data-testid="send-amount"]').fill('1');
    if ((await page.locator('[data-testid="memo-warning"]').count()) !== 0) {
      throw new Error('memo warning showed before a memo was entered');
    }
    await form().locator('[data-testid="send-memo"]').fill('hello');
    const warning = (await page.locator('[data-testid="memo-warning"]').textContent())?.trim();
    if (warning !== 'This memo rides on-chain, encrypted to the recipient.') {
      throw new Error(`memo warning was "${warning}"`);
    }
    return 'warning appears only once a memo is entered';
  });
  await snap('send-memo');

  await step('send-uri', async () => {
    const uri = `zcash:${SEND_SAPLING}?amount=1&memo=${SEND_MEMO_B64}`;
    await form().locator('[data-testid="send-recipient"]').fill(uri);
    const recipient = await form().locator('[data-testid="send-recipient"]').inputValue();
    const amount = await form().locator('[data-testid="send-amount"]').inputValue();
    const memo = await form().locator('[data-testid="send-memo"]').inputValue();
    if (recipient !== SEND_SAPLING) throw new Error(`recipient was not prefilled: "${recipient}"`);
    if (amount !== '1') throw new Error(`amount was not prefilled: "${amount}"`);
    if (memo !== 'This is a simple memo.') throw new Error(`memo was not decoded: "${memo}"`);
    if ((await page.locator('[data-testid="memo-warning"]').count()) !== 1) {
      throw new Error('prefilled memo did not keep the on-chain warning');
    }
    return 'ZIP-321 URI prefilled address, amount, and memo';
  });
  await snap('send-uri');

  await step('send-transparent', async () => {
    await form().locator('[data-testid="send-recipient"]').fill(SEND_TRANSPARENT);
    const blocked = await form().locator('.warning').allTextContents();
    if (!blocked.some((t) => t.includes('Transparent recipients are off'))) {
      throw new Error(`transparent warning missing: ${blocked.join(' | ')}`);
    }
    if ((await page.locator('[data-testid="memo-warning"]').count()) !== 0) {
      throw new Error('memo warning stayed up for a transparent recipient');
    }
    await form().locator('button', { hasText: 'Review' }).click();
    if ((await page.locator('[aria-label="proposal review"]').count()) !== 0) {
      throw new Error('transparent recipient reached proposal review');
    }
    if ((await page.locator('[aria-label="send"]').count()) !== 1) {
      throw new Error('transparent refusal left the send form');
    }
    const err = (await form().locator('.error').textContent())?.trim();
    if (err !== 'Transparent recipients are off. Allow transparent sends is in Settings.') {
      throw new Error(`transparent refusal text was "${err}"`);
    }
    return 'transparent recipient refused before a proposal';
  });
  await snap('send-transparent');

  await step('send-cancel', async () => {
    await form().locator('button', { hasText: 'Cancel' }).click();
    if ((await page.locator('[aria-label="send"]').count()) !== 0) throw new Error('Cancel left the send form open');
    if ((await page.locator('[aria-label="wallet"] .actions > button', { hasText: 'Send' }).count()) !== 1) {
      throw new Error('Send button did not return');
    }
    return 'Cancel closed the form; confirm was never clicked';
  });
}

// =============================================================================
// create-wallet — features/create-wallet.md
// welcome -> Create -> forced backup gate (24 words shown, 3 random positions
// quizzed; wrong words rejected, right words open the engine) -> wallet screen (or, on testnet, the honest
// SYNC_REQUIRED) -> second tab storage-busy -> reload boots straight back.
// =============================================================================
async function driveCreateWallet() {
  let fpBefore = ''; // fingerprint chip observed before reload; equality proves same wallet
  let staleError = ''; // .error text left over from the wrong-words leg; the outcome race must not match it
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

  // The gate quizzes 3 random word positions; inputs carry data-word-position.
  const fillQuiz = async (wordAt) => {
    const positions = await page.$$eval('[aria-label="backup gate"] [data-word-position]', (els) =>
      els.map((el) => Number(el.getAttribute('data-word-position'))),
    );
    if (positions.length !== 3) throw new Error(`expected 3 quiz inputs, got ${positions.length}`);
    for (const pos of positions) {
      await page.fill(`[aria-label="backup gate"] [data-word-position="${pos}"]`, wordAt(pos));
    }
  };

  await step('gate-rejects-wrong-words', async () => {
    await fillQuiz(() => 'nottheword');
    await page.click('text=I saved my phrase');
    await page.waitForSelector('.error', { timeout: 15_000 });
    const stillGate = await page.locator('[aria-label="backup gate"]').count();
    if (stillGate !== 1) throw new Error('gate vanished despite wrong words');
    staleError = (await page.textContent('.error')).trim();
    return `error shown: "${staleError}"`;
  });

  await step('gate-confirm', async () => {
    await fillQuiz((pos) => globalThis.__words[pos - 1]);
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
            return t !== '' && t !== stale; // fresh error only — the wrong-words text may linger until resolution
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
      // SYNC_REQUIRED is a pause, not a dead end: the retry screen explains the
      // pause and offers Try again / Switch to Mainnet / Back to my phrase.
      await page.waitForSelector('[aria-label="sync retry"]', { timeout: 5_000 });
      if (!(await page.isVisible('text=Try again')) || !(await page.isVisible('text=Back to my recovery phrase')))
        throw new Error('sync-retry screen missing its recovery actions');
      await page.click('text=Back to my recovery phrase');
      await page.waitForSelector('[aria-label="backup gate"]', { timeout: 5_000 });
      return `honest testnet failure with working retry screen: "${err.slice(0, 160)}"`;
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
      // The wallet screen shows as soon as the phrase is accepted. The account,
      // fingerprint, and Send button appear only after the freshness pass.
      await page.waitForFunction(
        () => {
          const chips = [...document.querySelectorAll('[aria-label="wallet"] header .chip')];
          const fp = chips.map((c) => c.textContent.trim()).find((t) => /^[a-z2-7]{4}$/.test(t));
          const addr = document.querySelector('[data-testid="receive-address"]')?.textContent?.trim() ?? '';
          const send = [...document.querySelectorAll('[aria-label="wallet"] .actions button')].some(
            (b) => b.textContent.trim() === 'Send',
          );
          return fp !== undefined && addr.length > 20 && !addr.includes('preparing') && send;
        },
        undefined,
        { timeout: 120_000 },
      );
      const fp = await page.locator('[aria-label="wallet"] header .chip').evaluateAll((els) => {
        return els.map((e) => e.textContent.trim()).find((t) => /^[a-z2-7]{4}$/.test(t)) ?? '';
      });
      fpBefore = fp;
      const addr = (await page.textContent('[data-testid="receive-address"]')).trim();
      const send = page.locator('[aria-label="wallet"] .actions > button', { hasText: 'Send' });
      const disabled = await send.getAttribute('disabled');
      if (disabled !== null) throw new Error(`Send should be available on a seed wallet (disabled=${disabled})`);
      await send.click();
      await page.waitForSelector('[aria-label="send"]', { timeout: 5_000 });
      if (feature !== 'send') {
        await page.locator('[aria-label="send"] button', { hasText: 'Cancel' }).click();
        if ((await page.locator('[aria-label="send"]').count()) !== 0) throw new Error('Cancel left the send form open');
      }
      const history = await page.locator('[aria-label="history"]').count();
      const noHistory = await page.locator('text=No transactions yet.').count();
      if (history + noHistory === 0) throw new Error('neither history list nor its empty state rendered');
      const syncLine = await page.locator('[aria-label="wallet"] p.muted').first().textContent();
      return `fingerprint=${fp.trim()} addr=${addr.slice(0, 10)}…${addr.slice(-6)} send=opens sync="${syncLine.trim()}"`;
    });

    if (feature === 'send') await driveSendForm();

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
