#!/usr/bin/env node
// Issue #4 qualification legs that need operator secrets: Restore and
// View-only import, driven through the product UI in real Chromium against
// the preview build. The scripted create leg (live.mjs) covers the rest.
//
//   ZCASH_MNEMONIC="all 24 words" [ZCASH_PASSPHRASE=...] ZCASH_EXPECT='<json>' \
//     node scripts/restore-viewonly.mjs [network]
//
// Secrets come ONLY from the environment, are typed straight into the page,
// and never touch disk or logs. ZCASH_EXPECT is the operator's Zashi-side
// truth for that seed — the cross-check that gates the restore-compat claim:
//   {"birthdayHeight": 2000123, "balances": {"transparent":"0","sapling":"1.5","ironwood":"0"}}
// Balances are compared exactly (ZEC strings); the scanned floor is
// birthdayHeight on the first sync tick (full-scan compares >0 only).
//
// Legs, in one browser each (fresh profile per leg):
//   1. Restore: tab → phrase (+optional passphrase, account index 0, birthday
//      height) → wallet screen → balances equal Zashi → receive address, no
//      Unlock affordance anywhere.
//   2. View-only: same seed's UFVK derived OFFLINE (pure key material, see
//      derive-testnet-address.mjs) → import → wallet screen → balances equal
//      Zashi → "View-only" chip, Send hidden, no Unlock affordance.
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

const MNEMONIC = process.env.ZCASH_MNEMONIC;
const PASSPHRASE = process.env.ZCASH_PASSPHRASE ?? '';
const EXPECT = (() => {
  try {
    return JSON.parse(process.env.ZCASH_EXPECT ?? '');
  } catch {
    return null;
  }
})();
if (!MNEMONIC || EXPECT === undefined || EXPECT === null) {
  console.error('usage: ZCASH_MNEMONIC="24 words" ZCASH_EXPECT=\'{"birthdayHeight":N,"balances":{...}}\' node scripts/restore-viewonly.mjs [network]');
  process.exit(2);
}
const network = process.argv[2] ?? 'testnet';
// Same rule as the verify skill: port 4173 may belong to a human's preview;
// point this leg at a run-specific one with ZCASH_VERIFY_PORT.
const APP = `http://127.0.0.1:${process.env.ZCASH_VERIFY_PORT ?? 4173}/?network=${network}`;
const ZEC = 100_000_000n;
const zats = (s) => {
  const t = String(s).trim();
  const neg = t.startsWith('-');
  const [w, f = ''] = (neg ? t.slice(1) : t).split('.');
  const v = BigInt(w === '' ? '0' : w) * ZEC + BigInt(f.padEnd(8, '0') || '0');
  return neg ? -v : v;
};
const EXPECT_BAL = {
  transparent: zats(EXPECT.balances.transparent ?? '0'),
  sapling: zats(EXPECT.balances.sapling ?? '0'),
  ironwood: zats(EXPECT.balances.ironwood ?? '0'),
};
const BIRTHDAY = Number(EXPECT.birthdayHeight ?? 0);

const parseMoney = (t) => {
  const m = t.match(/(-?\d+(?:\.\d+)?)/);
  return m === null ? null : zats(m[1]);
};

const problems = [];
const check = (cond, msg) => {
  console.log(cond ? `  ok: ${msg}` : `  FAIL: ${msg}`);
  if (!cond) problems.push(msg);
};

const launch = async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForSelector('[aria-label="welcome"]', { timeout: 15_000 });
  return { browser, page, errors };
};

