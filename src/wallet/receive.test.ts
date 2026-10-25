// Auto-rotating Receive Address (ADR-0004, issue #7): an observed inbound
// transfer advances the displayed Receive Address exactly once; self-change,
// self-payments and Shielding never rotate; every Exposed Address keeps its
// received amount. Driven through the engine port on the scriptable fake —
// no zcash.js, no markup.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createRegistry, idbRegistryStore, type Registry, type WalletRecord } from './registry';
import { createFakeEngine, type FakeEngine } from './engine/fake';
import { createWalletApp, type WalletApp } from './app';
import { DEFAULT_ENDPOINTS } from './policy';
import { createVault, idbVaultStore } from './vault';
import { syncAt, until } from './test-helpers';
import type { EngineHistoryEntry, EngineTransactionOutput } from './engine/port';

const row = (over: Partial<WalletRecord> & Pick<WalletRecord, 'id'>): WalletRecord => ({
  network: 'mainnet',
  name: 'wallet',
  fingerprint: 'abcd',
  kind: 'seed',
  lastUsed: 1,
  ...over,
});

const entry = (txid: string, over: Partial<EngineHistoryEntry> = {}): EngineHistoryEntry => ({
  txid,
  minedHeight: 2,
  blockTime: null,
  balanceDelta: 1_000n,
  pools: ['sapling'],
  isShielding: false,
  ...over,
});

const out = (address: string, value: bigint, over: Partial<EngineTransactionOutput> = {}): EngineTransactionOutput => ({
  address,
  value,
  isChange: false,
  sentFromThisWallet: false,
  ...over,
});

let engine: FakeEngine;
let registry: Registry;
let app: WalletApp;

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), writable: true, configurable: true });
  registry = createRegistry(idbRegistryStore());
  engine = createFakeEngine();
  app = createWalletApp({
    engine: engine.engine,
    registry,
    vault: createVault(idbVaultStore()),
    endpoints: DEFAULT_ENDPOINTS,
    requestPersist: async () => true,
  });
});

const mintsOf = (wallet: { calls: readonly string[] }): number =>
  wallet.calls.filter((c) => c === 'mintAddress').length;

/** A second app instance over the same registry+engine models a page reload. */
const reload = async (): Promise<WalletApp> => {
  const next = createWalletApp({
    engine: engine.engine,
    registry,
    vault: createVault(idbVaultStore()),
    endpoints: DEFAULT_ENDPOINTS,
    requestPersist: async () => true,
  });
  await next.boot();
  return next;
};

