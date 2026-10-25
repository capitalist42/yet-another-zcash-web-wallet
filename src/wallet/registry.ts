// App-side Wallet registry in IndexedDB (ADR-0003): many Wallets per Network,
// one open per Network, last-used drives startup. SDK-side OPFS state is not
// listed here; the registry row is the app's index into it.
export type WalletKind = 'seed' | 'viewonly';

export interface WalletRecord {
  readonly id: string;
  readonly network: 'mainnet' | 'testnet';
  readonly name: string;
  /** 4-char id derived from the UFVK; shown everywhere (issue #3). */
  readonly fingerprint: string;
  readonly kind: WalletKind;
  /** Epoch ms of last open; drives "reopen last-used per Network". */
  readonly lastUsed: number;
}

/** Minimal KV surface so tests run against fake-indexeddb. */
export interface RegistryStore {
  getAll(): Promise<WalletRecord[]>;
  put(record: WalletRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface Registry {
  add(record: WalletRecord): Promise<WalletRecord>;
  touch(id: string): Promise<void>;
  /** Latest-opened for one network. */
  lastUsed(network: WalletRecord['network']): Promise<WalletRecord | null>;
  /** Latest-opened wallet on any network. Null when the registry is empty. */
  mostRecent(): Promise<WalletRecord | null>;
  list(network: WalletRecord['network']): Promise<WalletRecord[]>;
  get(id: string): Promise<WalletRecord | null>;
  remove(id: string): Promise<void>;
}

export const createRegistry = (store: RegistryStore): Registry => ({
  async add(record) {
    await store.put(record);
    return record;
  },
  async touch(id) {
    const all = await store.getAll();
    const rec = all.find((r) => r.id === id);
    if (rec !== undefined) await store.put({ ...rec, lastUsed: Date.now() });
  },
  async lastUsed(network) {
    const all = await store.getAll();
    const rows = all
      .filter((r) => r.network === network)
      .sort((a, b) => b.lastUsed - a.lastUsed);
    return rows[0] ?? null;
  },
  async mostRecent() {
    const all = await store.getAll();
    return all.sort((a, b) => b.lastUsed - a.lastUsed)[0] ?? null;
  },
  async list(network) {
    const all = await store.getAll();
    return all.filter((r) => r.network === network).sort((a, b) => b.lastUsed - a.lastUsed);
  },
  async get(id) {
    const all = await store.getAll();
    return all.find((r) => r.id === id) ?? null;
  },
  async remove(id) {
    await store.remove(id);
  },
});

// --- IndexedDB-backed RegistryStore -----------------------------------------

const DB_NAME = 'yaw-registry';
const STORE = 'wallets';

export const idbRegistryStore = (): RegistryStore => {
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
    getAll: () => run<WalletRecord[]>('readonly', (store) => store.getAll() as IDBRequest<WalletRecord[]>),
    put: (record) => run('readwrite', (store) => store.put(record)).then(() => undefined),
    remove: (id) => run('readwrite', (store) => store.delete(id)).then(() => undefined),
  };
};
