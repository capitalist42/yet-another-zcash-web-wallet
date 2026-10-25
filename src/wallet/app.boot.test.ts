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

// A valid test vector phrase (all-zero entropy) for the restore race case.
const FUNDED_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const row = (over: Partial<WalletRecord> & Pick<WalletRecord, 'id'>): WalletRecord => ({
  network: 'mainnet',
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
    expect(app.network.get()).toBe('mainnet');
    expect(engine.opens).toHaveLength(0);
  });

  it('opens the last-used Wallet for the active network with the right spec', async () => {
    await registry.add(row({ id: 'old', network: 'testnet', lastUsed: 100 }));
    await registry.add(row({ id: 'new', network: 'testnet', lastUsed: 300 }));
    app.network.set('testnet');
    await app.boot();
    expect(engine.opens).toHaveLength(1);
    const spec = engine.opens[0]!.spec;
    expect(spec.storageName).toBe('yaw-testnet-new');
    expect(spec.network).toBe('testnet');
    expect(spec.endpoint).toContain('chainsafe');
    expect((await registry.get('new'))?.lastUsed).toBeGreaterThanOrEqual(300);
  });

  it('reload finishes a wallet that was saved before the account existed', async () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const mem = new Map<string, string>();
    const previous = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => mem.get(key) ?? null,
        setItem: (key: string, value: string) => { mem.set(key, value); },
        removeItem: (key: string) => { mem.delete(key); },
      },
    });
    try {
      await registry.add(row({ id: 'pend', network: 'mainnet', fingerprint: '', lastUsed: 9 }));
      mem.set('yaw-pending-seed', JSON.stringify({ id: 'pend', phrase }));
      engine.queueWallet({ accounts: [] });
      await app.boot({ restoreLatest: true });
      expect(app.screen.get()).toBe('wallet');
      expect(app.walletInfo.get()?.id).toBe('pend');
      expect(app.backupPending.get()).toBe(false);
      expect((await registry.get('pend'))?.fingerprint).toMatch(/^[a-z2-7]{4}$/);
      expect(mem.has('yaw-pending-seed')).toBe(false);
      expect(engine.opens).toHaveLength(1);
    } finally {
      if (previous === undefined) delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
      else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: previous });
    }
  });

  it('reload opens the newest wallet even when the default network is the other one', async () => {
    await registry.add(row({ id: 'm', network: 'mainnet', lastUsed: 10 }));
    await registry.add(row({ id: 't', network: 'testnet', lastUsed: 50 }));
    engine.queueWallet({ accounts: [{ id: 'acct-t' }] });
    await app.boot({ restoreLatest: true });
    expect(app.network.get()).toBe('testnet');
    expect(app.screen.get()).toBe('wallet');
    expect(app.walletInfo.get()?.id).toBe('t');
    expect(app.endpoint.get()).toContain('zcash-testnet');
  });

  it('reload keeps the chosen network when no wallet is saved', async () => {
    const saved = new Map<string, string>();
    const previous = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => {
          saved.set(key, value);
        },
      },
    });
    try {
      await app.setNetwork('testnet');
      expect(app.screen.get()).toBe('welcome');
      const reloaded = createWalletApp({
        engine: engine.engine,
        registry,
        endpoints: DEFAULT_ENDPOINTS,
        requestPersist: async () => true,
      });
      await reloaded.boot({ restoreLatest: true });
      expect(reloaded.network.get()).toBe('testnet');
      expect(reloaded.screen.get()).toBe('welcome');
    } finally {
      if (previous === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
    }
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
    app.network.set('testnet');
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

  it('setNetwork mid-create lets the switch keep its session', async () => {
    // The full race: the target network HAS a Wallet, so the switch's boot
    // opens a live client while the testnet create is still in flight.
    // The switch owns the session then; the create may only land its record.
    await registry.add(row({ id: 'm', network: 'mainnet' }));
    app.network.set('testnet');
    engine.queueWallet({ holdOpen: true }); // create client (testnet)
    const created = await app.onCreate.generate();
    const openBegan = engine.openStarted();
    const flow = app.onCreate.confirmBackup(created.phrase);
    await openBegan;
    engine.queueWallet({ accounts: [{ id: 'acct-m' }] }); // mainnet boot client
    await app.setNetwork('mainnet'); // switch lands mid-create
    expect(app.walletInfo.get()?.id).toBe('m');
    engine.pending().releaseOpen(); // create client finishes
    expect((await flow).ok).toBe(true);
    // the record lands where it belongs: nothing relabeled, nothing lost
    expect((await registry.list('mainnet')).map((w) => w.id)).toEqual(['m']);
    const testnet = engine.opens.find((o) => o.spec.network === 'testnet')!.wallet;
    expect(testnet.closed).toBe(true); // ours closes, data lives in its own DB
    // the switch's session survived: its client open, stores still its own
    const mainnet = engine.opens.find((o) => o.spec.network === 'mainnet')!.wallet;
    expect(mainnet.calls).not.toContain('close');
    expect(app.walletInfo.get()?.id).toBe('m');
    expect(app.screen.get()).toBe('wallet');
  });

  it('a network switch during restore keeps its own session too', async () => {
    // Same race on the shared flow tail that Restore and View-only import
    // use: the switch's booted session must survive the flow landing.
    await registry.add(row({ id: 'm', network: 'mainnet' }));
    app.network.set('testnet');
    engine.queueWallet({ holdOpen: true }); // restore client (testnet)
    const openBegan = engine.openStarted();
    const flow = app.onRestore.restore({ phrase: FUNDED_PHRASE, accountIndex: 0, birthday: 'fullScan' });
    await openBegan;
    engine.queueWallet({ accounts: [{ id: 'acct-m' }] }); // mainnet boot client
    await app.setNetwork('mainnet'); // switch lands mid-flow
    engine.pending().releaseOpen();
    expect((await flow).ok).toBe(true);
    const testnet = engine.opens.find((o) => o.spec.network === 'testnet')!.wallet;
    expect(testnet.closed).toBe(true); // ours lands the row, then closes
    const mainnet = engine.opens.find((o) => o.spec.network === 'mainnet')!.wallet;
    expect(mainnet.calls).not.toContain('close');
    expect(app.walletInfo.get()?.id).toBe('m');
    expect((await registry.list('testnet'))[0]).toMatchObject({ network: 'testnet', kind: 'seed' });
  });

  it('settings shows the network choice and leaves the open wallet alone until it changes', async () => {
    await registry.add(row({ id: 'm' }));
    await registry.add(row({ id: 't', network: 'testnet' }));
    engine.queueWallet({ accounts: [{ id: 'acct-m' }] });
    await app.boot();
    expect(app.walletInfo.get()?.id).toBe('m');
    app.openSettings();
    expect(app.screen.get()).toBe('settings');
    expect(engine.lastWallet().closed).toBe(false);
    app.closeSettings();
    expect(app.screen.get()).toBe('wallet');
    expect(app.network.get()).toBe('mainnet');
    app.openSettings();
    engine.queueWallet({ accounts: [{ id: 'acct-t' }] });
    await app.setNetwork('testnet');
    expect(app.screen.get()).toBe('wallet');
    expect(app.network.get()).toBe('testnet');
    expect(app.walletInfo.get()?.id).toBe('t');
    expect(engine.opens[0]!.wallet.closed).toBe(true);
  });

  it('a clean boot clears the previous bootError', async () => {
    let fail = true;
    const flaky: Registry = {
      ...registry,
      lastUsed: async (net) => {
        if (fail) throw new Error('idb down');
        return registry.lastUsed(net);
      },
    };
    const a = createWalletApp({
      engine: engine.engine,
      registry: flaky,
      endpoints: DEFAULT_ENDPOINTS,
      requestPersist: async () => true,
    });
    await a.boot();
    expect(a.bootError.get()).toBe('idb down');
    fail = false;
    await a.setNetwork('testnet'); // a real switch boots again and must drop the old error
    expect(a.screen.get()).toBe('welcome');
    expect(a.bootError.get()).toBeNull();
  });
});