describe('Receive Address rotation (ADR-0004)', () => {
  it('inbound to the displayed address rotates exactly once and credits the Exposed Address', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ accounts: [{ id: 'acct-1', addresses: ['u1a'] }] });
    await app.boot();
    const w = engine.lastWallet();
    expect(app.address.get()).toBe('u1a');
    expect(mintsOf(w)).toBe(0); // boot observation saw empty history

    w.addTransaction('acct-1', entry('tx1'), [out('u1a', 1_000n)]);
    const rotated = until(app.address, (a) => a === 'u1minted2-acct-1');
    w.pushSync(syncAt(10, 10, true));
    await rotated;
    expect(mintsOf(w)).toBe(1);
    expect(app.exposedAddresses.get()).toEqual([
      { address: 'u1a', receivedZats: 1_000n },
      { address: 'u1minted2-acct-1', receivedZats: 0n },
    ]);

    // A later tick re-reads the SAME txid: no second advance, no second burn.
    const shown = app.exposedAddresses.get();
    const settled = until(app.exposedAddresses, (v) => v !== shown);
    w.pushSync(syncAt(11, 11, true));
    await settled;
    expect(app.address.get()).toBe('u1minted2-acct-1');
    expect(mintsOf(w)).toBe(1);
  });

  it('each new inbound rotates once more; every Exposed Address keeps its amount', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ accounts: [{ id: 'acct-1', addresses: ['u1a'] }] });
    await app.boot();
    const w = engine.lastWallet();

    w.addTransaction('acct-1', entry('tx1'), [out('u1a', 1_000n)]);
    const first = until(app.address, (a) => a === 'u1minted2-acct-1');
    w.pushSync(syncAt(10, 10, true));
    await first;

    w.addTransaction('acct-1', entry('tx2', { balanceDelta: 500n }), [out('u1minted2-acct-1', 500n)]);
    const second = until(app.address, (a) => a === 'u1minted3-acct-1');
    w.pushSync(syncAt(12, 12, true));
    await second;
    expect(mintsOf(w)).toBe(2);
    expect(app.exposedAddresses.get()).toEqual([
      { address: 'u1a', receivedZats: 1_000n },
      { address: 'u1minted2-acct-1', receivedZats: 500n },
      { address: 'u1minted3-acct-1', receivedZats: 0n },
    ]);
  });

  it('a payment that landed while closed rotates at boot, and the reload never burns a second index', async () => {
    await registry.add(row({ id: 'a' }));
    // tx1 paid u1a while the page was closed; boot observation must rotate.
    engine.queueWallet({
      accounts: [{ id: 'acct-1', addresses: ['u1a'], history: [entry('tx1')], transactions: { tx1: [out('u1a', 1_000n)] } }],
    });
    await app.boot();
    expect(app.address.get()).toBe('u1minted2-acct-1');
    expect(mintsOf(engine.lastWallet())).toBe(1);

    // Reload: the SDK's current() is already the fresh address (durable), so
    // re-seeing tx1 credits u1a without matching the display — no re-mint.
    engine.queueWallet({
      accounts: [{
        id: 'acct-1',
        addresses: ['u1a', 'u1minted2-acct-1'],
        history: [entry('tx1')],
        transactions: { tx1: [out('u1a', 1_000n)] },
      }],
    });
    const reloaded = await reload();
    expect(reloaded.address.get()).toBe('u1minted2-acct-1');
    expect(mintsOf(engine.lastWallet())).toBe(0);
    expect(reloaded.exposedAddresses.get()).toEqual([
      { address: 'u1a', receivedZats: 1_000n },
      { address: 'u1minted2-acct-1', receivedZats: 0n },
    ]);
  });

  it('own change back to the displayed address never rotates', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({
      accounts: [{
        id: 'acct-1',
        addresses: ['u1a'],
        history: [entry('tx-self')],
        transactions: { 'tx-self': [out('u1a', 1_000n, { isChange: true })] },
      }],
    });
    await app.boot();
    expect(app.address.get()).toBe('u1a');
    expect(mintsOf(engine.lastWallet())).toBe(0);
    // Change is not "received" either — the list shows 0.
    expect(app.exposedAddresses.get()).toEqual([{ address: 'u1a', receivedZats: 0n }]);
  });

  it('a self-payment from this Wallet to the displayed address never rotates', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({
      accounts: [{
        id: 'acct-1',
        addresses: ['u1a'],
        history: [entry('tx-own')],
        transactions: { 'tx-own': [out('u1a', 1_000n, { sentFromThisWallet: true })] },
      }],
    });
    await app.boot();
    expect(app.address.get()).toBe('u1a');
    expect(mintsOf(engine.lastWallet())).toBe(0);
    expect(app.exposedAddresses.get()).toEqual([{ address: 'u1a', receivedZats: 0n }]);
  });

  it('Shielding never rotates, even with outputs on the displayed address', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({
      accounts: [{
        id: 'acct-1',
        addresses: ['u1a'],
        history: [entry('tx-shield', { isShielding: true })],
        transactions: { 'tx-shield': [out('u1a', 1_000n)] },
      }],
    });
    await app.boot();
    expect(app.address.get()).toBe('u1a');
    expect(mintsOf(engine.lastWallet())).toBe(0);
    // A Shielding moves the Wallet's own transparent funds: not received.
    expect(app.exposedAddresses.get()).toEqual([{ address: 'u1a', receivedZats: 0n }]);
  });

  it('view-only: inbound credits the Exposed Address but never mints (no spend key)', async () => {
    await registry.add(row({ id: 'v', kind: 'viewonly' }));
    engine.queueWallet({
      accounts: [{
        id: 'acct-1',
        viewOnly: true,
        addresses: ['u1view1'],
        history: [entry('tx1')],
        transactions: { tx1: [out('u1view1', 1_000n)] },
      }],
    });
    await app.boot();
    expect(app.address.get()).toBe('u1view1');
    expect(mintsOf(engine.lastWallet())).toBe(0);
    expect(app.exposedAddresses.get()).toEqual([{ address: 'u1view1', receivedZats: 1_000n }]);
  });

  it('a tx readable only after enhancement still rotates exactly once when complete', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ accounts: [{ id: 'acct-1', addresses: ['u1a'] }] });
    await app.boot();
    const w = engine.lastWallet();

    // A fresh block: history lists tx1, but its wallet transaction lags —
    // outputs answer as an unreadable placeholder.
    w.addTransaction('acct-1', entry('tx1'), [out('u1a', 1_000n)]);
    w.pendingTxs.add('tx1');
    const atBoot = app.exposedAddresses.get();
    w.pushSync(syncAt(10, 10, true));
    await until(app.exposedAddresses, (v) => v !== atBoot); // tick processed
    // No rotation on unreadable outputs, none credited — but nothing was
    // consumed either: the txid stays unobserved.
    expect(app.address.get()).toBe('u1a');
    expect(mintsOf(w)).toBe(0);
    expect(w.calls.filter((c) => c === 'listTransactionOutputs')).toHaveLength(1);

    // Enhancement lands; the NEXT tick re-reads tx1 (no pendingTxs block),
    // this time paying the displayed address: rotate once.
    w.resolveTransactions('tx1');
    const shown = app.exposedAddresses.get();
    const settled = until(app.exposedAddresses, (v) => v !== shown);
    w.pushSync(syncAt(11, 11, true));
    await settled;
    expect(app.address.get()).toBe('u1minted2-acct-1');
    expect(mintsOf(w)).toBe(1);
    expect(app.exposedAddresses.get()).toEqual([
      { address: 'u1a', receivedZats: 1_000n },
      { address: 'u1minted2-acct-1', receivedZats: 0n },
    ]);

    // A third tick must not re-rotate nor re-credit.
    const before = app.exposedAddresses.get();
    const again = until(app.exposedAddresses, (v) => v !== before);
    w.pushSync(syncAt(12, 12, true));
    await again;
    expect(mintsOf(w)).toBe(1);
    expect(app.exposedAddresses.get()[0]?.receivedZats).toBe(1_000n);
  });

  it('an inbound landing on a deeper-than-20th history entry still rotates at boot', async () => {
    await registry.add(row({ id: 'a' }));
    // 21 entries; the inbound payment is the OLDEST — outside a tick's 20.
    const history = Array.from({ length: 21 }, (_, i) => entry(`filler${i}`, { minedHeight: 100 - i }));
    history.push(entry('tx-old', { minedHeight: 50 }));
    const transactions: Record<string, EngineTransactionOutput[]> = { 'tx-old': [out('u1a', 1_000n)] };
    engine.queueWallet({ accounts: [{ id: 'acct-1', addresses: ['u1a'], history, transactions }] });
    await app.boot();
    expect(app.address.get()).toBe('u1minted2-acct-1');
    expect(mintsOf(engine.lastWallet())).toBe(1);
    expect(app.exposedAddresses.get()?.[0]).toEqual({ address: 'u1a', receivedZats: 1_000n });
  });
});
