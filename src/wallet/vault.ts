// App-level seed Vault (ADR-0002): PBKDF2-SHA256 (210k, random salt) → AES-GCM-256
// envelope in IndexedDB, user-chosen passphrase. The SDK's own OPFS store is
// plaintext at rest but holds no spend authority; this envelope is the only
// place a seed touches disk. "Never store" wallets simply have no envelope.
//
// Security boundary (ADR-0002): the Vault guards the seed AT REST on a device,
// not the unlocked session — once unlocked, the page is the boundary. The
// decrypted mirror lives in sessionStorage with an idle deadline (app.ts);
// this module never holds the plaintext outside load().

/** ADR-0002 hard requirement: 210k PBKDF2-SHA256 iterations. */
export const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32; // AES-GCM-256

export type VaultErrorCode = 'NOT_FOUND' | 'WRONG_PASSPHRASE' | 'UNKNOWN';

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** Opaque envelope persisted in IndexedDB. Bytes only — no plaintext fields.
 * `Uint8Array<ArrayBuffer>` because WebCrypto's BufferSource demands it. */
export interface VaultEnvelope {
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: Uint8Array<ArrayBuffer>;
}

/** Minimal KV surface so tests run against fake-indexeddb. */
export interface VaultStore {
  get(id: string): Promise<VaultEnvelope | null>;
  put(id: string, env: VaultEnvelope): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface Vault {
  /** Encrypt `phrase` under `passphrase` and persist for wallet `id`. Re-store
   * overwrites (passphrase change path). */
  store(id: string, phrase: string, passphrase: string): Promise<void>;
  /** Decrypt the envelope for `id`; returns the phrase or throws
   * WRONG_PASSPHRASE / NOT_FOUND. The caller zeroizes the scratch bytes it
   * passes to attachSigner, but the returned string itself is immutable —
   * JS cannot zeroize it, so plaintext lingers in the heap until GC
   * (ADR-0002's stated honesty limit: process isolation is not a boundary). */
  load(id: string, passphrase: string): Promise<string>;
  has(id: string): Promise<boolean>;
  remove(id: string): Promise<void>;
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto?.subtle;
  if (c === undefined) throw new VaultError('UNKNOWN', 'WebCrypto subtle unavailable');
  return c;
};

const deriveKey = async (passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
  const keyMaterial = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    ['encrypt', 'decrypt'],
  );
};

export const createVault = (envelopeStore: VaultStore): Vault => ({
  async store(id, phrase, passphrase) {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveKey(passphrase, salt);
    const ciphertext = await subtle().encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(phrase),
    );
    await envelopeStore.put(id, { salt, iv, ciphertext: new Uint8Array(ciphertext) });
  },
  async load(id, passphrase) {
    const env = await envelopeStore.get(id);
    if (env === null) throw new VaultError('NOT_FOUND', `no vault entry for ${id}`);
    const key = await deriveKey(passphrase, env.salt);
    try {
      const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.ciphertext);
      return new TextDecoder().decode(plaintext);
    } catch {
      // AES-GCM authentication tag mismatch is the only failure mode here,
      // and it means the passphrase was wrong (or the envelope was corrupted,
      // which is indistinguishable and equally refuses to yield the seed).
      throw new VaultError('WRONG_PASSPHRASE', 'passphrase did not verify');
    }
  },
  async has(id) {
    return (await envelopeStore.get(id)) !== null;
  },
  async remove(id) {
    await envelopeStore.remove(id);
  },
});

// --- IndexedDB-backed VaultStore --------------------------------------------

const DB_NAME = 'yaw-vault';
const STORE = 'envelopes';

const toStorable = (env: VaultEnvelope): Record<string, Uint8Array<ArrayBuffer>> => ({
  salt: env.salt,
  iv: env.iv,
  ciphertext: env.ciphertext,
});

// IndexedDB structured-clone hands back views over a plain ArrayBuffer.
const fromStorable = (row: Record<string, Uint8Array<ArrayBuffer>>): VaultEnvelope => ({
  salt: row.salt,
  iv: row.iv,
  ciphertext: row.ciphertext,
});

export const idbVaultStore = (): VaultStore => {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (dbp === null) {
      const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbp = null; // don't cache the rejection: the next call retries the open
        reject(req.error);
      };
      dbp = promise;
    }
    return dbp;
  };
  const run = <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    db().then((d) => {
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      const req = op(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      return promise;
    });
  return {
    // A miss resolves `undefined` in both real IndexedDB and fake-indexeddb.
    get: (id) =>
      run<Record<string, Uint8Array<ArrayBuffer>> | undefined>('readonly', (store) => store.get(id) as IDBRequest<Record<string, Uint8Array<ArrayBuffer>> | undefined>).then((row) => (row === undefined || row === null ? null : fromStorable(row))),
    put: (id, env) => run('readwrite', (store) => store.put({ id, ...toStorable(env) })).then(() => undefined),
    remove: (id) => run('readwrite', (store) => store.delete(id)).then(() => undefined),
  };
};
