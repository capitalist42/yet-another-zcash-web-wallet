// Boot choreography (issue #3): registry → open last-used Wallet → await
// startup recovery → balances from local DB → start sync. All through the
// engine port on the scriptable fake.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createRegistry, idbRegistryStore, type Registry, type WalletRecord } from './registry';
import { createFakeEngine, type FakeEngine } from './engine/fake';
import { createWalletApp, type WalletApp } from './app';
import { DEFAULT_ENDPOINTS } from './policy';

const row = (over: Partial<WalletRecord> & Pick<WalletRecord, 'id'>): WalletRecord => ({
  network: 'testnet',
  name: 'wallet',
  fingerprint: 'abcd',
  kind: 'seed',
  lastUsed: 1,
  ...over,
});

const syncAt = (scanned: number | null, target: number | null, reached = false) => ({
  activity: 'running' as const,
  scanned,
  target,
  targetReached: reached,
  scanComplete: reached ? true : null,
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
    endpoints: DEFAULT_ENDPOINTS,
    requestPersist: async () => true,
  });
});

describe('boot choreography', () => {
  it('fresh registry → welcome, no engine calls', async () => {
    await app.boot();
    expect(app.screen.get()).toBe('welcome');
    expect(engine.opens).toHaveLength(0);
  });

  it('opens the last-used Wallet for the active network with the right spec', async () => {
    await registry.add(row({ id: 'old', lastUsed: 100 }));
    await registry.add(row({ id: 'new', lastUsed: 300 }));
    app.network.set('testnet');
    await app.boot();
    expect(engine.opens).toHaveLength(1);
    const spec = engine.opens[0]!.spec;
    expect(spec.storageName).toBe('yaw-testnet-new');
    expect(spec.network).toBe('testnet');
    expect(spec.endpoint).toContain('chainsafe');
    expect((await registry.get('new'))?.lastUsed).toBeGreaterThanOrEqual(300);
  });

  it('per-network: booting mainnet ignores testnet rows', async () => {
    await registry.add(row({ id: 't', network: 'testnet' }));
    app.network.set('mainnet');
    await app.boot();
    expect(app.screen.get()).toBe('welcome');
    expect(engine.opens).toHaveLength(0);
  });

  it('STORAGE_BUSY from open renders the busy screen, not a crash', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ openError: 'STORAGE_BUSY' });
    await app.boot();
    expect(app.screen.get()).toBe('storage-busy');
  });

  /** Resolve when a store next satisfies `pred` (deterministic, no timers). */
  const until = <T,>(store: { subscribe(fn: (v: T) => void): () => void }, pred: (v: T) => boolean): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const unsub = store.subscribe((v) => {
      if (!pred(v)) return;
      unsub();
      resolve();
    });
    return promise;
  };

  it('startup order: recovery awaited → balances from DB → THEN sync', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ holdOpen: true, accounts: [{ id: 'acct-1', balance: { sapling: 5n } }] });
    const booted = app.boot();
    await engine.openStarted(); // open entered; recovery gate holds it
    // open still in flight: nothing rendered, no reads, payment paths gated
    const held = engine.pending();
    expect(held.calls).not.toContain('getBalance');
    expect(held.calls).not.toContain('startSync');
    expect(app.balances.get()).toBeNull();
    expect(app.recovered.get()).toBe(false);
    expect(app.canSpend.get()).toBe(false);
    held.releaseOpen();
    await booted;
    const calls = engine.lastWallet().calls;
    const balanceAt = calls.indexOf('getBalance');
    const watchAt = calls.indexOf('watchSync');
    const startSyncAt = calls.indexOf('startSync');
    expect(balanceAt).toBeGreaterThan(-1);
    // watch stream only publishes on scan-revision change: subscribe before
    // triggering sync or the first progress ticks are lost
    expect(watchAt).toBeGreaterThan(balanceAt);
    expect(startSyncAt).toBeGreaterThan(watchAt);
    expect(app.recovered.get()).toBe(true);
    expect(app.canSpend.get()).toBe(true);
    expect(app.balances.get()?.sapling).toBe(5n);
  });

  it('payment paths stay gated until recovery completes', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ holdOpen: true, accounts: [{ id: 'acct-1' }] });
    const booted = app.boot();
    await engine.openStarted(); // startup recovery still in flight
    expect(app.recovered.get()).toBe(false);
    expect(app.guardSpend()).toEqual({ ok: false, reason: 'unavailable' });
    engine.pending().releaseOpen();
    await booted;
    expect(app.guardSpend()).toEqual({ ok: true });
  });

  it('sync progress flows from the watch stream into the store', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ accounts: [{ id: 'acct-1' }] });
    await app.boot();
    const w = engine.lastWallet();
    const first = until(app.sync, (s) => s?.scanned === 100);
    w.pushSync(syncAt(100, 500));
    await first;
    expect(app.sync.get()).toMatchObject({ scanned: 100, target: 500 });
    const second = until(app.sync, (s) => s?.targetReached === true);
    w.pushSync(syncAt(500, 500, true));
    await second;
  });

  it('non-terminal operations light the Pending Payments chip', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({
      accounts: [{ id: 'acct-1' }],
      operations: [{ operationId: 'op1', phase: 'observing', txid: 'tx1' }],
    });
    await app.boot();
    expect(app.pendingCount.get()).toBe(1);
    const w = engine.lastWallet();
    w.setOperations([{ operationId: 'op1', phase: 'complete', txid: 'tx1' }]);
    const refreshed = until(app.pendingCount, (n) => n === 0);
    w.pushSync(syncAt(1, 1, true)); // a sync tick re-reads operations
    await refreshed;
    expect(app.pendingCount.get()).toBe(0);
  });

  it('receive address: current() read; never mint when present', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ accounts: [{ id: 'acct-1', addresses: ['u1shown'] }] });
    await app.boot();
    expect(app.address.get()).toBe('u1shown');
    expect(engine.lastWallet().calls).not.toContain('mintAddress');
  });

  it('null current address mints exactly one', async () => {
    await registry.add(row({ id: 'a' }));
    engine.queueWallet({ accounts: [{ id: 'acct-1', addresses: [] }] });
    await app.boot();
    expect(app.address.get()).toMatch(/^u1minted/);
    expect(engine.lastWallet().calls.filter((c) => c === 'mintAddress')).toHaveLength(1);
  });

  it('view-only wallet: synced, funded display, no spend capability, never mints', async () => {
    await registry.add(row({ id: 'v', kind: 'viewonly' }));
    engine.queueWallet({ accounts: [{ id: 'acct-1', viewOnly: true }] });
    await app.boot();
    expect(app.walletInfo.get()?.kind).toBe('viewonly');
    expect(app.canSpend.get()).toBe(false);
    expect(app.recovered.get()).toBe(true);
    // mint needs a spend key; the SDK rejects it for view-only accounts
    expect(engine.lastWallet().calls).not.toContain('mintAddress');
    expect(app.address.get()).toBeNull();
    expect(engine.lastWallet().calls).toContain('startSync');
  });

  it('setNetwork reboots against the other network, closing the old client', async () => {
    await registry.add(row({ id: 't', network: 'testnet' }));
    await registry.add(row({ id: 'm', network: 'mainnet' }));
    app.network.set('testnet');
    await app.boot();
    await app.setNetwork('mainnet');
    expect(engine.opens.map((o) => o.spec.network)).toEqual(['testnet', 'mainnet']);
    expect(engine.opens[0]!.wallet.calls).toContain('close');
    expect(app.walletInfo.get()?.id).toBe('m');
  });
  it('registry failure during boot surfaces honestly: welcome + bootError, no crash', async () => {
    // IndexedDB dying on lastUsed must not reject boot() into the void.
    const broken: Registry = {
      ...registry,
      lastUsed: async () => {
        throw new Error('idb down');
      },
    };
    const a = createWalletApp({
      engine: engine.engine,
      registry: broken,
      endpoints: DEFAULT_ENDPOINTS,
      requestPersist: async () => true,
    });
    await expect(a.boot()).resolves.toBeUndefined();
    expect(a.screen.get()).toBe('welcome');
    expect(a.bootError.get()).toBe('idb down');
    expect(engine.opens).toHaveLength(0);
  });

  it('setNetwork mid-create does not relabel the Wallet onto the other network', async () => {
    engine.queueWallet({ holdOpen: true });
    const created = await app.onCreate.generate();
    // confirmBackup reaches engine.open synchronously: capture the gate first.
    const openBegan = engine.openStarted();
    const flow = app.onCreate.confirmBackup(created.phrase);
    await openBegan; // create in flight on testnet
    await app.setNetwork('mainnet'); // network flips under the flow
    engine.pending().releaseOpen();
    expect((await flow).ok).toBe(true);
    // the record stays on the network the client was actually opened with
    expect(await registry.list('mainnet')).toHaveLength(0);
    const rows = await registry.list('testnet');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ network: 'testnet', kind: 'seed' });
  });
});