// Wait until the wallet screen shows all three expected balances; bail out
// early if the app renders an error, so mismatches report what was seen.
const waitForBalances = async (page) => {
  const deadline = Date.now() + 600_000; // funded-seed scans can be long
  let last = '';
  while (Date.now() < deadline) {
    last = (await page.textContent('[aria-label="wallet"]').catch(() => '')) ?? '';
    const t = last.match(/Transparent\s*(-?[\d.]+|—)/);
    const s = last.match(/Sapling\s*(-?[\d.]+|—)/);
    const i = last.match(/Ironwood\s*(-?[\d.]+|—)/);
    if (t && s && i && ![t[1], s[1], i[1]].includes('—')) {
      const got = { transparent: parseMoney(t[1]), sapling: parseMoney(s[1]), ironwood: parseMoney(i[1]) };
      if (got.transparent === EXPECT_BAL.transparent && got.sapling === EXPECT_BAL.sapling && got.ironwood === EXPECT_BAL.ironwood)
        return { ok: true, got };
    }
    const errText = await page
      .$eval('[aria-label="restore"] .error, [aria-label="view-only import"] .error', (el) => el.textContent)
      .catch(() => null);
    if (errText !== null) return { ok: false, got: last, err: errText };
    await page.waitForTimeout(2_000);
  }
  return { ok: false, got: last, err: 'timeout waiting for expected balances' };
};

const scannedFloor = (text) => {
  const m = text.match(/scanned\s+([\d,]+)/);
  return m === null ? null : Number(m[1].replace(/,/g, ''));
};

// --- leg 1: Restore ----------------------------------------------------------
console.log(`leg 1 (restore, ${network})`);
{
  const { browser, page, errors } = await launch();
  await page.click('.tabs button:has-text("Restore")');
  const form = page.locator('[aria-label="restore"]');
  await form.locator('textarea').first().fill(MNEMONIC);
  if (PASSPHRASE !== '') await form.locator('input[type="password"]').fill(PASSPHRASE);
  // account index default is 0 — leave it (Zashi-compat account 0).
  if (BIRTHDAY > 0) {
    await form.locator('input[type="checkbox"]').uncheck(); // not full scan
    await form.locator('label:has-text("Birthday height") input').fill(String(BIRTHDAY));
  }
  await page.click('[aria-label="restore"] button:has-text("Restore")');
  const shown = await Promise.race([
    page.waitForSelector('[aria-label="wallet"]', { timeout: 300_000 }).then(() => true),
    page.waitForTimeout(300_000).then(() => false),
  ]);
  check(shown, 'restore reaches the wallet screen');
  if (shown) {
    const res = await waitForBalances(page);
    // got holds zats Bigints — stringify them for the failure echo.
    const gotJson = JSON.stringify(res.got, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 300);
    check(res.ok, `balances match Zashi (${gotJson}${res.ok ? '' : ` err=${res.err}`})`);
    if (BIRTHDAY > 0 && res.ok) {
      const scanned = scannedFloor((await page.textContent('[aria-label="wallet"]')) ?? '');
      check(scanned !== null && scanned >= BIRTHDAY, `scan starts at birthday height (scanned=${scanned} >= ${BIRTHDAY})`);
    }
    const body = (await page.textContent('body')) ?? '';
    check(!/Unlock/.test(body), 'no Unlock affordance rendered');
    check((await page.textContent('[data-testid="receive-address"]'))?.trim().length > 0, 'receive address rendered');
  }
  check(errors.length === 0, `no page errors (${errors.slice(0, 2)})`);
  // Wipe the secret fields before the evidence screenshot: on a failed leg the
  // form (with the phrase) is still on screen, and screenshotting it would pin
  // the mnemonic to disk — forbidden by the header invariant.
  await form.locator('textarea').first().fill('').catch(() => {});
  if (PASSPHRASE !== '') await form.locator('input[type="password"]').fill('').catch(() => {});
  await page.screenshot({ path: '/tmp/yaw-restore.png' });
  await browser.close();
}

