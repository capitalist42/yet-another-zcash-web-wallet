// Registry behavior runs against fake-indexeddb through the REAL IndexedDB
// adapter — the storage layer itself is under test, not a mock of it.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRegistry, idbRegistryStore, type WalletRecord } from './registry';

const freshRegistry = () => {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), writable: true, configurable: true });
  return createRegistry(idbRegistryStore());
};

const row = (over: Partial<WalletRecord> & Pick<WalletRecord, 'id'>): WalletRecord => ({
  network: 'testnet',
  name: 'wallet',
  fingerprint: 'abcd',
  kind: 'seed',
  lastUsed: 0,
  ...over,
});

describe('registry (IndexedDB)', () => {
  beforeEach(() => {
    freshRegistry();
  });

  it('round-trips a record through IndexedDB', async () => {
    const r = freshRegistry();
    await r.add(row({ id: 'w1', name: 'savings' }));
    expect(await r.get('w1')).toMatchObject({ id: 'w1', name: 'savings' });
  });

  it('lastUsed returns the most recently opened Wallet per Network', async () => {
    const r = freshRegistry();
    await r.add(row({ id: 'a', network: 'testnet', lastUsed: 100 }));
    await r.add(row({ id: 'b', network: 'testnet', lastUsed: 300 }));
    await r.add(row({ id: 'c', network: 'mainnet', lastUsed: 500 }));
    expect((await r.lastUsed('testnet'))?.id).toBe('b');
    expect((await r.lastUsed('mainnet'))?.id).toBe('c');
  });

  it('touch marks the winner and persists', async () => {
    const r = freshRegistry();
    await r.add(row({ id: 'a', lastUsed: 100 }));
    await r.add(row({ id: 'b', lastUsed: 200 }));
    await r.touch('a');
    const after = await r.lastUsed('testnet');
    expect(after?.id).toBe('a');
    expect(after!.lastUsed).toBeGreaterThan(200);
  });

  it('list is per-network, newest first; remove deletes', async () => {
    const r = freshRegistry();
    await r.add(row({ id: 'a', lastUsed: 100 }));
    await r.add(row({ id: 'b', lastUsed: 300 }));
    await r.add(row({ id: 'm', network: 'mainnet' }));
    expect((await r.list('testnet')).map((w) => w.id)).toEqual(['b', 'a']);
    await r.remove('b');
    expect(await r.get('b')).toBeNull();
  });
});
