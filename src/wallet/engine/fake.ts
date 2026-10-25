// Scriptable fake implementing the engine port. All behavioral tests run on
// this: controllable open/recovery, sync streams, operations, accounts.
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type {
  Engine,
  EngineAccount,
  EngineBalance,
  EngineBirthday,
  EngineBirthdayHandle,
  EngineErrorCode,
  EngineHistoryEntry,
  EngineOperation,
  EngineRecoveryReport,
  EngineSeedAccount,
  EngineSyncStatus,
  EngineWallet,
  OpenSpec,
} from './port';
import { EngineError } from './port';

export interface FakeAccountSpec {
  id: string;
  name?: string | null;
  viewOnly?: boolean;
  /** Reload truth: a seed account reopens viewOnly:false, signerAttached:false. */
  signerAttached?: boolean;
  birthdayHeight?: number;
  accountIndex?: number | null;
  addresses?: string[];
  balance?: Partial<Omit<EngineBalance, 'accountId' | 'scanned'>>;
  history?: EngineHistoryEntry[];
}

export interface FakeWalletSpec {
  recovery?: Partial<EngineRecoveryReport>;
  accounts?: FakeAccountSpec[];
  operations?: EngineOperation[];
  /** Resolved only when the test calls `releaseOpen()` — models a slow endpoint. */
  holdOpen?: boolean;
  /** Fail this open call outright. */
  openError?: EngineErrorCode;
  /** Sync statuses startSync() pushes onto watchSync streams. */
  syncSteps?: EngineSyncStatus[];
  /** Throw SYNC_REQUIRED from the first N createSeed/importSeed calls
   * (models the SDK's stale-chain-state precondition). */
  createFailures?: number;
}

export interface FakeOpenRecord {
  spec: OpenSpec;
  wallet: FakeWallet;
}

let nextId = 1;

const defaultRecovery = (over?: Partial<EngineRecoveryReport>): EngineRecoveryReport => ({
  local: 'complete',
  operations: 0,
  observation: 'complete',
  observedOperations: 0,
  deferredOperations: 0,
  lastError: null,
  ...over,
});

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;
  constructor() {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.promise = promise;
    this.resolve = resolve;
  }
}

export class SyncWatcher {
  private readonly queue: EngineSyncStatus[] = [];
  private waiting: ((r: IteratorResult<EngineSyncStatus>) => void) | null = null;
  private closedFlag = false;
  push(status: EngineSyncStatus): void {
    if (this.closedFlag) return;
    if (this.waiting !== null) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: status, done: false });
    } else {
      this.queue.push(status);
    }
  }
  close(): void {
    this.closedFlag = true;
    if (this.waiting !== null) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }
  iterable(): AsyncIterable<EngineSyncStatus> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const queued = this.queue.shift();
          if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
          if (this.closedFlag) return Promise.resolve({ value: undefined as never, done: true });
          const { promise, resolve } = Promise.withResolvers<IteratorResult<EngineSyncStatus>>();
          this.waiting = resolve;
          return promise;
        },
        return: async () => {
          this.close();
          return { value: undefined as never, done: true as const };
        },
      }),
    };
  }
}

export class FakeWallet implements EngineWallet {
  readonly recovery: EngineRecoveryReport;
  closed = false;
  /** Method names in call order (boot-order assertions). */
  readonly calls: string[] = [];
  readonly watchers: SyncWatcher[] = [];
  readonly operations: EngineOperation[];
  private readonly specs = new Map<string, FakeAccountSpec>();
  private openGate: Deferred | null = null;
  private syncQueue: EngineSyncStatus[] = [];
  private createFails: number;

  constructor(spec: FakeWalletSpec) {
    this.recovery = defaultRecovery(spec.recovery);
    this.operations = [...(spec.operations ?? [])];
    this.syncQueue = [...(spec.syncSteps ?? [])];
    this.createFails = spec.createFailures ?? 0;
    if (spec.holdOpen === true) this.openGate = new Deferred();
    if (spec.openError !== undefined) {
      throw new EngineError(spec.openError, `open failed: ${spec.openError}`);
    }
    for (const a of spec.accounts ?? []) this.specs.set(a.id, { ...a });
  }

  /** Resolve a held open — models a slow startup recovery/endpoint. */
  releaseOpen(): void {
    this.openGate?.resolve();
    this.openGate = null;
  }

  addAccount(spec: FakeAccountSpec): void {
    this.specs.set(spec.id, { ...spec });
  }