// --- leg 2: View-only import (UFVK derived offline) --------------------------
console.log(`leg 2 (view-only, ${network})`);
{
  const { viewing } = await import(
    new URL('../node_modules/@zcashlabs/zcash.js/dist/src/viewing.js', import.meta.url).href
  );
  const { defineNetwork } = await import(
    new URL('../node_modules/@zcashlabs/zcash.js/dist/src/network.js', import.meta.url).href
  );
  const { createWalletClient } = await import('@zcashlabs/zcash.js');
  const net = await defineNetwork(network);
  const mem = await createWalletClient({
    network: net,
    storage: { kind: 'memory' },
    confirmations: { trusted: 1, untrusted: 1, allowZeroConfirmationShielding: false },
    observation: { pollIntervalMs: 3_000, maxBufferedUpdates: 16 },
    // No light/broadcaster: pure key-material derivation, zero network calls.
    recovery: { mode: 'offline' },
  });
  let ufvk;
  let secret;
  let pass;
  let signer;
  try {
    secret = new TextEncoder().encode(MNEMONIC.normalize('NFKD'));
    pass = PASSPHRASE === '' ? undefined : new TextEncoder().encode(PASSPHRASE);
    ({ signer } = await mem.accounts.import({
      accountIndex: 0,
      birthday: 'fullScan',
      mnemonic: secret,
      ...(pass === undefined ? {} : { passphrase: pass }),
    }));
    const descriptor = await signer.getAccount({ network: net, selector: { kind: 'derived', accountIndex: 0 } });
    ufvk = await viewing.export({
      account: descriptor,
      format: 'ufvk',
      acknowledge: 'discloses-viewing-authority',
    });
  } finally {
    signer?.dispose?.();
    secret?.fill(0);
    pass?.fill(0);
    await mem.close();
  }
  const { browser, page, errors } = await launch();
  await page.click('.tabs button:has-text("View-only")');
  const form = page.locator('[aria-label="view-only import"]');
  await form.locator('textarea').first().fill(ufvk);
  if (BIRTHDAY > 0) {
    await form.locator('input[type="checkbox"]').uncheck();
    await form.locator('label:has-text("Birthday height") input').fill(String(BIRTHDAY));
  }
  await page.click('[aria-label="view-only import"] button:has-text("Import")');
  const shown = await Promise.race([
    page.waitForSelector('[aria-label="wallet"]', { timeout: 300_000 }).then(() => true),
    page.waitForTimeout(300_000).then(() => false),
  ]);
  check(shown, 'view-only import reaches the wallet screen');
  if (shown) {
    const res = await waitForBalances(page);
    const gotJson = JSON.stringify(res.got, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 300);
    check(res.ok, `balances match Zashi (${gotJson}${res.ok ? '' : ` err=${res.err}`})`);
    const body = (await page.textContent('body')) ?? '';
    check(body.includes('View-only'), 'View-only chip rendered');
    // Scoped to the actions area and asserted non-empty, so a selector drift
    // fails loudly instead of passing on an empty string; a body-wide 'Send'
    // substring would also match future copy (e.g. 'Sender').
    const actions = page.locator('[aria-label="wallet"] .actions');
    check((await actions.count()) > 0, 'actions area present');
    const actionText = (await actions.innerText().catch(() => '')) ?? '';
    check(!/\bSend\b/.test(actionText), 'Send hidden for view-only Wallet (actions area)');
    check(body.includes('No spend authority'), 'view-only actions copy shown');
    check(!/Unlock/.test(body), 'no Unlock affordance rendered');
    check((await page.textContent('[data-testid="receive-address"]'))?.trim().length > 0, 'receive address rendered');
  }
  check(errors.length === 0, `no page errors (${errors.slice(0, 2)})`);
  // Same secret-before-screenshot rule as leg 1: on a failed leg the UFVK is
  // still in the textarea (viewing authority — a secret by the header rule).
  await form.locator('textarea').first().fill('').catch(() => {});
  await page.screenshot({ path: '/tmp/yaw-viewonly.png' });
  await browser.close();
}

console.log(problems.length === 0 ? 'RESTORE/VIEW-ONLY LEGS PASS' : `${problems.length} failure(s)`);
process.exit(problems.length === 0 ? 0 : 3);
