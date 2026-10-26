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
  EngineNote,
  EngineOperation,
  EngineProposal,
  EngineProposeArgs,
  EngineRecovery,
  EngineRecoveryReport,
  EngineSeedAccount,
  EngineSendResult,
  EngineShieldArgs,
  EngineSyncStatus,
  EngineTransactionOutput,
  EngineTransparentUtxo,
  EngineWallet,
  OpenSpec,
} from './port';
import { EngineError } from './port';

export interface ScriptedFailure {
  readonly code: EngineErrorCode;
  readonly recovery: EngineRecovery;
  readonly message?: string;
}

export interface FakeAccountSpec {
  id: string;
  name?: string | null;
  viewOnly?: boolean;
  /** Reload truth: a seed account reopens viewOnly:false, signerAttached:false. */
  signerAttached?: boolean;
  birthdayHeight?: number;
  accountIndex?: number | null;
  addresses?: string[];
  /** SDK-model: the seed phrase this account was created/imported with, so
   * attachSigner can reject a mismatched phrase like the real viewing-key
   * check (issue #6). Absent for accounts injected via queueWallet. */
  phrase?: string;
  balance?: Partial<Omit<EngineBalance, 'accountId' | 'scanned'>>;
  history?: EngineHistoryEntry[];
  /** txid → outputs, for ADR-0004 receipt classification. `addTransaction`
   * scripts one mid-session (a sync tick then sees it in `history`). */
  transactions?: Record<string, EngineTransactionOutput[]>;
  /** Unspent transparent outputs for the Shield screen (issue #8); the app
   * groups these by address for its checkbox list. Optional identity fields
   * feed the note browser; Shield only reads address and value. */
  utxos?: {
    address: string;
    value: bigint;
    txid?: string;
    outputIndex?: number;
    spendState?: EngineNote['spendState'];
    locked?: boolean;
  }[];
  /** Shielded notes for the note browser and send-selection checks (issue #9). */
  notes?: {
    pool: 'sapling' | 'ironwood';
    txid: string;
    outputIndex: number;
    value: bigint;
    spendState?: EngineNote['spendState'];
    locked?: boolean;
  }[];
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
  readonly proposeArgs: EngineProposeArgs[] = [];
  readonly proposeShieldArgs: EngineShieldArgs[] = [];
  readonly sentProposalIds: string[] = [];
  readonly abandoned: string[] = [];
  readonly attachArgs: { accountId: string; mnemonic: Uint8Array }[] = [];
  readonly detachArgs: { accountId: string }[] = [];
  private readonly specs = new Map<string, FakeAccountSpec>();
  private readonly proposalQueue: { proposal: EngineProposal; txid: string | null }[] = [];
  private readonly proposeFails: ScriptedFailure[] = [];
  private readonly proposeShieldFails: ScriptedFailure[] = [];
  private readonly sendFails: ScriptedFailure[] = [];
  /** proposalId → txid returned by a successful send of that exact proposal. */
  private readonly heldTxids = new Map<string, string | null>();
  /** Shield proposals awaiting accept: which utxos a successful send of
   * that exact proposal consumes (issue #8 balance/utxo bookkeeping). */
  private readonly shieldProposals = new Map<string, { accountId: string; utxos: EngineTransparentUtxo[]; fee: bigint }>();
  /** When set, abandon() records the release only after releaseAbandon(). */
  private abandonGate: Promise<void> = Promise.resolve();
  private letAbandon: (() => void) | null = null;
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

  /** Script the account's unspent transparent outputs (Shield screen,
   * issue #8). */
  setUtxos(accountId: string, utxos: NonNullable<FakeAccountSpec['utxos']>): void {
    this.need(accountId).utxos = utxos.map((u) => ({ ...u }));
  }

  /** Script shielded notes (issue #9). */
  setNotes(accountId: string, notes: NonNullable<FakeAccountSpec['notes']>): void {
    this.need(accountId).notes = notes.map((n) => ({ ...n }));
  }

  pushSync(status: EngineSyncStatus): void {
    this.lastStatus = status;
    for (const w of this.watchers) w.push(status);
  }

  setOperations(list: EngineOperation[]): void {
    this.operations.length = 0;
    this.operations.push(...list);
  }

  /** Next propose() returns this plan. `txid` is what a later send of it reports. */
  queueProposal(proposal: EngineProposal, txid: string | null = null): void {
    this.proposalQueue.push({ proposal, txid });
  }

  failNextPropose(failure: ScriptedFailure): void {
    this.proposeFails.push(failure);
  }

  failNextProposeShield(failure: ScriptedFailure): void {
    this.proposeShieldFails.push(failure);
  }

  failNextSend(failure: ScriptedFailure): void {
    this.sendFails.push(failure);
  }

