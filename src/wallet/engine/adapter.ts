// Real engine adapter: THE only module allowed to import @zcashlabs/zcash.js.
// Everything the app needs is projected onto the port types here; SDK shapes
// (branded ids, buckets, payment states) never cross this boundary.
import {
  accountIndex,
  createLightClient,
  createWalletClient,
  isZcashError,
  resolveBirthday,
  viewing,
  type AccountId,
  type AccountRecord,
  type Birthday,
  type LightClient,
  type MemorySigner,
  type MemoInput,
  type Pool,
  type Proposal,
  type SyncStatus,
  type TransactionPolicy,
  type WalletClient,
} from '@zcashlabs/zcash.js';
import type {
  Engine,
  EngineAccount,
  EngineBalance,
  EngineBirthday,
  EngineBirthdayHandle,
  EngineErrorCode,
  EngineHistoryEntry,
  EngineOperation,
  EngineProposal,
  EngineProposeArgs,
  EngineRecoveryReport,
  EngineSeedAccount,
  EngineSendResult,
  EngineSyncStatus,
  EngineWallet,
  OpenSpec,
} from './port';
import { EngineError } from './port';
import { frozenPolicy, RECOVERY_POLICY } from '../policy';

const mapError = (e: unknown): EngineError => {
  if (e instanceof EngineError) return e;
  if (!isZcashError(e)) {
    return new EngineError('UNKNOWN', e instanceof Error ? e.message : String(e));
  }
  const known: readonly EngineErrorCode[] = [
    'STORAGE_BUSY',
    'INVALID_MNEMONIC',
    'INVALID_ARGUMENT',
    'NETWORK_MISMATCH',
    'TRANSPORT_ERROR',
    'SIGNER_REQUIRED',
    'SYNC_REQUIRED',
    'TIMEOUT',
    'RUNTIME_UNAVAILABLE',
  ];
  // ACCOUNT_BUSY is the same lease collision the UI renders as storage-busy.
  const code: EngineErrorCode = known.includes(e.code as EngineErrorCode)
    ? (e.code as EngineErrorCode)
    : e.code === 'ACCOUNT_BUSY'
      ? 'STORAGE_BUSY'
      : e.recovery === 'correct-input'
        ? 'INVALID_ARGUMENT'
        : 'UNKNOWN';
  // e.g. RUNTIME_UNAVAILABLE carries the codec/protocol diagnosis; never
  // drop the SDK code on the floor when the port code collapses.
  const message = code === 'UNKNOWN' ? `${e.code}: ${e.message}` : e.message;
  return new EngineError(code, message, e.retryable, e.recovery);
};

const mapAccount = (a: AccountRecord): EngineAccount => ({
  id: a.id,
  name: a.name,
  birthdayHeight: a.birthdayHeight,
  accountIndex: a.accountIndex === null ? null : Number(a.accountIndex),
  viewOnly: a.viewOnly,
  signerAttached: a.signerAttached,
});

const mapSync = (s: SyncStatus): EngineSyncStatus => ({
  activity: s.activity,
  scanned: s.scan.maxScannedHeight,
  target: s.target?.height ?? null,
  targetReached: s.targetReached,
  scanComplete: s.scan.scanComplete,
});

const memoToText = (memo: MemoInput | null): string | null => {
  if (memo === null) return null;
  if (!('bytes' in memo) || memo.bytes === undefined) {
    return memo.text === '' ? null : memo.text;
  }
  const bytes = memo.bytes;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  if (end === 0) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return null;
  }
};

const projectProposal = (proposal: Proposal): EngineProposal => ({
  proposalId: proposal.proposalId,
  operationId: proposal.operationId,
  totalFee: proposal.totalFee,
  steps: proposal.steps.map((step) => ({
    expiryHeight: step.expiryHeight,
    fee: step.fee,
    inputs: step.inputs.map((input) => ({ pool: input.pool, value: input.value })),
    outputs: step.outputs.map((output) => ({
      kind: output.kind,
      pool: output.pool,
      address: output.address,
      amount: output.amount,
      memo: memoToText(output.memo),
    })),
  })),
});

