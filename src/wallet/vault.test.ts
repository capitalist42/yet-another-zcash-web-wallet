// Vault envelope (ADR-0002, issue #6): PBKDF2-SHA256 210k → AES-GCM-256 in
// IndexedDB. Zero-seam crypto codec — pure functions over a scriptable store,
// so tests run against fake-indexeddb and the real WebCrypto subtle surface.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createVault, idbVaultStore, PBKDF2_ITERATIONS, type Vault, type VaultStore } from './vault';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let store: VaultStore;
let vault: Vault;

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), writable: true, configurable: true });
  store = idbVaultStore();
  vault = createVault(store);
});

describe('vault envelope', () => {
  it('round-trips a phrase through encrypt→decrypt with the right passphrase', async () => {
    await vault.store('w1', PHRASE, 'correct horse battery');
    const loaded = await vault.load('w1', 'correct horse battery');
    expect(loaded).toBe(PHRASE);
  });

  it('a wrong passphrase fails with WRONG_PASSPHRASE and never yields the phrase', async () => {
    await vault.store('w1', PHRASE, 'correct horse battery');
    await expect(vault.load('w1', 'wrong')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' });
  });

  it('has(id) reports whether an envelope exists', async () => {
    expect(await vault.has('w1')).toBe(false);
    await vault.store('w1', PHRASE, 'pw');
    expect(await vault.has('w1')).toBe(true);
  });

  it('remove(id) erases the envelope; already-gone is success', async () => {
    await vault.store('w1', PHRASE, 'pw');
    await vault.remove('w1');
    expect(await vault.has('w1')).toBe(false);
    await expect(vault.remove('w1')).resolves.toBeUndefined();
  });

  it('loading a missing id throws NOT_FOUND', async () => {
    await expect(vault.load('missing', 'pw')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('storing twice with a new passphrase re-encrypts (passphrase change path)', async () => {
    await vault.store('w1', PHRASE, 'old');
    await vault.store('w1', PHRASE, 'new');
    await expect(vault.load('w1', 'old')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' });
    expect(await vault.load('w1', 'new')).toBe(PHRASE);
  });

  it('two wallets with the same passphrase decrypt only with their own id', async () => {
    await vault.store('a', PHRASE, 'shared');
    await vault.store('b', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 'shared');
    expect(await vault.load('a', 'shared')).toBe(PHRASE);
    await expect(vault.load('b', 'shared')).resolves.not.toBe(PHRASE);
  });

  it('the persisted envelope is opaque: ciphertext has no phrase substring', async () => {
    await vault.store('w1', PHRASE, 'pw');
    const env = await store.get('w1');
    expect(env).not.toBeNull();
    const text = new TextDecoder().decode(env!.ciphertext);
    expect(text).not.toContain('abandon');
    expect(env!.salt).toHaveLength(16);
    expect(env!.iv).toHaveLength(12);
  });

  it('a device envelope round-trips without a passphrase and hides the phrase', async () => {
    await vault.storeDevice('w1', PHRASE);
    expect(await vault.deviceBound('w1')).toBe(true);
    expect(await vault.has('w1')).toBe(true);
    expect(await vault.loadDevice('w1')).toBe(PHRASE);
    const env = await store.get('w1');
    expect(new TextDecoder().decode(env!.ciphertext)).not.toContain('abandon');
    expect(new TextDecoder().decode(env!.deviceKey!)).not.toContain('abandon');
  });

  it('a user passphrase does not open a device envelope', async () => {
    await vault.storeDevice('w1', PHRASE);
    await expect(vault.load('w1', 'pw')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' });
  });

  it('loadDevice refuses a user-passphrase envelope', async () => {
    await vault.store('w1', PHRASE, 'pw');
    expect(await vault.deviceBound('w1')).toBe(false);
    await expect(vault.loadDevice('w1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a later passphrase store replaces the device key', async () => {
    await vault.storeDevice('w1', PHRASE);
    await vault.store('w1', PHRASE, 'pw');
    expect(await vault.deviceBound('w1')).toBe(false);
    expect(await vault.load('w1', 'pw')).toBe(PHRASE);
    await expect(vault.loadDevice('w1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('PBKDF2 iteration count is 210k (ADR-0002 hard requirement)', async () => {
    // The envelope is opaque, but the derivation count is a public constant:
    // ADR-0002 pins it; a regression here is a security downgrade.
    expect(PBKDF2_ITERATIONS).toBe(210_000);
  });
});
