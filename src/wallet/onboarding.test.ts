// Onboarding (issue #4): Create + forced backup gate, Restore, View-only
// import, phrase zeroization, view-only capability gating.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createRegistry, idbRegistryStore, type Registry } from './registry';
import { createFakeEngine, type FakeEngine } from './engine/fake';
import { createWalletApp, type WalletApp } from './app';
import { DEFAULT_ENDPOINTS } from './policy';
import { validatePhrase } from './keys';

// A valid test vector phrase (all-zero entropy) for restore tests.
const FUNDED_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let engine: FakeEngine;
let registry: Registry;
let app: WalletApp;
let persistCalls: number;
const consumed: Uint8Array[] = [];

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), writable: true, configurable: true });
  registry = createRegistry(idbRegistryStore());
  engine = createFakeEngine();
  persistCalls = 0;
  app = createWalletApp({
    engine: engine.engine,
    registry,
    endpoints: DEFAULT_ENDPOINTS,
    requestPersist: async () => {
      persistCalls += 1;
      return true;
    },
    traceSecret: (b) => consumed.push(b),
  });
});

describe('create wallet', () => {
  it('creates, registers (fingerprint + kind seed), requests persistence, opens live', async () => {
    const created = await app.onCreate.generate();
    expect(created.phrase.split(' ')).toHaveLength(24);
    expect(validatePhrase(created.phrase)).toBe(true);
    // nothing registered until the backup gate is satisfied
    expect(await registry.list('testnet')).toHaveLength(0);
    const done = await app.onCreate.confirmBackup(created.phrase);
    expect(done.ok).toBe(true);
    const rows = await registry.list('testnet');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'seed' });
    expect(rows[0]!.fingerprint).toMatch(/^[a-z2-7]{4}$/);
    expect(persistCalls).toBe(1);
    // wallet is now live: opened, recovery done, syncing
    expect(app.screen.get()).toBe('wallet');
    expect(app.recovered.get()).toBe(true);
    expect(engine.lastWallet().calls).toContain('startSync');
  });

  it('passes the phrase to the engine as UTF-8 bytes, then zeroizes them', async () => {
    const created = await app.onCreate.generate();
    await app.onCreate.confirmBackup(created.phrase);
    const w = engine.lastWallet();
    expect(w.calls).toContain('createSeed');
    const fed = consumed[consumed.length - 1];
    expect(fed).toBeDefined();
    expect(fed.every((b) => b === 0)).toBe(true);
  });

  it('backup gate cannot be bypassed: wrong/empty confirmation keeps it pending', async () => {
    const created = await app.onCreate.generate();
    const bad = await app.onCreate.confirmBackup('wrong words here');
    expect(bad.ok).toBe(false);
    expect(await registry.list('testnet')).toHaveLength(0);
    expect(app.screen.get()).not.toBe('wallet');
    // and the correct phrase still completes
    const ok = await app.onCreate.confirmBackup(created.phrase);
    expect(ok.ok).toBe(true);
    expect((await registry.list('testnet'))).toHaveLength(1);
  });

  it('gate completion is idempotent: one registry row, one client', async () => {
    const created = await app.onCreate.generate();
    await app.onCreate.confirmBackup(created.phrase);
    const again = await app.onCreate.confirmBackup(created.phrase);
    expect(again.ok).toBe(true);
    expect(await registry.list('testnet')).toHaveLength(1);
    expect(engine.opens).toHaveLength(1);
  });

  it('engine open failure surfaces as a result; the gate stays open for retry', async () => {
    const created = await app.onCreate.generate();
    engine.queueWallet({ openError: 'STORAGE_BUSY' });
    const res = await app.onCreate.confirmBackup(created.phrase);
    expect(res).toMatchObject({ ok: false, code: 'STORAGE_BUSY' });
    expect(await registry.list('testnet')).toHaveLength(0);
    // retry succeeds: the generated phrase is still in flight
    engine.queueWallet({ accounts: [{ id: 'acct-1' }] });
    const retry = await app.onCreate.confirmBackup(created.phrase);
    expect(retry.ok).toBe(true);
    expect(app.screen.get()).toBe('wallet');
  });
});