const mapHistory = (h: {
  txid: string;
  minedHeight: number | null;
  blockTime: number | null;
  balanceDelta: bigint;
  pools: readonly string[];
}): EngineHistoryEntry => ({
  txid: h.txid,
  minedHeight: h.minedHeight,
  blockTime: h.blockTime,
  balanceDelta: h.balanceDelta,
  pools: h.pools,
});

class AdapterWallet implements EngineWallet {
  readonly recovery: EngineRecoveryReport;
  /** EngineBirthdayHandle -> resolved SDK Birthday witness. */
  private readonly birthdays = new Map<EngineBirthdayHandle, Birthday>();
  /** proposalId → the SDK object send() must execute unchanged. */
  private readonly proposals = new Map<string, Proposal>();
  /** Attached signers stay alive for the session; disposing one detaches spend authority. */
  private readonly signers = new Map<string, MemorySigner>();
  private readonly client: WalletClient;
  private readonly light: LightClient;
  private closing = false;

  constructor(client: WalletClient, light: LightClient) {
    this.client = client;
    this.light = light;
    const r = client.recovery;
    this.recovery = {
      local: r.local,
      operations: r.operations,
      observation: r.observation,
      observedOperations: r.observedOperations,
      deferredOperations: r.deferredOperations,
      lastError: r.lastError?.message ?? null,
    };
  }

  async resolveBirthday(firstScanHeight: number): Promise<EngineBirthdayHandle> {
    try {
      const birthday = await resolveBirthday({ light: this.light, firstScanHeight });
      const handle: EngineBirthdayHandle = { kind: 'birthday', firstScanHeight };
      this.birthdays.set(handle, birthday);
      return handle;
    } catch (e) {
      throw mapError(e);
    }
  }

  private sdkBirthday(b: EngineBirthday): Birthday | 'fullScan' {
    if (b === 'fullScan') return 'fullScan';
    const witness = this.birthdays.get(b);
    if (witness === undefined) throw new EngineError('INVALID_ARGUMENT', 'birthday handle from another wallet');
    return witness;
  }

  async createSeed(args: { mnemonic: Uint8Array; name?: string }): Promise<EngineSeedAccount> {
    try {
      const created = await this.client.accounts.create({ mnemonic: args.mnemonic, name: args.name });
      return this.seedAccount(created.account, created.signer);
    } catch (e) {
      throw mapError(e);
    }
  }

  async importSeed(args: {
    mnemonic: Uint8Array;
    passphrase?: Uint8Array;
    accountIndex: number;
    birthday: EngineBirthday;
    name?: string;
  }): Promise<EngineSeedAccount> {
    try {
      const created = await this.client.accounts.import({
        mnemonic: args.mnemonic,
        ...(args.passphrase === undefined ? {} : { passphrase: args.passphrase }),
        accountIndex: accountIndex(args.accountIndex),
        birthday: this.sdkBirthday(args.birthday),
        name: args.name,
      });
      return this.seedAccount(created.account, created.signer);
    } catch (e) {
      throw mapError(e);
    }
  }

  /** The created signer is caller-owned memory-only authority; ufvk() reads
   * its descriptor, dispose() wipes it. Spend authority is attached later,
   * on Unlock, via attachSigner. */
  private seedAccount(account: AccountRecord, signer: MemorySigner): EngineSeedAccount {
    const projected = mapAccount(account);
    return {
      account: projected,
      ufvk: async () => {
        try {
          if (account.accountIndex === null) throw new EngineError('INVALID_ARGUMENT', 'no account index');
          const descriptor = await signer.getAccount({
            network: this.client.network,
            selector: { kind: 'derived', accountIndex: account.accountIndex },
          });
          return viewing.export({
            account: descriptor,
            format: 'ufvk',
            acknowledge: 'discloses-viewing-authority',
          });
        } catch (e) {
          throw mapError(e);
        }
      },
      dispose: async () => {
        await signer.dispose();
      },
    };
  }