  pushSync(status: EngineSyncStatus): void {
    this.lastStatus = status;
    for (const w of this.watchers) w.push(status);
  }

  setOperations(list: EngineOperation[]): void {
    this.operations.length = 0;
    this.operations.push(...list);
  }

  private check(method: string): void {
    this.calls.push(method);
    if (this.closed) throw new EngineError('UNKNOWN', `wallet closed (${method})`);
  }

  private need(id: string): FakeAccountSpec {
    const a = this.specs.get(id);
    if (a === undefined) throw new EngineError('INVALID_ARGUMENT', `no account ${id}`);
    return a;
  }

  private view(id: string): EngineAccount {
    const a = this.need(id);
    return {
      id,
      name: a.name ?? null,
      birthdayHeight: a.birthdayHeight ?? 1,
      accountIndex: a.accountIndex ?? null,
      viewOnly: a.viewOnly ?? false,
      // SDK truth (both create and reload): returned signers are UNATTACHED;
      // don't key locked UI on viewOnly (spike live finding). Specs opt in.
      signerAttached: a.signerAttached ?? false,
    };
  }

  async waitOpen(): Promise<void> {
    this.calls.push('open');
    if (this.openGate !== null) await this.openGate.promise;
  }

  async resolveBirthday(firstScanHeight: number): Promise<EngineBirthdayHandle> {
    this.check('resolveBirthday');
    return { kind: 'birthday', firstScanHeight };
  }

  async createSeed(args: { mnemonic: Uint8Array; name?: string }): Promise<EngineSeedAccount> {
    this.check('createSeed');
    this.freshnessGate();
    this.assertPhrase(args.mnemonic);
    return this.makeSeed(args.name ?? 'wallet', false, 0, 1);
  }

  async importSeed(args: {
    mnemonic: Uint8Array;
    passphrase?: Uint8Array;
    accountIndex: number;
    birthday: EngineBirthday;
    name?: string;
  }): Promise<EngineSeedAccount> {
    this.check('importSeed');
    this.freshnessGate();
    this.assertPhrase(args.mnemonic);
    const height = args.birthday === 'fullScan' ? 1 : args.birthday.firstScanHeight;
    return this.makeSeed(args.name ?? 'restored', false, args.accountIndex, height);
  }

  /** Models the SDK precondition: stale local chain state rejects account
   * mutation with SYNC_REQUIRED until a freshness pass lands. */
  private freshnessGate(): void {
    if (this.createFails > 0) {
      this.createFails -= 1;
      throw new EngineError('SYNC_REQUIRED', 'sync the wallet before continuing', true);
    }
  }

  private assertPhrase(mnemonic: Uint8Array): void {
    const phrase = new TextDecoder().decode(mnemonic);
    if (!validateMnemonic(phrase, wordlist)) throw new EngineError('INVALID_MNEMONIC', 'bad phrase');
  }

  private makeSeed(name: string, viewOnly: boolean, accountIndex: number | null, birthdayHeight: number): EngineSeedAccount {
    const id = `acct-${nextId++}`;
    this.specs.set(id, { id, name, viewOnly, accountIndex, birthdayHeight, addresses: [`u1fake${nextId}`] });
    return {
      account: this.view(id),
      ufvk: async () => `uview1${id}`,
      dispose: async () => undefined,
    };
  }
  async importViewing(args: {
    viewingKey: string;
    birthday: EngineBirthday;
    name?: string;
  }): Promise<EngineAccount> {
    this.check('importViewing');
    if (!/^(uview|testview|uivk|uivktest)[a-z0-9]+$/.test(args.viewingKey)) {
      throw new EngineError('INVALID_ARGUMENT', 'malformed viewing key');
    }
    const id = `acct-${nextId++}`;
    const height = args.birthday === 'fullScan' ? 1 : args.birthday.firstScanHeight;
    this.specs.set(id, {
      id,
      name: args.name ?? 'view-only',
      viewOnly: true,
      accountIndex: null,
      birthdayHeight: height,
      addresses: [`u1view${nextId}`],
    });
    return this.view(id);
  }

  async accounts(): Promise<EngineAccount[]> {
    this.check('accounts');
    return [...this.specs.keys()].map((id) => this.view(id));
  }

  async currentAddress(accountId: string): Promise<string | null> {
    this.check('currentAddress');
    const a = this.need(accountId);
    return a.addresses?.[0] ?? null;
  }