  /** Pause abandon() so a test can see that the next review waits for it. */
  holdAbandon(): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.abandonGate = promise;
    this.letAbandon = resolve;
  }

  releaseAbandon(): void {
    this.letAbandon?.();
    this.letAbandon = null;
    this.abandonGate = Promise.resolve();
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
    const acct = this.makeSeed(args.name ?? 'wallet', false, 0, 1);
    // Model the SDK: the account remembers its seed phrase, so attachSigner
    // can reject a mismatched one like the real viewing-key check does (#6).
    this.specs.get(acct.account.id)!.phrase = new TextDecoder().decode(args.mnemonic);
    return acct;
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
    const acct = this.makeSeed(args.name ?? 'restored', false, args.accountIndex, height);
    this.specs.get(acct.account.id)!.phrase = new TextDecoder().decode(args.mnemonic);
    return acct;
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
    // SDK-model: addresses.next() ADVANCES current, so current() reads the
    // most recently minted address (last), not the first.
    const list = a.addresses ?? [];
    return list.length === 0 ? null : (list[list.length - 1] as string);
  }

  async mintAddress(accountId: string): Promise<string> {
    this.check('mintAddress');
    const a = this.need(accountId);
    a.addresses = [...(a.addresses ?? []), `u1minted${(a.addresses?.length ?? 0) + 1}-${accountId}`];
    return a.addresses[a.addresses.length - 1] as string;
  }

  async listAddresses(accountId: string): Promise<readonly string[]> {
    this.check('listAddresses');
    return [...(this.need(accountId).addresses ?? [])];
  }

  /** txids whose wallet transaction is not readable yet: outputs answer as
   * a single null placeholder (models the SDK's getTransaction lag behind a
   * fresh block) until `resolveTransactions` enhances them. */
  readonly pendingTxs = new Set<string>();

  async listTransactionOutputs(txid: string): Promise<readonly EngineTransactionOutput[]> {
    this.check('listTransactionOutputs');
    if (this.pendingTxs.has(txid)) {
      return [{ address: null, value: null, isChange: null, sentFromThisWallet: false }];
    }
    for (const a of this.specs.values()) {
      const outs = a.transactions?.[txid];
      if (outs !== undefined) return [...outs];
    }
    return [];
  }

  /** Enhancement finished: what `addTransaction` recorded becomes readable. */
  resolveTransactions(txid: string): void {
    this.pendingTxs.delete(txid);
  }

  /** Script a transaction landing on this account: the next getHistory and
   * listTransactionOutputs calls see it (models a sync-discovered transfer). */
  addTransaction(accountId: string, entry: EngineHistoryEntry, outputs: EngineTransactionOutput[]): void {
    const a = this.need(accountId);
    a.history = [entry, ...(a.history ?? [])];
    a.transactions = { ...(a.transactions ?? {}), [entry.txid]: outputs };
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

  async propose(args: EngineProposeArgs): Promise<EngineProposal> {
    this.check('propose');
    this.proposeArgs.push(args);
    const fail = this.proposeFails.shift();
    if (fail !== undefined) throw new EngineError(fail.code, fail.message ?? fail.code, false, fail.recovery);
    const next = this.proposalQueue.shift();
    const proposal: EngineProposal = next?.proposal ?? {
      proposalId: `prop-${nextId++}`,
      operationId: `op-${nextId++}`,
      totalFee: 10_000n,
      steps: [
        {
          expiryHeight: 1,
          fee: 10_000n,
          inputs: [{ pool: 'sapling', value: args.amount + 10_000n }],
          outputs: [
            {
              kind: 'payment',
              pool: 'sapling',
              address: args.to,
              amount: args.amount,
              memo: args.memo ?? null,
            },
          ],
        },
      ],
    };
    this.heldTxids.set(proposal.proposalId, next?.txid ?? null);
    return proposal;
  }

  /** Models the SDK's shielding selector: only UTXOs on the selected
   * addresses AND at/above `threshold` enter the proposal; nothing eligible
   * rejects NOTHING_TO_SHIELD exactly like the engine (issue #8). */
  async proposeShield(args: EngineShieldArgs): Promise<EngineProposal> {
    this.check('proposeShield');
    this.proposeShieldArgs.push(args);
    const fail = this.proposeShieldFails.shift();
    if (fail !== undefined) throw new EngineError(fail.code, fail.message ?? fail.code, false, fail.recovery);
    const utxos = (this.need(args.accountId).utxos ?? []).filter(
      (u) => args.fromAddresses.includes(u.address) && u.value >= args.threshold,
    );
    if (utxos.length === 0) {
      throw new EngineError('NOTHING_TO_SHIELD', 'No eligible transparent funds meet the shielding request.');
    }
    const fee = 10_000n;
    const total = utxos.reduce((sum, u) => sum + u.value, 0n);
    const proposal: EngineProposal = {
      proposalId: `prop-${nextId++}`,
      operationId: `op-${nextId++}`,
      totalFee: fee,
      steps: [
        {
          expiryHeight: 1,
          fee,
          inputs: utxos.map((u) => ({ pool: 'transparent' as const, value: u.value })),
          outputs: [
            {
              kind: 'change' as const,
              pool: 'ironwood' as const,
              address: null,
              amount: total - fee,
              memo: null,
            },
          ],
        },
      ],
    };
    this.heldTxids.set(proposal.proposalId, `shieldtx-${proposal.proposalId}`);
    this.shieldProposals.set(proposal.proposalId, { accountId: args.accountId, utxos, fee });
    return proposal;
  }

  async listTransparentUtxos(accountId: string): Promise<readonly EngineTransparentUtxo[]> {
    this.check('listTransparentUtxos');
    return (this.need(accountId).utxos ?? []).map((u) => ({ address: u.address, value: u.value }));
  }

  async listNotes(accountId: string): Promise<readonly EngineNote[]> {
    this.check('listNotes');
    return (this.need(accountId).notes ?? []).map((n) => ({
      id: { pool: n.pool, txid: n.txid, outputIndex: n.outputIndex },
      value: n.value,
      spendState: n.spendState ?? 'unspent',
      locked: n.locked ?? false,
      address: null,
    }));
  }

  async listUtxos(accountId: string): Promise<readonly EngineNote[]> {
    this.check('listUtxos');
    return (this.need(accountId).utxos ?? []).map((u, i) => ({
      id: { pool: 'transparent', txid: u.txid ?? `utxo-${i}`, outputIndex: u.outputIndex ?? i },
      value: u.value,
      spendState: u.spendState ?? 'unspent',
      locked: u.locked ?? false,
      address: u.address,
    }));
  }

  async send(proposalId: string): Promise<EngineSendResult> {
    this.check('send');
    this.sentProposalIds.push(proposalId);
    const fail = this.sendFails.shift();
    if (fail !== undefined) throw new EngineError(fail.code, fail.message ?? fail.code, false, fail.recovery);
    if (!this.heldTxids.has(proposalId)) {
      throw new EngineError('INVALID_ARGUMENT', 'unknown proposal', false, 'review-new-proposal');
    }
    const txid = this.heldTxids.get(proposalId) ?? null;
    const operationId = `op-send-${proposalId}`;
    this.operations.push({ operationId, phase: 'observing', txid });
    const shield = this.shieldProposals.get(proposalId);
    if (shield !== undefined) {
      // Accepted shielding consumes its utxos and moves value transparent →
      // ironwood, exactly what the balances screen then shows (issue #8).
      const spec = this.need(shield.accountId);
      const consumed = new Set(shield.utxos);
      const total = shield.utxos.reduce((sum, u) => sum + u.value, 0n);
      spec.utxos = (spec.utxos ?? []).filter((u) => !consumed.has(u));
      if (spec.balance !== undefined) {
        spec.balance = {
          ...spec.balance,
          transparent: (spec.balance.transparent ?? 0n) - total,
          ironwood: (spec.balance.ironwood ?? 0n) + total - shield.fee,
        };
      }
      this.addTransaction(
        shield.accountId,
        {
          txid: `shieldtx-${proposalId}`,
          minedHeight: null,
          blockTime: null,
          balanceDelta: -shield.fee,
          pools: ['transparent', 'ironwood'],
          isShielding: true,
        },
        [],
      );
    }
    return { operationId, phase: 'observing', txid };
  }

  async abandon(operationId: string): Promise<void> {
    this.check('abandon');
    if (this.letAbandon !== null) await this.abandonGate;
    this.abandoned.push(operationId);
    const idx = this.operations.findIndex((op) => op.operationId === operationId);
    if (idx >= 0) this.operations.splice(idx, 1);
  }

  async attachSigner(args: { accountId: string; mnemonic: Uint8Array }): Promise<void> {
    this.check('attachSigner');
    // Copy before storing, like the real SDK: callers zeroize the bytes they
    // hand us (issue #6), so a captured reference would read all-zero later.
    this.attachArgs.push({ ...args, mnemonic: args.mnemonic.slice() });
    this.assertPhrase(args.mnemonic);
    const spec = this.need(args.accountId);
    // Viewing-key verification model (issue #6): a valid mnemonic that is not
    // THE wallet's phrase must fail, exactly like the SDK's check of the
    // restored key against the stored viewing key.
    if (spec.phrase !== undefined && spec.phrase !== new TextDecoder().decode(args.mnemonic)) {
      throw new EngineError('INVALID_MNEMONIC', 'phrase does not match this wallet');
    }
    spec.signerAttached = true;
  }

  async detachSigner(args: { accountId: string }): Promise<void> {
    this.check('detachSigner');
    this.detachArgs.push(args);
    const spec = this.need(args.accountId);
    spec.signerAttached = false;
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