  async importViewing(args: {
    viewingKey: string;
    birthday: EngineBirthday;
    name?: string;
  }): Promise<EngineAccount> {
    try {
      const record = await this.client.accounts.import({
        viewingKey: args.viewingKey,
        birthday: this.sdkBirthday(args.birthday),
        name: args.name,
        viewOnly: true,
      });
      return mapAccount(record);
    } catch (e) {
      throw mapError(e);
    }
  }

  async accounts(): Promise<EngineAccount[]> {
    try {
      return (await this.client.accounts.list()).map(mapAccount);
    } catch (e) {
      throw mapError(e);
    }
  }

  async currentAddress(accountId: string): Promise<string | null> {
    try {
      return await this.client.addresses.current({ accountId: accountId as AccountId });
    } catch (e) {
      throw mapError(e);
    }
  }

  async mintAddress(accountId: string): Promise<string> {
    try {
      const record = await this.client.addresses.next({ accountId: accountId as AccountId });
      return record.address;
    } catch (e) {
      throw mapError(e);
    }
  }

  async getBalance(accountId: string): Promise<EngineBalance> {
    try {
      const b = await this.client.getBalance({ accountId: accountId as AccountId });
      const amounts = b.amounts;
      return {
        accountId,
        transparent: amounts === null ? null : amounts.transparent.regular.spendable,
        sapling: amounts === null ? null : amounts.sapling.spendable,
        ironwood: amounts === null ? null : amounts.ironwood.spendable,
        scanned: amounts !== null,
      };
    } catch (e) {
      throw mapError(e);
    }
  }

  async getHistory(accountId: string, limit = 20): Promise<readonly EngineHistoryEntry[]> {
    try {
      const page = await this.client.getHistory({ accountId: accountId as AccountId, limit });
      return page.items.map(mapHistory);
    } catch (e) {
      throw mapError(e);
    }
  }

