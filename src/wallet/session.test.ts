// Session/Lock model (issue #6): deadline+flag matrix, auto-lock accounting,
// app-wide Lock propagation, wrong-phrase failure, zeroization. Fake engine
// + fake timers — asserts observable service behavior through the port.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createRegistry, idbRegistryStore, type Registry, type WalletRecord } from './registry';
import { createFakeEngine, type FakeEngine } from './engine/fake';
import { createWalletApp, type WalletApp } from './app';
import { DEFAULT_ENDPOINTS } from './policy';
import { createVault, idbVaultStore, type Vault } from './vault';

const FUNDED_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const AUTO_LOCK_MS = 10 * 60 * 1000;

const row = (over: Partial<WalletRecord> & Pick<WalletRecord, 'id'>): WalletRecord => ({
  network: 'testnet',
  name: 'wallet',
  fingerprint: 'abcd',
  kind: 'seed',
  lastUsed: 1,
  ...over,
});

let engine: FakeEngine;
let registry: Registry;
let vault: Vault;
let app: WalletApp;
let nowMs: number;

// Node has no Web Storage; the mirror lives in sessionStorage and the Lock
// flag in localStorage, so both get Map-backed shims (same pattern as the
// boot test's reload cases).
const shimStorage = (): Map<string, string> => {
  const mem = new Map<string, string>();
  const value = {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, v: string) => {
      mem.set(key, v);
    },
    removeItem: (key: string) => {
      mem.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'sessionStorage', { value, writable: true, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value, writable: true, configurable: true });
  return mem;
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), writable: true, configurable: true });
  shimStorage();
  registry = createRegistry(idbRegistryStore());
  vault = createVault(idbVaultStore());
  engine = createFakeEngine();
  nowMs = 1_000_000;
  // fake-indexeddb schedules its callbacks with setImmediate; faking it would
  // deadlock every registry/vault op. Fake only what the session model reads:
  // Date (deadlines) and the auto-Lock setInterval.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(nowMs);
  app = createWalletApp({
    engine: engine.engine,
    registry,
    vault,
    endpoints: DEFAULT_ENDPOINTS,
    requestPersist: async () => true,
  });
  app.network.set('testnet');
});

afterEach(() => {
  vi.useRealTimers();
});

const createRemember = async (passphrase: string): Promise<string> => {
  const created = await app.onCreate.generate();
  const res = await app.onCreate.confirmBackup(created.phrase, { remember: true, vaultPassphrase: passphrase });
  if (!res.ok) throw new Error(`create failed: ${res.code} ${res.message}`);
  return created.phrase;
};

describe('deadline + flag matrix (acceptance #1)', () => {
  it('reload within the idle deadline → still unlocked (mirror resurrects, no passphrase)', async () => {
    await createRemember('vaultpw');
    const before = engine.lastWallet();
    expect(app.unlocked.get()).toBe(true);
    // Simulate reload: keep sessionStorage mirror, drop in-memory wallet.
    before.closed = true;
    engine.queueWallet({ accounts: [{ id: 'acct-1' }] });
    await app.boot();
    expect(app.unlocked.get()).toBe(true);
    expect(engine.lastWallet().calls).toContain('attachSigner');
  });

  it('Lock → reload → locked despite the mirror still being present', async () => {
    await createRemember('vaultpw');
    const before = engine.lastWallet();
    const account = (await before.accounts())[0]!;
    await app.lock();
    expect(app.unlocked.get()).toBe(false);
    expect(before.detachArgs).toEqual([{ accountId: account.id }]);
    expect(globalThis.sessionStorage?.getItem('yaw-seed-mirror')).toBeNull();
    expect(globalThis.localStorage?.getItem('yaw-lock')).toBe('1');
    engine.queueWallet({ accounts: [{ id: 'acct-1' }] });
    await app.boot();
    expect(app.unlocked.get()).toBe(false);
    expect(engine.lastWallet().attachArgs).toHaveLength(0);
  });

  it('deadline faked past → passphrase re-prompted though the mirror was present', async () => {
    await createRemember('vaultpw');
    expect(app.unlocked.get()).toBe(true);
    // Date is the faked clock: advancing timers advances Date with it.
    await vi.advanceTimersByTimeAsync(AUTO_LOCK_MS + 1);
    expect(app.unlocked.get()).toBe(false);
    expect(globalThis.sessionStorage?.getItem('yaw-seed-mirror')).toBeNull();
  });

  it('a fresh boot with a mirror whose deadline already passed → locked', async () => {
    await createRemember('vaultpw');
    const id = (await registry.list('testnet'))[0]!.id;
    globalThis.sessionStorage!.setItem('yaw-seed-mirror', JSON.stringify({ id, phrase: 'stale', deadline: nowMs - 1 }));
    engine.queueWallet({ accounts: [{ id: 'acct-1' }] });
    await app.boot();
    expect(app.unlocked.get()).toBe(false);
    expect(engine.lastWallet().attachArgs).toHaveLength(0);
    // An expired mirror is stale plaintext: boot must remove it, not just
    // ignore it (the zeroization-on-Lock invariant, applied at boot).
    expect(globalThis.sessionStorage?.getItem('yaw-seed-mirror')).toBeNull();
  });

  it('a mirror for a different wallet id is ignored on boot', async () => {
    await createRemember('vaultpw');
    const id = (await registry.list('testnet'))[0]!.id;
    globalThis.sessionStorage!.setItem('yaw-seed-mirror', JSON.stringify({ id: 'not-' + id, phrase: FUNDED_PHRASE, deadline: nowMs + AUTO_LOCK_MS }));
    engine.queueWallet({ accounts: [{ id: 'acct-1' }] });
    await app.boot();
    expect(app.unlocked.get()).toBe(false);
  });
});