describe('restore', () => {
  it('restores with accountIndex 0 + explicit birthday, then goes live', async () => {
    const res = await app.onRestore.restore({
      phrase: FUNDED_PHRASE,
      accountIndex: 0,
      birthday: { kind: 'height', height: 2_000_123 },
      name: 'restored',
    });
    expect(res.ok).toBe(true);
    const w = engine.lastWallet();
    expect(w.calls).toContain('resolveBirthday');
    expect(w.calls).toContain('importSeed');
    const rows = await registry.list('testnet');
    expect(rows[0]).toMatchObject({ kind: 'seed', name: 'restored' });
    expect(app.screen.get()).toBe('wallet');
    // fed bytes zeroized
    expect(consumed[consumed.length - 1]!.every((b) => b === 0)).toBe(true);
  });

  it('fullScan choice skips birthday resolution', async () => {
    const res = await app.onRestore.restore({ phrase: FUNDED_PHRASE, accountIndex: 0, birthday: 'fullScan' });
    expect(res.ok).toBe(true);
    const w = engine.lastWallet();
    expect(w.calls).not.toContain('resolveBirthday');
    expect(w.calls).toContain('importSeed');
  });

  it('optional passphrase is forwarded and zeroized too', async () => {
    const res = await app.onRestore.restore({
      phrase: FUNDED_PHRASE,
      passphrase: 'hunter2 long enough',
      accountIndex: 0,
      birthday: 'fullScan',
    });
    expect(res.ok).toBe(true);
    expect(consumed.length).toBeGreaterThanOrEqual(2);
    expect(consumed.every((b) => b.every((x) => x === 0))).toBe(true);
  });

  it('rejects invalid phrases with INVALID_MNEMONIC, registers nothing', async () => {
    const res = await app.onRestore.restore({ phrase: 'not valid words', accountIndex: 0, birthday: 'fullScan' });
    expect(res).toMatchObject({ ok: false, code: 'INVALID_MNEMONIC' });
    expect(await registry.list('testnet')).toHaveLength(0);
  });
});

describe('view-only import', () => {
  it('imports a UFVK as kind=viewonly; syncs, no spend authority', async () => {
    const res = await app.onViewOnly.import({ viewingKey: 'uview1abc123', birthday: 'fullScan', name: 'watcher' });
    expect(res.ok).toBe(true);
    const rows = await registry.list('testnet');
    expect(rows[0]).toMatchObject({ kind: 'viewonly', name: 'watcher' });
    expect(engine.lastWallet().calls).toContain('importViewing');
    expect(app.screen.get()).toBe('wallet');
    expect(app.canSpend.get()).toBe(false);
  });

  it('accepts a testnet (testview…) key as kind=viewonly', async () => {
    const res = await app.onViewOnly.import({ viewingKey: 'testview1abc123', birthday: 'fullScan' });
    expect(res.ok).toBe(true);
    expect((await registry.list('testnet'))[0]).toMatchObject({ kind: 'viewonly' });
  });

  it('rejects malformed viewing keys', async () => {
    const res = await app.onViewOnly.import({ viewingKey: 'garbage!', birthday: 'fullScan' });
    expect(res).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await registry.list('testnet')).toHaveLength(0);
  });
});

describe('view-only capability gating', () => {
  const seeded = async (): Promise<void> => {
    await registry.add({
      id: 'v1',
      network: 'testnet',
      name: 'watcher',
      fingerprint: 'abcd',
      kind: 'viewonly',
      lastUsed: 1,
    });
    engine.queueWallet({ accounts: [{ id: 'acct-1', viewOnly: true, balance: { sapling: 7n }, addresses: ['u1viewwatch1'] }] });
    await app.boot();
  };

  it('send attempts are refused at the capability gate', async () => {
    await seeded();
    expect(app.guardSpend()).toEqual({ ok: false, reason: 'view-only' });
    expect(engine.lastWallet().calls).not.toContain('propose');
  });

  it('history and receive still render for a view-only Wallet', async () => {
    await seeded();
    expect(app.address.get()).toMatch(/^u1view/);
    expect(await app.history()).toHaveLength(0);
  });
});