  watchSync(): AsyncIterable<EngineSyncStatus> {
    // rc.5: watchSync publishes on scan-revision change; progress ticks flow
    // while scanning. The app re-reads displayed state on each tick anyway.
    const inner = this.client.watchSync();
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const status of inner) {
            if (self.closing) return;
            yield mapSync(status);
          }
        } catch (e) {
          if (!self.closing) throw mapError(e);
        }
      },
    };
  }

  async syncStatus(): Promise<EngineSyncStatus> {
    return mapSync(await this.client.getSyncStatus());
  }

  /** Fire-and-forget scan: sync() resolves at target, which can take minutes;
   * boot must not block on it. Failures surface via the sync stream/status. */
  async startSync(): Promise<void> {
    this.client.sync().catch(() => undefined);
  }

  /** Bounded freshness pass (spike steps.ts S1a: accounts.create rejects
   * SYNC_REQUIRED until local chain state is coherent, "after explicit
   * sync"). Never rejects — the caller's create/SYNC_REQUIRED path decides;
   * timeoutMs only caps endpoint latency, not scan completion. */
  async syncFresh(timeoutMs: number): Promise<void> {
    try {
      await this.client.sync({ signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // aborted or transient transport; freshness precondition re-checked at create
    }
  }

  async propose(args: EngineProposeArgs): Promise<EngineProposal> {
    try {
      const proposal = await this.client.propose({
        accountId: args.accountId as AccountId,
        to: args.to,
        amount: args.amount,
        ...(args.memo === undefined ? {} : { memo: { text: args.memo } }),
      });
      this.proposals.set(proposal.proposalId, proposal);
      return projectProposal(proposal);
    } catch (e) {
      throw mapError(e);
    }
  }

  async send(proposalId: string): Promise<EngineSendResult> {
    const proposal = this.proposals.get(proposalId);
    if (proposal === undefined) {
      throw new EngineError('INVALID_ARGUMENT', 'unknown proposal', false, 'review-new-proposal');
    }
    try {
      // The stored object is the plan the user reviewed. send() executes it
      // as-is: no second propose, no rebuilt outputs.
      const pending = await this.client.send({ proposal });
      this.proposals.delete(proposalId);
      const snap = await pending.snapshot();
      return {
        operationId: snap.operationId,
        phase: snap.phase,
        txid: snap.steps[0]?.txid ?? null,
      };
    } catch (e) {
      throw mapError(e);
    }
  }

  async abandon(operationId: string): Promise<void> {
    try {
      await this.client.operations.abandon({ operationId });
      for (const [id, proposal] of this.proposals) {
        if (proposal.operationId === operationId) this.proposals.delete(id);
      }
    } catch (e) {
      throw mapError(e);
    }
  }

  async attachSigner(args: { accountId: string; mnemonic: Uint8Array }): Promise<void> {
    let signer: MemorySigner | null = null;
    try {
      signer = await this.client.accounts.restoreSigner({
        accountId: args.accountId as AccountId,
        mnemonic: args.mnemonic,
      });
      await this.client.accounts.attachSigner({
        accountId: args.accountId as AccountId,
        signer,
      });
      const previous = this.signers.get(args.accountId);
      this.signers.set(args.accountId, signer);
      signer = null;
      if (previous !== undefined) await previous.dispose();
    } catch (e) {
      if (signer !== null) await signer.dispose().catch(() => undefined);
      throw mapError(e);
    }
  }

  async listOperations(): Promise<readonly EngineOperation[]> {
    try {
      const page = await this.client.operations.list();
      return page.items.map((op) => ({
        operationId: op.operationId,
        phase: op.phase,
        txid: op.steps[0]?.txid ?? null,
      }));
    } catch (e) {
      throw mapError(e);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const signer of this.signers.values()) await signer.dispose().catch(() => undefined);
    this.signers.clear();
    await this.client.close();
  }
}

/** FrozenPolicy projection onto the SDK shape; spendPools is non-empty by
 * construction (frozenPolicy always carries at least the shielded pair). */
const sdkTransactionPolicy = (allowTransparentSends: boolean): TransactionPolicy => {
  const p = frozenPolicy(allowTransparentSends);
  return { ...p, spendPools: p.spendPools as [Pool, ...Pool[]] };
};

/** Delete the OPFS directory the SDK creates per Wallet (ADR-0003): the SDK
 * stores its sqlite db under `navigator.storage.getDirectory()/<name>`, so
 * erasure is the recursive directory removal the spike's purge already proved
 * out (fails loudly while a client still holds the exclusive lease — callers
 * close first). Missing directory = already erased = success. */
const removeOpfsStorage = async (name: string): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(name, { recursive: true });
  } catch (e) {
    // Spec: NotFoundError when the entry is absent = already erased.
    // A held lease (InvalidStateError/NoModificationAllowedError) must stay loud.
    if (e instanceof DOMException && e.name === 'NotFoundError') return;
    throw mapError(e);
  }
};

/** Real engine: one Client + one OPFS db + one endpoint per open (ADR-0003). */
export const createAdapterEngine = (): Engine => ({
  async open(spec: OpenSpec): Promise<EngineWallet> {
    try {
      const light = await createLightClient(spec.endpoint, { network: spec.network });
      const policy = sdkTransactionPolicy(spec.allowTransparentSends);
      const client = await createWalletClient({
        network: light.network,
        light,
        broadcaster: light,
        storage: { kind: 'browser-opfs', name: spec.storageName },
        confirmations: policy.confirmations,
        observation: { pollIntervalMs: 3_000, maxBufferedUpdates: 16 },
        recovery: RECOVERY_POLICY,
        transactionPolicy: policy,
      });
      return new AdapterWallet(client, light);
    } catch (e) {
      throw mapError(e);
    }
  },
  removeStorage: removeOpfsStorage,
});