describe('unlock with passphrase (acceptance #3)', () => {
  it('a correct passphrase unlocks: vault decrypts, signer attaches, mirror persists', async () => {
    const phrase = await createRemember('vaultpw');
    await app.lock();
    expect(app.unlocked.get()).toBe(false);
    const res = await app.unlock('vaultpw');
    expect(res.ok).toBe(true);
    expect(app.unlocked.get()).toBe(true);
    // The create already attached once; the unlock attach is the newest one.
    const fed = engine.lastWallet().attachArgs.at(-1)!.mnemonic;
    expect(new TextDecoder().decode(fed)).toBe(phrase);
    const mirror = JSON.parse(globalThis.sessionStorage!.getItem('yaw-seed-mirror')!);
    expect(mirror.deadline).toBeGreaterThan(nowMs);
  });

  it('a wrong passphrase fails (viewing-key verification), no new signer attach', async () => {
    await createRemember('vaultpw');
    await app.lock();
    const attachesBefore = engine.lastWallet().attachArgs.length;
    const res = await app.unlock('wrongpw');
    expect(res).toMatchObject({ ok: false, code: 'WRONG_PASSPHRASE' });
    expect(app.unlocked.get()).toBe(false);
    expect(engine.lastWallet().attachArgs).toHaveLength(attachesBefore);
  });

  it('unlock on a Never-store wallet: no vault entry → NOT_FOUND, phrase path required', async () => {
    const created = await app.onCreate.generate();
    const res = await app.onCreate.confirmBackup(created.phrase, { remember: false });
    expect(res.ok).toBe(true);
    expect(await vault.has((await registry.list('testnet'))[0]!.id)).toBe(false);
    await app.lock();
    const unlockRes = await app.unlock('anything');
    expect(unlockRes).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('a valid phrase from a different wallet fails viewing-key verification (Never-store unlock)', async () => {
    // FUNDED_PHRASE is a valid BIP39 mnemonic but not THIS wallet's phrase:
    // the fake models the SDK's check of the restored key against the stored
    // viewing key, so a foreign-but-valid phrase must be rejected.
    const created = await app.onCreate.generate();
    await app.onCreate.confirmBackup(created.phrase, { remember: false });
    await app.lock();
    const res = await app.unlockWithPhrase(FUNDED_PHRASE);
    expect(res.ok).toBe(false);
    expect(app.unlocked.get()).toBe(false);
  });

  it('a wrong-but-valid phrase inside the envelope fails viewing-key verification (Remember unlock)', async () => {
    await createRemember('vaultpw');
    const id = (await registry.list('testnet'))[0]!.id;
    // Simulate an envelope holding a valid phrase for a different wallet:
    // decryption succeeds, so only the viewing-key check can stop it.
    await vault.store(id, FUNDED_PHRASE, 'vaultpw');
    await app.lock();
    const res = await app.unlock('vaultpw');
    expect(res.ok).toBe(false);
    expect(app.unlocked.get()).toBe(false);
    expect(globalThis.sessionStorage?.getItem('yaw-seed-mirror')).toBeNull();
  });
});

describe('zeroization on Lock (acceptance #3)', () => {
  it('Lock zeroizes the mirror phrase and detaches the signer', async () => {
    const phrase = await createRemember('vaultpw');
    const before = engine.lastWallet();
    const account = (await before.accounts())[0]!;
    const mirrorBefore = JSON.parse(globalThis.sessionStorage!.getItem('yaw-seed-mirror')!) as { phrase: string };
    expect(mirrorBefore.phrase).toBe(phrase);
    await app.lock();
    expect(globalThis.sessionStorage?.getItem('yaw-seed-mirror')).toBeNull();
    expect(before.detachArgs).toEqual([{ accountId: account.id }]);
    expect(app.unlocked.get()).toBe(false);
  });
});

describe('auto-lock accounting (acceptance #4)', () => {
  it('10 min of inactivity auto-locks; the countdown chip reflects the deadline', async () => {
    await createRemember('vaultpw');
    expect(app.unlocked.get()).toBe(true);
    expect(app.autoLockInMs.get()).toBeLessThanOrEqual(AUTO_LOCK_MS);
    // 5 min in, no activity: still unlocked, countdown advanced.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(app.unlocked.get()).toBe(true);
    // 10 min + 1 ms total: auto-lock fires.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(app.unlocked.get()).toBe(false);
  });

  it('a send attempt resets the idle deadline (counts as activity)', async () => {
    await createRemember('vaultpw');
    // 9 min in: near the deadline.
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(app.unlocked.get()).toBe(true);
    // A send attempt at 9 min resets the deadline to now+10min.
    app.onSend.open();
    app.onSend.setRecipient('ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez');
    app.onSend.setAmount('1');
    await app.onSend.review();
    const after = app.autoLockInMs.get();
    expect(after).toBeGreaterThan(AUTO_LOCK_MS - 60 * 1000); // close to a full 10 min again
    // 9 more min (18 total) past the original deadline but within the new one: still unlocked.
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(app.unlocked.get()).toBe(true);
  });

  it('a send attempt persists the extended deadline: reload past the old one stays unlocked', async () => {
    // The boot-time lifetime rule reads the PERSISTED deadline, so activity
    // must rewrite the mirror — otherwise a reload at 10 min locks a session
    // the 9-min send attempt legally extended to minute 19.
    await createRemember('vaultpw');
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    app.onSend.open();
    app.onSend.setRecipient('ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez');
    app.onSend.setAmount('1');
    await app.onSend.review();
    const mirror = JSON.parse(globalThis.sessionStorage!.getItem('yaw-seed-mirror')!) as { deadline: number };
    expect(mirror.deadline).toBeGreaterThan(nowMs + AUTO_LOCK_MS);
    // Reload at 10 min: past the original deadline, inside the persisted one.
    engine.lastWallet().closed = true;
    await vi.advanceTimersByTimeAsync(60_001);
    engine.queueWallet({ accounts: [{ id: 'acct-1' }] });
    await app.boot();
    expect(app.unlocked.get()).toBe(true);
  });

  it('watching sync does NOT reset the idle deadline', async () => {
    await createRemember('vaultpw');
    const deadlineBefore = app.unlockDeadline.get();
    // Push a sync tick (watchSync publishes).
    engine.lastWallet().pushSync({ activity: 'running', scanned: 1, target: 100, targetReached: false, scanComplete: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(app.unlockDeadline.get()).toBe(deadlineBefore);
  });
});

describe('app-wide Lock propagation (acceptance #2)', () => {
  it('Lock removes spend authority; viewing continues (balances + address still render)', async () => {
    await createRemember('vaultpw');
    const info = app.walletInfo.get();
    expect(info?.kind).toBe('seed');
    await app.lock();
    expect(app.unlocked.get()).toBe(false);
    expect(app.canSpend.get()).toBe(false);
    // Viewing continues: balances, address, sync still on screen.
    expect(app.screen.get()).toBe('wallet');
    expect(app.balances.get()).not.toBeNull();
    expect(app.address.get()).not.toBeNull();
    // A send attempt is refused at the capability gate.
    expect(app.guardSpend()).toMatchObject({ ok: false });
  });

  it('Lock then setNetwork then boot: the other network is also locked', async () => {
    await createRemember('vaultpw');
    await registry.add(row({ id: 'other', network: 'mainnet' }));
    await app.lock();
    app.network.set('mainnet');
    engine.queueWallet({ accounts: [{ id: 'acct-m' }] });
    await app.boot();
    expect(app.unlocked.get()).toBe(false);
    expect(app.canSpend.get()).toBe(false);
  });
});

describe('custody choice survives a reload mid-create', () => {
  it('resuming a Remember pending seed stores the envelope and unlocks', async () => {
    // A create that died before the account landed leaves the phrase in
    // sessionStorage. The custody choice rides with it, so the resume still
    // encrypts the envelope and attaches the signer — never silently
    // degrades to Never-store.
    await registry.add(row({ id: 'pend', fingerprint: '', lastUsed: 9 }));
    globalThis.sessionStorage!.setItem(
      'yaw-pending-seed',
      JSON.stringify({ id: 'pend', phrase: FUNDED_PHRASE, remember: true, vaultPassphrase: 'vaultpw' }),
    );
    engine.queueWallet({ accounts: [] });
    await app.boot({ restoreLatest: true });
    expect((await registry.get('pend'))?.fingerprint).toMatch(/^[a-z2-7]{4}$/);
    expect(await vault.has('pend')).toBe(true);
    expect(app.unlocked.get()).toBe(true);
  });
});
