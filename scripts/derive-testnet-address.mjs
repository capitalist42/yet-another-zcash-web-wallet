#!/usr/bin/env node
// One-time faucet bootstrap (ticket #2, issue #15 blocker).
//
// The public testnet went NU7 (block 4,465,026, 2026-10-04) while the bundled
// @zcashlabs/zcash.js@0.1.0-rc.5 codec tops out at Nu6.3, so any client with a
// `light` endpoint dies at the getinfo branch check (NETWORK_MISMATCH). But
// RECEIVING faucet funds needs no light client at all: native address
// derivation is pure key material, and an address is chain-branch agnostic.
// So: build the testnet network object (the rc.5 schedule only matters at NU7
// heights, which derivation never consults), open an in-memory client with NO
// light/broadcaster, create the account from the caller's mnemonic, and print
// the unified + transparent addresses. The faucet pays the transparent one.
//
// The mnemonic is the operator's own; NOTHING persists to disk (storage kind
// 'memory' only). Keys land exactly where the post-NU7 SDK will read them, so
// the same phrase can be imported into the real wallet later (account 0).
//
// Usage:  ZCASH_MNEMONIC="all 24 words" node scripts/derive-testnet-address.mjs
import { createWalletClient } from '@zcashlabs/zcash.js';
// defineNetwork + viewing/addresses helpers are package-internal (not in the
// exports map); file-URL imports bypass package resolution on purpose —
// bootstrap plumbing only, never product code.
const { defineNetwork } = await import(
  new URL('../node_modules/@zcashlabs/zcash.js/dist/src/network.js', import.meta.url).href,
);
const { viewing, addresses } = await import(
  new URL('../node_modules/@zcashlabs/zcash.js/dist/src/viewing.js', import.meta.url).href,
);

const mnemonic = process.env.ZCASH_MNEMONIC;
if (!mnemonic) {
  console.error('set ZCASH_MNEMONIC="24 words" (your own phrase; never logged)');
  process.exit(2);
}

const network = await defineNetwork('testnet');
const client = await createWalletClient({
  network,
  storage: { kind: 'memory' },
  confirmations: { trusted: 1, untrusted: 1, allowZeroConfirmationShielding: false },
  observation: { pollIntervalMs: 3_000, maxBufferedUpdates: 16 },
  // No `light`, no `broadcaster`: recovery runs offline, zero network calls.
  recovery: { mode: 'offline' },
});
try {
  // create() and the wallet addresses API both want a synced tip for their
  // birthday/consensus context (SYNC_REQUIRED with no light client). import +
  // fullScan sidesteps the birthday; the UNATTACHED signer then hands out a
  // native account descriptor, and the standalone viewing API derives
  // addresses as pure key material — deterministic, no consensus context.
  // accountIndex 0 = account 0 of the phrase, the same one the wallet will
  // import once the NU7-capable SDK lands.
  const secret = new TextEncoder().encode(mnemonic.normalize('NFKD'));
  const { account, signer } = await client.accounts.import({
    accountIndex: 0,
    birthday: 'fullScan',
    mnemonic: secret,
  });
  void account;
  const descriptor = await signer.getAccount({
    network,
    selector: { kind: 'derived', accountIndex: 0 },
  });
  const ufvk = await viewing.export({
    account: descriptor,
    format: 'ufvk',
    acknowledge: 'discloses-viewing-authority',
  });
  const unified = await addresses.derive({ account: descriptor, index: 0n });
  const transparent = await addresses.derive({
    account: descriptor,
    index: 0n,
    request: { format: 'transparent' },
  });
  console.log(JSON.stringify(
    { ufvk, unified: unified.address, transparent: transparent.address },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ));
  signer.dispose?.();
} finally {
  await client.close();
}
