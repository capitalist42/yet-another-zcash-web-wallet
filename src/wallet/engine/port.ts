// The app-owned engine port. Every zcash.js call in the product flows through
// the interfaces below; only engine/adapter.ts imports @zcashlabs/zcash.js.
// UI and services import these types; the fake adapter (fake.ts) implements
// the same port for every test. App-level types only — no SDK types here.

export type NetworkId = 'mainnet' | 'testnet';

/** Opaque handle from resolveBirthday(); adapter carries the witness. */
export interface EngineBirthdayHandle {
  readonly kind: 'birthday';
  readonly firstScanHeight: number;
}
export type EngineBirthday = 'fullScan' | EngineBirthdayHandle;

export type EngineErrorCode =
  | 'STORAGE_BUSY'
  | 'INVALID_MNEMONIC'
  | 'INVALID_ARGUMENT'
  | 'NETWORK_MISMATCH'
  | 'TRANSPORT_ERROR'
  | 'SIGNER_REQUIRED'
  | 'SYNC_REQUIRED'
  | 'TIMEOUT'
  /** SDK artifact acquisition/integrity failure; recoverable by reloading fresh assets. */
  | 'RUNTIME_UNAVAILABLE'
  | 'UNKNOWN'

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;
  constructor(code: EngineErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface EngineAccount {
  readonly id: string;
  readonly name: string | null;
  readonly birthdayHeight: number;
  /** ZIP-32 account index; null for imported viewing keys. */
  readonly accountIndex: number | null;
  readonly viewOnly: boolean;
  readonly signerAttached: boolean;
}

export interface EngineBalance {
  readonly accountId: string;
  /** Spendable, per pool, in zats; null = never scanned yet. */
  readonly transparent: bigint | null;
  readonly sapling: bigint | null;
  readonly ironwood: bigint | null;
  readonly scanned: boolean;
}

export interface EngineHistoryEntry {
  readonly txid: string;
  readonly minedHeight: number | null;
  readonly blockTime: number | null;
  readonly balanceDelta: bigint;
  readonly pools: readonly string[];
}

export interface EngineSyncStatus {
  readonly activity: 'idle' | 'running' | 'stopped' | 'failed';
  readonly scanned: number | null;
  readonly target: number | null;
  readonly targetReached: boolean;
  readonly scanComplete: boolean | null;
}

export type EngineOperationPhase =
  | 'proposed'
  | 'awaitingAuthorization'
  | 'building'
  | 'ready'
  | 'observing'
  | 'needsAttention'
  | 'complete'
  | 'abandoned';

export interface EngineOperation {
  readonly operationId: string;
  readonly phase: EngineOperationPhase;
  readonly txid: string | null;
}

/** Non-terminal = Pending Payment (chip lights; #10 owns the detail page). */
export const isNonTerminal = (phase: EngineOperationPhase): boolean =>
  phase !== 'complete' && phase !== 'abandoned';

export interface EngineRecoveryReport {
  readonly local: 'complete';
  readonly operations: number;
  readonly observation: 'offline' | 'complete' | 'incomplete';
  readonly observedOperations: number;
  readonly deferredOperations: number;
  readonly lastError: string | null;
}

/** One created/imported seed account with in-memory spend authority. */
export interface EngineSeedAccount {
  readonly account: EngineAccount;
  /** UFVK for this account (registry fingerprint + receive display). */
  ufvk(): Promise<string>;
  /** Dispose adapter-side signer state (fake; real signer is memory-only). */
  dispose(): Promise<void>;
}

/**
 * One open Wallet = one Client = one storage database, bound to one endpoint
 * (ADR-0003). The slice of the SDK's WalletClient the app uses.
 */
export interface EngineWallet {
  /** Startup recovery report, final once open() resolved (boot gate). */
  readonly recovery: EngineRecoveryReport;
  resolveBirthday(firstScanHeight: number): Promise<EngineBirthdayHandle>;
  createSeed(args: { mnemonic: Uint8Array; name?: string }): Promise<EngineSeedAccount>;
  importSeed(args: {
    mnemonic: Uint8Array;
    passphrase?: Uint8Array;
    accountIndex: number;
    birthday: EngineBirthday;
    name?: string;
  }): Promise<EngineSeedAccount>;
  importViewing(args: {
    viewingKey: string;
    birthday: EngineBirthday;
    name?: string;
  }): Promise<EngineAccount>;
  accounts(): Promise<EngineAccount[]>;
  currentAddress(accountId: string): Promise<string | null>;
  mintAddress(accountId: string): Promise<string>;
  getBalance(accountId: string): Promise<EngineBalance>;
  getHistory(accountId: string, limit?: number): Promise<readonly EngineHistoryEntry[]>;
  watchSync(): AsyncIterable<EngineSyncStatus>;
  /**
   * Snapshot of the current sync progress. Unlike the watchSync stream —
   * which publishes only on scan-revision commits (spike §Sync) — this
   * answers while a scan runs, so the progress bar can poll it.
   */
  syncStatus(): Promise<EngineSyncStatus>;
  startSync(): Promise<void>;
  /**
   * Bounded tip-freshness pass for mutation preconditions (accounts.create
   * rejects SYNC_REQUIRED on stale local chain state). Never rejects; the
   * timeout is an upper bound on endpoint latency, not a scan budget.
   */
  syncFresh(timeoutMs: number): Promise<void>;
  listOperations(): Promise<readonly EngineOperation[]>;
  close(): Promise<void>;
}

export interface OpenSpec {
  readonly network: NetworkId;
  readonly endpoint: string;
  /** OPFS database name, `yaw-<network>-<id>` (ADR-0003). */
  readonly storageName: string;
  /** Frozen policy axis read from Settings at create/open (ADR-0005). */
  readonly allowTransparentSends: boolean;
}

/** The one engine seam. `open` = create-or-resume the Client for a Wallet. */
export interface Engine {
  open(spec: OpenSpec): Promise<EngineWallet>;
  /** Erase the OPFS database named `storageName` (Settings → Remove Wallet).
   * Already-gone is success. The client that held it MUST be closed first:
   * the SDK keeps exclusive sync access handles open until close(). */
  removeStorage(storageName: string): Promise<void>;
}