  async mintAddress(accountId: string): Promise<string> {
    this.check('mintAddress');
    const a = this.need(accountId);
    a.addresses = [...(a.addresses ?? []), `u1minted${(a.addresses?.length ?? 0) + 1}-${accountId}`];
    return a.addresses[a.addresses.length - 1] as string;
  }

  async getBalance(accountId: string): Promise<EngineBalance> {
    this.check('getBalance');
    const a = this.need(accountId);
    return {
      accountId,
      transparent: a.balance?.transparent ?? null,
      sapling: a.balance?.sapling ?? null,
      ironwood: a.balance?.ironwood ?? null,
      scanned: a.balance !== undefined,
    };
  }

  async getHistory(accountId: string, limit = 20): Promise<readonly EngineHistoryEntry[]> {
    this.check('getHistory');
    return (this.need(accountId).history ?? []).slice(0, limit);
  }

  watchSync(): AsyncIterable<EngineSyncStatus> {
    this.calls.push('watchSync');
    const w = new SyncWatcher();
    this.watchers.push(w);
    return w.iterable();
  }

  async startSync(): Promise<void> {
    this.check('startSync');
    for (const status of this.syncQueue) this.pushSync(status);
  }

  /** Scriptable mid-scan snapshots: `polled` drains first, else the last
   * status any watcher saw — a real getSyncStatus always answers. */
  polled: EngineSyncStatus[] = [];
  private lastStatus: EngineSyncStatus | null = null;
  async syncStatus(): Promise<EngineSyncStatus> {
    this.check('syncStatus');
    const next = this.polled.shift();
    if (next !== undefined) return next;
    if (this.lastStatus !== null) return this.lastStatus;
    throw new EngineError('UNKNOWN', 'no sync status available yet');
  }

  async syncFresh(_timeoutMs: number): Promise<void> {
    this.check('syncFresh');
    // the scripted freshnessGate() decides whether mutation still rejects
  }

  async listOperations(): Promise<readonly EngineOperation[]> {
    this.check('listOperations');
    return [...this.operations];
  }

  async close(): Promise<void> {
    this.calls.push('close');
    this.closed = true;
    for (const w of this.watchers) w.close();
  }
}

export interface FakeEngine {
  engine: Engine;
  readonly opens: FakeOpenRecord[];
  /** OPFS names passed to removeStorage, in call order. */
  readonly removedStorage: string[];
  /** Next removeStorage rejects with STORAGE_BUSY (held-lease simulation). */
  failNextRemove(): void;
  /** Queue the spec for the NEXT open (before it is attempted). */
  queueWallet(spec: FakeWalletSpec): void;
  /** Resolved once the NEXT open call has begun (wallet instance live). */
  openStarted(): Promise<void>;
  /** The wallet whose open is currently in flight. */
  pending(): FakeWallet;
  /** The most recent fully opened wallet. */
  lastWallet(): FakeWallet;
}

/**
 * Scriptable engine. `pending()` exposes the wallet instance while its open
 * is still in flight (e.g. recovery gate held), so tests can drive it.
 */
export const createFakeEngine = (defaults: FakeWalletSpec = {}): FakeEngine => {
  const opens: FakeOpenRecord[] = [];
  const removedStorage: string[] = [];
  const queued: FakeWalletSpec[] = [];
  const pendingList: FakeWallet[] = [];
  let removeFails = 0;
  let openStartGate = Promise.withResolvers<void>();
  return {
    engine: {
      async open(spec: OpenSpec): Promise<EngineWallet> {
        openStartGate.resolve();
        openStartGate = Promise.withResolvers();
        const wallet = new FakeWallet(queued.shift() ?? defaults);
        pendingList.push(wallet);
        await wallet.waitOpen();
        pendingList.pop();
        opens.push({ spec, wallet });
        return wallet;
      },
      async removeStorage(storageName: string): Promise<void> {
        if (removeFails > 0) {
          removeFails -= 1;
          throw new EngineError('STORAGE_BUSY', 'storage busy', true);
        }
        removedStorage.push(storageName);
      },
    },
    opens,
    removedStorage,
    failNextRemove: () => {
      removeFails += 1;
    },
    queueWallet: (spec: FakeWalletSpec) => {
      queued.push(spec);
    },
    openStarted: () => openStartGate.promise,
    pending: () => {
      const w = pendingList[pendingList.length - 1];
      if (w === undefined) throw new Error('no pending open');
      return w;
    },
    lastWallet: () => {
      const last = opens[opens.length - 1];
      if (last === undefined) throw new Error('no opens yet');
      return last.wallet;
    },
  };
};



