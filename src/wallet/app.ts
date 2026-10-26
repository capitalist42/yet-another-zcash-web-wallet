// The Wallet app service: boot choreography + onboarding flows + UI stores.
// Everything engine-shaped goes through the port; this module is the single
// orchestrator the React tree subscribes to (nanostores).
import { atom, computed, type ReadableAtom, type WritableAtom } from 'nanostores';
/** Sync status + the account's birthday = everything the progress bar needs. */
export type SyncProgressView = EngineSyncStatus & { readonly birthday: number | null };

import type {
  Engine,
  EngineAccount,
  EngineBalance,
  EngineErrorCode,
  EngineHistoryEntry,
  EngineNote,
  EngineProposal,
  EngineRecovery,
  EngineSyncStatus,
  EngineTransparentUtxo,
  EngineWallet,
  NetworkId,
  NoteId,
} from './engine/port';
import { EngineError, isNonTerminal, MAX_SHIELD_ADDRESSES } from './engine/port';
import type { Registry, WalletKind, WalletRecord } from './registry';
import { ALLOW_TRANSPARENT_SENDS, frozenPolicy, storageName, FRESHNESS_TIMEOUT_MS, type EndpointSettings } from './policy';
import { fingerprintFromUfvk } from './fingerprint';
import { generatePhrase, normalizePhrase, phraseBytes, zeroize } from './keys';
import { formatZats, parseZecAmount } from './units';
import { classifyAddress, parseZip321 } from './zip321';
import { VaultError, type Vault, type VaultErrorCode } from './vault';

export type Screen = 'booting' | 'welcome' | 'wallet' | 'settings' | 'storage-busy';

export interface WalletInfo {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly kind: WalletKind;
}

export interface CreateSession {
  readonly phrase: string;
}

export type RestoreBirthday = 'fullScan' | { readonly kind: 'height'; readonly height: number };

/** App-level result codes: engine codes plus the onboarding gate refusal
 * and the vault's wrong-passphrase / missing-envelope refusals. */
export type ImportErrorCode = EngineErrorCode | 'GATE_PENDING' | VaultErrorCode;

export interface ImportResult {
  readonly ok: boolean;
  readonly code?: ImportErrorCode;
  readonly message?: string;
}

export interface SpendGuard {
  readonly ok: boolean;
  readonly reason?: 'view-only' | 'unavailable' | 'locked';
}

/** Onboarding custody choice (ADR-0002, issue #6): at create/restore the user
 * picks "Remember on this device (encrypted)" or "Never store". `vaultPassphrase`
 * is required when `remember` is true (the AES-GCM envelope key). */
export interface RememberChoice {
  readonly remember: boolean;
  readonly vaultPassphrase?: string;
}

export interface SendDraftView {
  readonly recipient: string;
  readonly amount: string;
  readonly memo: string;
  /** Non-empty memo that will ride on-chain, encrypted to the recipient. */
  readonly memoWarning: boolean;
  /** Transparent recipient while Allow transparent sends is off. */
  readonly transparentBlocked: boolean;
}

export type SendNotice =
  | null
  | {
      readonly kind:
        | 'invalid-recipient'
        | 'invalid-amount'
        | 'memo-too-long'
        | 'memo-on-transparent'
        | 'transparent-disabled'
        | 'transparent-input'
        | 'network-mismatch'
        | 'unavailable'
        | 'view-only'
        | 'locked'
        | 'phrase';
    }
  | { readonly kind: 'engine'; readonly code: EngineErrorCode; readonly recovery: EngineRecovery };

/** One row of the mandatory Exposed Address list (ADR-0004): every minted
 * address stays valid forever; the amount is what THIS session has observed
 * landing on it (fresh payments accumulate per sync tick). */
export interface ExposedAddress {
  readonly address: string;
  readonly receivedZats: bigint;
}

export type SendView =
  | { readonly phase: 'closed' }
  | { readonly phase: 'form'; readonly draft: SendDraftView; readonly notice: SendNotice }
  | {
      readonly phase: 'review';
      readonly draft: SendDraftView;
      readonly proposal: EngineProposal;
      readonly notice: SendNotice;
      /** A chain input spends a note outside the non-excluded selection. */
      readonly deviation: boolean;
      /** The user accepted that real Proposal. Ignored when deviation is false. */
      readonly accepted: boolean;
    }
  | { readonly phase: 'unlock'; readonly draft: SendDraftView; readonly notice: SendNotice }
  | { readonly phase: 'sync'; readonly draft: SendDraftView }
  | { readonly phase: 'sent'; readonly txid: string | null };

/** One note-browser row. `locked` is the operation lock, not Exclude. */
export interface NoteRow {
  readonly id: NoteId;
  readonly value: bigint;
  readonly spendState: EngineNote['spendState'];
  readonly locked: boolean;
  readonly excluded: boolean;
  readonly address: string | null;
}

/** One checkbox row of the Shield screen: ALL of one address's spendable
 * transparent utxos (the SDK's selection granularity is the address, so the
 * UI never promises per-utxo choice — issue #8). */
export interface ShieldAddressRow {
  readonly address: string;
  readonly zats: bigint;
  readonly utxoCount: number;
  readonly checked: boolean;
}

export interface ShieldDraftView {
  /** Whole zats, integer text; parsed on review. */
  readonly threshold: string;
  readonly addresses: readonly ShieldAddressRow[];
  /** False until the address list has been read. An empty list before that
   * is not "nothing to shield". */
  readonly ready: boolean;
}

export type ShieldNotice =
  | null
  | {
      readonly kind:
        | 'invalid-threshold'
        | 'empty-selection'
        | 'too-many-addresses'
        | 'nothing-to-shield'
        | 'unavailable'
        | 'view-only'
        | 'locked'
        | 'phrase';
    }
  | { readonly kind: 'engine'; readonly code: EngineErrorCode; readonly recovery: EngineRecovery };

export type ShieldView =
  | { readonly phase: 'closed' }
  | { readonly phase: 'form'; readonly draft: ShieldDraftView; readonly notice: ShieldNotice }
  | {
      readonly phase: 'review';
      readonly draft: ShieldDraftView;
      readonly proposal: EngineProposal;
      readonly notice: ShieldNotice;
    }
  | { readonly phase: 'unlock'; readonly draft: ShieldDraftView; readonly notice: ShieldNotice }
  | { readonly phase: 'sync'; readonly draft: ShieldDraftView }
  | { readonly phase: 'sent'; readonly txid: string | null };

export interface WalletApp {
  // --- stores (UI subscribes; tests assert) --------------------------------
  readonly screen: ReadableAtom<Screen>;
  readonly network: WritableAtom<NetworkId>;
  /** Active lightwalletd endpoint; persistent chip (ADR-0001 disclosure). */
  readonly endpoint: ReadableAtom<string>;
  readonly walletInfo: ReadableAtom<WalletInfo | null>;
  readonly balances: ReadableAtom<EngineBalance | null>;
  /** Size of this Wallet's persisted Exclude set (issue #9). */
  readonly excludedCount: ReadableAtom<number>;
  /** Note/UTXO browser. Spend state and operation lock are display-only. */
  readonly notes: ReadableAtom<readonly NoteRow[]>;
  readonly sync: ReadableAtom<EngineSyncStatus | null>;
  /** `sync` + the scanned account's birthday height (percent denominator). */
  readonly syncProgress: ReadableAtom<SyncProgressView | null>;
  readonly address: ReadableAtom<string | null>;
  /** Mandatory Exposed Address list (ADR-0004): every address this account
   * has exposed, each with the received amount observed for it. */
  readonly exposedAddresses: ReadableAtom<readonly ExposedAddress[]>;
  readonly pendingCount: ReadableAtom<number>;
  /** Startup recovery finished (boot gate): payment paths unlock after. */
  readonly recovered: ReadableAtom<boolean>;
  /** Spend-capable = seed Wallet AND unlocked AND recovery completed (#4, #6). */
  readonly canSpend: ReadableAtom<boolean>;
  /** True when the open Wallet's signer is attached (Unlock or mirror restore). */
  readonly unlocked: ReadableAtom<boolean>;
  /** Epoch ms when the idle deadline expires; null when not unlocked (#6). */
  readonly unlockDeadline: ReadableAtom<number | null>;
  /** Ms remaining until auto-Lock; null when not unlocked (countdown chip). */
  readonly autoLockInMs: ReadableAtom<number | null>;
  /** True when a Vault envelope exists for the open Wallet (Remember). False
   * for view-only and Never-store Wallets — Unlock uses the phrase path. */
  readonly hasVault: ReadableAtom<boolean>;
  /** Forced backup gate is open: a generated phrase awaits confirmation.
   * While true, every other onboarding path is refused (#4: not dismissable). */
  readonly backupPending: ReadableAtom<boolean>;
  readonly bootError: ReadableAtom<string | null>;
  // --- flows ----------------------------------------------------------------
  /** `restoreLatest` is the page-load boot: open the newest saved wallet. */
  boot(opts?: { restoreLatest?: boolean }): Promise<void>;
  setNetwork(network: NetworkId): Promise<void>;
  /** Open Settings. The current wallet stays open until the network actually changes. */
  openSettings(): void;
  /** Leave Settings for the open wallet, or welcome when none is open. */
  closeSettings(): void;
  /** Erase the current Wallet (Settings → Remove Wallet): close the client,
   * delete its OPFS storage, drop the registry row, land on welcome. */
  removeWallet(): Promise<ImportResult>;
  /** True while a create attempt is talking to the engine. */
  readonly creating: ReadableAtom<boolean>;
  readonly onCreate: {
    generate(): Promise<CreateSession>;
    confirmBackup(phrase: string, choice?: RememberChoice): Promise<ImportResult>;
    /** Retry account creation on the wallet already on screen. */
    resume(): Promise<ImportResult>;
  };
  readonly onRestore: {
    restore(args: {
      phrase: string;
      passphrase?: string;
      accountIndex: number;
      birthday: RestoreBirthday;
      name?: string;
      custody?: RememberChoice;
    }): Promise<ImportResult>;
  };
  readonly onViewOnly: {
    import(args: { viewingKey: string; birthday: RestoreBirthday; name?: string }): Promise<ImportResult>;
  };
  /** Capability gate the Send surface must pass before composing (#4, #6). */
  guardSpend(): SpendGuard;
  /** Unlock the open Wallet from the Vault (Remember) or by re-entering the
   * phrase (Never-store). On success, the signer is attached and the seed
   * mirror + idle deadline persist (Remember only). Never auto-decrypts. */
  unlock(passphrase: string): Promise<ImportResult>;
  /** App-wide Lock (#6): detach the signer, zeroize the mirror, set the Lock
   * flag. Viewing continues; both Networks and every open Wallet lose spend
   * authority. The flag survives reload until the next Unlock clears it. */
  lock(): Promise<void>;
  /** Re-enter the recovery phrase (Never-store path; no Vault envelope). */
  unlockWithPhrase(phrase: string): Promise<ImportResult>;
  readonly send: ReadableAtom<SendView>;
  readonly onSend: {
    open(): Promise<void>;
    close(): Promise<void>;
    setRecipient(text: string): void;
    setAmount(text: string): void;
    setMemo(text: string): void;
    review(): Promise<void>;
    /** Broadcast the proposal currently on the review screen. */
    confirm(): Promise<void>;
    /** Consent to a Proposal whose inputs fell outside the selection. */
    acceptInputs(): void;
    /** Re-enter the seed phrase after a reattach-signer recovery. */
    unlock(phrase: string): Promise<void>;
    /** Leave the sync route and rebuild the payment. */
    backToForm(): void;
    /** Leave review without sending. The proposal is released. */
    edit(): void;
  };
  readonly onNotes: {
    /** Re-read notes and UTXOs for the open Wallet. */
    refresh(): Promise<void>;
    exclude(id: NoteId): Promise<void>;
    include(id: NoteId): Promise<void>;
    /** Drop every Exclude on this Wallet. */
    reset(): Promise<void>;
  };
  readonly shield: ReadableAtom<ShieldView>;
  readonly onShield: {
    /** Rebuilds the checkbox list from the current utxo set. */
    open(): Promise<void>;
    close(): Promise<void>;
    setThreshold(text: string): void;
    toggle(address: string): void;
    review(): Promise<void>;
    /** Broadcast the proposal currently on the review screen. */
    confirm(): Promise<void>;
    /** Re-enter the seed phrase after a reattach-signer recovery. */
    unlock(phrase: string): Promise<void>;
    /** Leave the sync route and rebuild the shielding plan. */
    backToForm(): void;
    /** Leave review without sending. The proposal is released. */
    edit(): void;
  };
  history(): Promise<readonly EngineHistoryEntry[]>;
}

export interface WalletAppDeps {
  readonly engine: Engine;
  readonly registry: Registry;
  /** App-level seed Vault (ADR-0002, issue #6). */
  readonly vault: Vault;
  readonly endpoints: EndpointSettings;
  /** navigator.storage.persist() — OPFS eviction guard, requested at creation. */
  requestPersist(): Promise<boolean>;
  /** test seam: capture engine-fed secret bytes to assert zeroization */
  traceSecret?(bytes: Uint8Array): void;
}

const asResult = (e: unknown): ImportResult => {
  if (e instanceof EngineError) return { ok: false, code: e.code, message: e.message };
  return { ok: false, code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
};

/** Birthday choice guard (Restore + View-only, 4 call sites): an explicit
 * height must be a whole block height ≥ 1 before any engine call. */
const validBirthday = (b: RestoreBirthday): boolean =>
  b === 'fullScan' || (Number.isInteger(b.height) && b.height >= 1);

/** `getSyncStatus()` cadence for the in-flight progress bar (spike §Sync:
 * the watch stream only publishes on scan-revision commits). */
const SYNC_POLL_MS = 1_500;

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Sync-store equality: re-setting an identical snapshot every poll tick
 * would wake every subscriber (progress bar, history refresh) for nothing. */
const sameSync = (a: EngineSyncStatus | null, b: EngineSyncStatus): boolean =>
  a !== null &&
  a.activity === b.activity &&
  a.scanned === b.scanned &&
  a.target === b.target &&
  a.targetReached === b.targetReached &&
  a.scanComplete === b.scanComplete;

const NETWORK_PREF_KEY = 'yaw-network';

const readNetworkPref = (): NetworkId | null => {
  try {
    const saved = globalThis.localStorage?.getItem(NETWORK_PREF_KEY);
    return saved === 'mainnet' || saved === 'testnet' ? saved : null;
  } catch {
    return null;
  }
};

const writeNetworkPref = (id: NetworkId): void => {
  try {
    globalThis.localStorage?.setItem(NETWORK_PREF_KEY, id);
  } catch {
    // Private mode can reject storage; the open wallet still reloads via the registry.
  }
};

const PENDING_SEED_KEY = 'yaw-pending-seed';

// The custody choice rides with the phrase: a reload mid-create must resume
// as Remember (store envelope + mirror) or as Never-store, never silently
// degrade. The vault passphrase sits in sessionStorage right next to the
// seed phrase itself — same tab, same lifetime, no new exposure surface.
interface PendingSeed {
  readonly id: string;
  readonly phrase: string;
  readonly remember?: boolean;
  readonly vaultPassphrase?: string;
}

const savePendingSeed = (choice: RememberChoice, seed: { id: string; phrase: string }): void => {
  try {
    globalThis.sessionStorage?.setItem(
      PENDING_SEED_KEY,
      JSON.stringify({ ...seed, ...(choice.remember && choice.vaultPassphrase !== undefined ? { remember: true, vaultPassphrase: choice.vaultPassphrase } : {}) }),
    );
  } catch {
    // Reload can only finish creation when the tab can hold the phrase.
  }
};

const readPendingSeed = (): PendingSeed | null => {
  try {
    const raw = globalThis.sessionStorage?.getItem(PENDING_SEED_KEY);
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = JSON.parse(raw) as { id?: unknown; phrase?: unknown; remember?: unknown; vaultPassphrase?: unknown };
    if (typeof parsed.id !== 'string' || typeof parsed.phrase !== 'string') return null;
    return {
      id: parsed.id,
      phrase: parsed.phrase,
      ...(parsed.remember === true && typeof parsed.vaultPassphrase === 'string' ? { remember: true, vaultPassphrase: parsed.vaultPassphrase } : {}),
    };
  } catch {
    return null;
  }
};

const clearPendingSeed = (): void => {
  try {
    globalThis.sessionStorage?.removeItem(PENDING_SEED_KEY);
  } catch {
    // already gone
  }
};

// --- Session/Lock model (ADR-0002, issue #6) -------------------------------
// The decrypted seed mirror lives in sessionStorage with a persisted idle
// deadline. Unlock survives iff deadline-unexpired AND no Lock flag — checked
// every boot, the ONLY guarantee. Browser session-restore may resurrect the
// mirror, so process death is never a security boundary. The Lock flag is
// app-wide (every open Wallet, both Networks) and survives reload until the
// next Unlock clears it. Never auto-decrypt at startup: a valid mirror only
// re-attaches the signer from already-decrypted bytes.

const AUTO_LOCK_MS = 10 * 60 * 1000; // 10 activity-idle minutes (issue #6)
const MIRROR_KEY = 'yaw-seed-mirror';
const LOCK_FLAG_KEY = 'yaw-lock';

interface SeedMirror {
  readonly id: string;
  readonly phrase: string;
  /** Epoch ms when the idle deadline expires. */
  readonly deadline: number;
}

const readMirror = (): SeedMirror | null => {
  try {
    const raw = globalThis.sessionStorage?.getItem(MIRROR_KEY);
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = JSON.parse(raw) as Partial<SeedMirror>;
    if (typeof parsed.id !== 'string' || typeof parsed.phrase !== 'string' || typeof parsed.deadline !== 'number')
      return null;
    return { id: parsed.id, phrase: parsed.phrase, deadline: parsed.deadline };
  } catch {
    return null;
  }
};

const writeMirror = (m: SeedMirror): void => {
  try {
    globalThis.sessionStorage?.setItem(MIRROR_KEY, JSON.stringify(m));
  } catch {
    // Private mode can reject storage; the unlock still works for this tab.
  }
};

const clearMirror = (): void => {
  try {
    globalThis.sessionStorage?.removeItem(MIRROR_KEY);
  } catch {
    // already gone
  }
};

const readLockFlag = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(LOCK_FLAG_KEY) === '1';
  } catch {
    return false;
  }
};

const setLockFlag = (): void => {
  try {
    globalThis.localStorage?.setItem(LOCK_FLAG_KEY, '1');
  } catch {
    // private mode: the in-memory unlocked=false is the boundary here
  }
};

const clearLockFlag = (): void => {
  try {
    globalThis.localStorage?.removeItem(LOCK_FLAG_KEY);
  } catch {
    // already gone
  }
};

/** Mainnet by default. `?network=mainnet|testnet` overrides the boot Network. */
export const networkFromQuery = (): NetworkId | null => {
  const forced = new URLSearchParams(globalThis.location?.search ?? '').get('network');
  return forced === 'mainnet' || forced === 'testnet' ? forced : null;
};

const noteKey = (note: NoteId): string => `${note.pool}:${note.txid}:${note.outputIndex}`;

const sameNote = (a: NoteId, b: NoteId): boolean =>
  a.pool === b.pool && a.txid === b.txid && a.outputIndex === b.outputIndex;

/** Unspent notes the user has not Excluded. Transparent notes stay out while
 * transparent sends are off — the Send screen already refuses those inputs. */
const allowedNoteKeys = (inventory: readonly EngineNote[], excludedIds: readonly NoteId[]): Set<string> => {
  const blocked = new Set(excludedIds.map(noteKey));
  const allowed = new Set<string>();
  for (const note of inventory) {
    if (note.spendState !== 'unspent') continue;
    if (!ALLOW_TRANSPARENT_SENDS && note.id.pool === 'transparent') continue;
    const key = noteKey(note.id);
    if (blocked.has(key)) continue;
    allowed.add(key);
  }
  return allowed;
};

/** True when a chain input spends a note outside the selection. The SDK has
 * no forced-inputs API, so this is the check instead of a selector argument.
 * A prior-step input has no note id and is not a user note. */
const proposalDeviates = (proposal: EngineProposal, allowed: ReadonlySet<string>): boolean =>
  proposal.steps.some((step) =>
    step.inputs.some((input) => input.note !== undefined && !allowed.has(noteKey(input.note))),
  );

export const createWalletApp = (deps: WalletAppDeps): WalletApp => {
  const screen = atom<Screen>('booting');
  const network = atom<NetworkId>(networkFromQuery() ?? 'mainnet');
  const endpoint = atom<string>(deps.endpoints[network.get()]);
  const walletInfo = atom<WalletInfo | null>(null);
  const balances = atom<EngineBalance | null>(null);
  const sync = atom<EngineSyncStatus | null>(null);
  /** Scanned account's first-scan height: the progress bar's lower bound. */
  const birthday = atom<number | null>(null);
  const syncProgress = computed([sync, birthday], (s, b) => (s === null ? null : { ...s, birthday: b }));
  const address = atom<string | null>(null);
  const pendingCount = atom<number>(0);
  const recovered = atom<boolean>(false);
  const canSpend = atom<boolean>(false);
  const backupPending = atom<boolean>(false);
  const creating = atom<boolean>(false);
  const bootError = atom<string | null>(null);
  const send = atom<SendView>({ phase: 'closed' });
  const shield = atom<ShieldView>({ phase: 'closed' });
  /** Mandatory Exposed Address list (ADR-0004); rebuilt by observeHistory. */
  const exposedAddresses = atom<readonly ExposedAddress[]>([]);
  /** Exclude set for the open Wallet. The registry row is the durable copy. */
  const excluded = atom<readonly NoteId[]>([]);
  const excludedCount = computed(excluded, (list) => list.length);
  const notes = atom<readonly NoteRow[]>([]);

  // --- Session/Lock atoms (issue #6) --------------------------------------
  const unlocked = atom<boolean>(false);
  const unlockDeadline = atom<number | null>(null);
  const hasVault = atom<boolean>(false);
  /** Ms remaining until auto-Lock; recomputed every tick (countdown chip). */
  const autoLockInMs = atom<number | null>(null);

  const traceSecret = deps.traceSecret ?? (() => undefined);

  let wallet: EngineWallet | null = null;
  /** Proposal the review screen is holding. send() uses this id and no other. */
  let held: EngineProposal | null = null;
  /** Whether `held` spends outside the selection, and whether that was accepted. */
  let heldDeviation = false;
  let heldAccepted = false;
  let openSeq = 0;
  let createPhrase: string | null = null;
  let backupConfirmed = false;
  /** Custody choice awaiting the create's success (issue #6). Survives a
   * SYNC_REQUIRED retry and the continue-after-tip path so the vault store +
   * mirror happen exactly once, when the account lands. */
  let pendingChoice: RememberChoice | null = null;
  /** Client whose sync stream is already subscribed. */
  let syncArmed: EngineWallet | null = null;
  /** ADR-0004 rotation state, one lifetime per open (finishOpen re-seeds it;
   * the open is the only way it is ever entered): txids already classified —
   * so one landing transfer advances the display
   * exactly once — and per-address received amounts seen this session. */
  let observedTxids = new Set<string>();
  let receivedByAddress = new Map<string, bigint>();
  /** Id of a create that is on screen but not registered yet. */
  let pendingWalletId: string | null = null;

  const resetStores = (): void => {
    walletInfo.set(null);
    balances.set(null);
    sync.set(null);
    birthday.set(null);
    address.set(null);
    exposedAddresses.set([]);
    pendingCount.set(0);
    recovered.set(false);
    canSpend.set(false);
    bootError.set(null);
    held = null;
    heldDeviation = false;
    heldAccepted = false;
    excluded.set([]);
    notes.set([]);
    send.set({ phase: 'closed' });
    unlocked.set(false);
    unlockDeadline.set(null);
    autoLockInMs.set(null);
    hasVault.set(false);
  };

  const closeWallet = async (): Promise<void> => {
    openSeq += 1; // invalidate in-flight opens and watch loops
    stopAutoLock();
    const op = held?.operationId ?? null;
    held = null;
    heldDeviation = false;
    heldAccepted = false;
    send.set({ phase: 'closed' });
    const w = wallet;
    wallet = null;
    syncArmed = null;
    if (w !== null && op !== null) await w.abandon(op).catch(() => undefined);
    if (w !== null) await w.close();
  };

  /** v1 rule: one default account per Wallet; switcher UI is #11. */
  const defaultAccount = async (w: EngineWallet): Promise<EngineAccount | undefined> =>
    (await w.accounts())[0];

  const paintNotes = (inventory: readonly EngineNote[]): void => {
    const ids = excluded.get();
    notes.set(
      inventory.map((note) => ({
        id: note.id,
        value: note.value,
        spendState: note.spendState,
        locked: note.locked,
        address: note.address,
        excluded: ids.some((id) => sameNote(id, note.id)),
      })),
    );
  };

  /** Re-read inventory. A failed read leaves the previous rows; the count
   * still comes from the registry, not from this list. */
  const refreshNotes = async (w: EngineWallet, accountId: string): Promise<void> => {
    try {
      const [shielded, utxos] = await Promise.all([w.listNotes(accountId), w.listUtxos(accountId)]);
      if (wallet !== w) return;
      paintNotes([...shielded, ...utxos]);
    } catch {
      // stale inventory; Exclude count is independent of this read
    }
  };

  const writeExcluded = async (next: readonly NoteId[]): Promise<void> => {
    const info = walletInfo.get();
    if (info === null) return;
    excluded.set(next);
    notes.set(notes.get().map((row) => ({ ...row, excluded: next.some((id) => sameNote(id, row.id)) })));
    const rec = await deps.registry.get(info.id);
    if (rec === null) return;
    await deps.registry.add({ ...rec, excludedNotes: next });
  };

  const onNotes = {
    async refresh(): Promise<void> {
      if (wallet === null) return;
      const account = await defaultAccount(wallet);
      if (account === undefined) return;
      await refreshNotes(wallet, account.id);
    },
    async exclude(id: NoteId): Promise<void> {
      if (excluded.get().some((note) => sameNote(note, id))) return;
      await writeExcluded([...excluded.get(), id]);
    },
    async include(id: NoteId): Promise<void> {
      await writeExcluded(excluded.get().filter((note) => !sameNote(note, id)));
    },
    async reset(): Promise<void> {
      await writeExcluded([]);
    },
  };

  /** Identified inputs outside the current unspent, non-excluded selection.
   * Inventory failure fails closed: every identified input is a deviation. */
  const selectionDeviates = async (
    w: EngineWallet,
    accountId: string,
    proposal: EngineProposal,
  ): Promise<boolean> => {
    let inventory: readonly EngineNote[] = [];
    try {
      const [shielded, utxos] = await Promise.all([w.listNotes(accountId), w.listUtxos(accountId)]);
      inventory = [...shielded, ...utxos];
    } catch {
      inventory = [];
    }
    return proposalDeviates(proposal, allowedNoteKeys(inventory, excluded.get()));
  };

  const refreshOperations = async (): Promise<void> => {
    if (wallet === null) return;
    const ops = await wallet.listOperations();
    pendingCount.set(ops.filter((o) => isNonTerminal(o.phase)).length);
  };

  /**
   * ADR-0004: one classification pass over history the Wallet has not
   * observed YET this open. For every unseen entry: a Shielding is never an
   * inbound (own transparent→shielded move). A non-self output (not change,
   * not sent by one of our accounts — the SDK only reports sender ids from
   * THIS wallet DB) landing on one of our Exposed Addresses credits that
   * address's received amount; landing on the DISPLAYED address additionally
   * rotates: mint exactly once and advance. Dedup via `observedTxids` is what
   * makes "advances exactly once" true across ticks AND reloads (after a
   * rotation, current() is the fresh address, so the old inbound no longer
   * matches it). A boot pass classifies pre-existing history (deeper limit:
   * payments seen while closed need not be in the newest 20): it credits
   * amounts and rotates only if a rotation was still pending when the page
   * closed — never on a wallet whose last session already advanced.
   * An entry whose wallet transaction is not readable yet (a fresh block
   * outruns the local tx database) stays UNobserved so a later tick retries
   * it — but only when skipping cannot strand an owed rotation: if the
   * unreadable transaction might pay the displayed address, commit the
   * rotation NOW (mint once, never re-credit on the retry) rather than lose
   * the advance forever. Read failures are swallowed like watchLoop's: a bad
   * tick shows stale state, but each seen txid stays marked (one mint per
   * observed transfer, never a casual burn on retry).
   */
  const observeHistory = async (w: EngineWallet, account: EngineAccount, limit = 20): Promise<void> => {
    try {
      const exposed = [...(await w.listAddresses(account.id))];
      const history = await w.getHistory(account.id, limit);
      let displayed = address.get();
      for (const entry of history) {
        if (observedTxids.has(entry.txid)) continue;
        if (entry.isShielding === true) {
          observedTxids.add(entry.txid);
          continue;
        }
        const outputs = await w.listTransactionOutputs(entry.txid);
        // Empty is unread, not classified: `[].every(...)` is vacuously true,
        // and getTransaction is null until the local tx database catches up.
        const complete = outputs.length > 0 && outputs.every((o) => o.address !== null && o.value !== null);
        let inboundHere = false;
        const credits: { address: string; value: bigint }[] = [];
        for (const o of outputs) {
          if (o.address === null || o.value === null) continue;
          // Only our exposed addresses can receive; the payer's own change
          // never counts — neither as "received" nor as a reason to rotate.
          if (!exposed.includes(o.address)) continue;
          if (o.isChange === true || o.sentFromThisWallet) continue;
          credits.push({ address: o.address, value: o.value });
          if (displayed !== null && o.address === displayed) inboundHere = true;
        }
        if (!complete && !inboundHere) continue; // enhancement pending; retry
        observedTxids.add(entry.txid);
        for (const c of credits) {
          receivedByAddress.set(c.address, (receivedByAddress.get(c.address) ?? 0n) + c.value);
        }
        if (inboundHere && !account.viewOnly) {
          const next = await w.mintAddress(account.id);
          exposed.push(next);
          displayed = next;
          // Advance NOW, not after the loop: the mint is already durable, so
          // a later entry failing must never strand the display behind the
          // chain index it just burned. A superseded open owns stores now.
          if (wallet === w) address.set(displayed);
        }
      }
      if (wallet !== w) return; // superseded mid-await; the new open owns stores
      exposedAddresses.set(exposed.map((a) => ({ address: a, receivedZats: receivedByAddress.get(a) ?? 0n })));
    } catch {
      // stale or failed classification read: display stays as-is; txids
      // already marked stay marked, so the next tick retries only what is
      // still unobserved — and a retried mint can never double-advance.
    }
  };

  /** Watch the sync stream; refresh displayed state per progress tick. */
  const watchLoop = async (w: EngineWallet): Promise<void> => {
    try {
      for await (const status of w.watchSync()) {
        if (wallet !== w) break;
        sync.set(status);
        if (status.targetReached) continueCreateAfterTip();
        await refreshOperations();
        const account = await defaultAccount(w);
        if (account !== undefined) {
          birthday.set(account.birthdayHeight);
          const raw = await w.getBalance(account.id);
          const prev = balances.get();
          const unscanned = raw.transparent === null && raw.sapling === null && raw.ironwood === null;
          const showingZero = prev?.transparent === 0n && prev.sapling === 0n && prev.ironwood === 0n;
          // Keep the new-wallet zero until a scan reports a real figure.
          balances.set(unscanned && showingZero ? prev : raw);
          // ADR-0004: each scan-revision tick classifies newly discovered
          // transfers; one landing on the displayed address advances it
          // exactly once (observedTxids dedupe).
          await observeHistory(w, account);
          await refreshNotes(w, account.id);
        }
      }
    } catch {
      // closed or superseded; the next open owns the stores now
    }
  };

  /** `getSyncStatus()` answers while the scan runs; `watchSync` publishes only
   * on scan-revision commits (spike §Sync), so without this poll the bar would
   * sit at "—" for minutes on a long scan. Owns only the sync store: balances
   * and operations stay on the watch stream. Stops at the tip; a failed read
   * is not fatal (the next tick retries). */
  const pollLoop = async (w: EngineWallet): Promise<void> => {
    for (;;) {
      if (wallet !== w || sync.get()?.targetReached === true) return;
      try {
        const status = await w.syncStatus();
        if (wallet !== w) return;
        if (!sameSync(sync.get(), status)) sync.set(status);
        if (status.targetReached) continueCreateAfterTip();
      } catch {
        // transient engine read; retry on the next tick
      }
      await delay(SYNC_POLL_MS);
    }
  };

  // --- Auto-Lock timer (issue #6) -----------------------------------------
  // 10 activity-idle minutes. Send attempts count as activity; watching sync
  // does NOT (the spec is explicit). The countdown chip reads autoLockInMs.
  let autoLockTimer: ReturnType<typeof setInterval> | null = null;
  let autoLockSeq = 0;

  /** Reset the idle deadline to now + AUTO_LOCK_MS. Called on Unlock and on
   * every send attempt (review/confirm). Sync ticks deliberately do not call
   * this. The boot rule reads the PERSISTED deadline, so an activity bump
   * rewrites the mirror too — otherwise a reload would lock a session the
   * spec says activity extended. */
  const touchIdle = (): void => {
    if (!unlocked.get()) return;
    const deadline = Date.now() + AUTO_LOCK_MS;
    unlockDeadline.set(deadline);
    autoLockInMs.set(AUTO_LOCK_MS);
    const mirror = readMirror();
    const info = walletInfo.get();
    if (mirror !== null && info !== null && mirror.id === info.id) {
      writeMirror({ ...mirror, deadline });
    }
  };

  const stopAutoLock = (): void => {
    autoLockSeq += 1; // invalidate any in-flight tick
    if (autoLockTimer !== null) {
      clearInterval(autoLockTimer);
      autoLockTimer = null;
    }
  };

  const startAutoLock = (): void => {
    stopAutoLock();
    if (!unlocked.get()) return;
    const seq = autoLockSeq;
    autoLockTimer = setInterval(() => {
      if (seq !== autoLockSeq || !unlocked.get()) return;
      const deadline = unlockDeadline.get();
      if (deadline === null) return;
      const remaining = deadline - Date.now();
      autoLockInMs.set(remaining > 0 ? remaining : 0);
      if (remaining <= 0) void lock();
    }, 1000);
  };

  /**
   * Finish opening a wallet whose Client is live: recovery is complete
   * (it ran inside open), serve balances from the LOCAL DB, then start sync.
   */
  const finishOpen = async (w: EngineWallet, record: WalletRecord, showZeroUntilScan = false): Promise<void> => {
    wallet = w;
    // ADR-0004 rotation state belongs to exactly one open. The create path
    // arrives here without resetStores, so the clear lives here too.
    observedTxids = new Set();
    receivedByAddress = new Map();
    exposedAddresses.set([]);
    recovered.set(true);
    walletInfo.set({
      id: record.id,
      name: record.name,
      fingerprint: record.fingerprint,
      kind: record.kind,
    });
    excluded.set(record.excludedNotes ?? []);
    canSpend.set(false); // set below after the session check decides unlocked
    const account = await defaultAccount(w);
    if (account !== undefined) {
      birthday.set(account.birthdayHeight);
      const raw = await w.getBalance(account.id);
      // A brand-new seed has no notes. Null pool fields mean "not scanned
      // yet", so the main page shows zero instead of an empty dash.
      const unscanned = raw.transparent === null && raw.sapling === null && raw.ironwood === null;
      balances.set(
        showZeroUntilScan && unscanned
          ? { accountId: raw.accountId, transparent: 0n, sapling: 0n, ironwood: 0n, scanned: false }
          : raw,
      );
      const current = await w.currentAddress(account.id);
      // A view-only account cannot mint (the SDK has no spend key to derive
      // the next shielded address from); the current one is the truth.
      address.set(current ?? (account.viewOnly ? null : await w.mintAddress(account.id)));
      // Classify local history BEFORE the first sync tick: a payment that
      // landed while the page was closed rotates now, exactly once — after
      // the mint, current() IS the fresh address, so a reload never burns a
      // second index for the same transfer. Deeper than a tick's 20: a
      // payment received while closed need not be inside the newest 20.
      await observeHistory(w, account, 100);
      await refreshNotes(w, account.id);
      await refreshOperations();
    }
    // Subscribe BEFORE triggering sync: the SDK stream only publishes on
    // scan-revision changes, so ticks fired between start and subscribe
    // would be lost (spike §Sync). A create already armed this client.
    if (syncArmed !== w) {
      syncArmed = w;
      void watchLoop(w);
      void pollLoop(w);
      await w.startSync();
    }
    await deps.registry.touch(record.id);
    screen.set('wallet');
    // Session/Lock boot check (issue #6): the ONLY unlock guarantee. A valid
    // mirror re-attaches the signer from already-decrypted bytes (NOT a
    // decrypt — the mirror is plaintext in sessionStorage). A Lock flag or an
    // expired deadline forces a passphrase prompt. View-only has no machinery.
    await restoreSession(w, record);
    await resumeStoredSeed(w, record);
  };

  /**
   * Boot order per issue #3 — registry → open last-used Wallet → await
   * startup recovery (inside open) → balances from local DB → start sync.
   */
  const openWallet = async (record: WalletRecord): Promise<void> => {
    const seq = openSeq;
    screen.set('booting');
    resetStores();
    const w = await deps.engine.open({
      network: record.network,
      endpoint: deps.endpoints[record.network],
      storageName: storageName(record.network, record.id),
      allowTransparentSends: ALLOW_TRANSPARENT_SENDS,
    });
    if (seq !== openSeq) {
      await w.close(); // superseded by a newer open (network switch)
      return;
    }
    await finishOpen(w, record);
  };

  const boot = async (opts?: { restoreLatest?: boolean }): Promise<void> => {
    screen.set('booting');
    bootError.set(null); // a clean boot must not keep the previous failure on screen
    try {
      // A plain reload has no ?network=. Open the wallet the user last had,
      // whichever network it is on. An in-session switch passes no flag and
      // keeps the network it just set.
      if (opts?.restoreLatest === true && networkFromQuery() === null) {
        const recent = await deps.registry.mostRecent();
        if (recent !== null) network.set(recent.network);
        else {
          const pref = readNetworkPref();
          if (pref !== null) network.set(pref);
        }
      }
      endpoint.set(deps.endpoints[network.get()]);
      const last = await deps.registry.lastUsed(network.get());
      if (last === null) {
        await closeWallet();
        screen.set('welcome');
        return;
      }
      await openWallet(last);
    } catch (e) {
      // Registry (IndexedDB) failures land here too: never reject boot()
      // into the void — surface honestly and stay on a usable screen.
      if (e instanceof EngineError && e.code === 'STORAGE_BUSY') {
        screen.set('storage-busy');
        return;
      }
      bootError.set(e instanceof Error ? e.message : String(e));
      screen.set('welcome');
    }
  };

  const setNetwork = async (next: NetworkId): Promise<void> => {
    if (next === network.get()) return;
    writeNetworkPref(next);
    network.set(next);
    endpoint.set(deps.endpoints[next]);
    await closeWallet();
    await boot();
  };

  const openSettings = (): void => {
    const current = screen.get();
    if (current !== 'welcome' && current !== 'wallet') return;
    screen.set('settings');
  };

  const closeSettings = (): void => {
    if (screen.get() !== 'settings') return;
    screen.set(wallet !== null ? 'wallet' : 'welcome');
  };

  /**
   * Remove the open Wallet for good (Settings → Remove Wallet). Order is the
   * invariant: close the client FIRST (releases the exclusive OPFS lease —
   * removeEntry fails while a live client holds the wallet DB), then drop the
   * registry row, then erase the per-Wallet storage (ADR-0003). Failure
   * paths reopen what is still intact and stay on Settings so the error is
   * shown; only full success lands on welcome.
   */
  const removeWallet = async (): Promise<ImportResult> => {
    const info = walletInfo.get();
    if (info === null)
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'No Wallet is open to remove.' };
    const record = await deps.registry.get(info.id).catch(() => null);
    const name = storageName(record?.network ?? network.get(), info.id);
    try {
      await closeWallet();
    } catch (e) {
      return asResult(e);
    }
    /** Best-effort reopen after a failed step: the client is closed, so the
     * stores must point at a live client again or the screen is a lie. */
    const restore = async (reRegister: boolean): Promise<void> => {
      if (record === null) {
        screen.set('welcome');
        return;
      }
      if (reRegister && (await deps.registry.add(record).catch(() => null)) === null) {
        screen.set('welcome');
        return;
      }
      await openWallet(record).catch(() => undefined);
      screen.set(wallet !== null ? 'settings' : 'welcome');
    };
    try {
      await deps.registry.remove(info.id);
    } catch (e) {
      await restore(false); // row survived the failed delete
      return asResult(e);
    }
    try {
      await deps.engine.removeStorage(name);
    } catch (e) {
      await restore(true); // storage intact (e.g. lease held elsewhere): row back, reopen
      return asResult(e);
    }
    // Vault envelope for this Wallet is gone too (issue #6): nothing of the
    // user's seed survives Forget. Already-gone is success.
    await deps.vault.remove(info.id).catch(() => undefined);
    resetStores();
    screen.set('welcome');
    return { ok: true };
  };

  /** Shared create/restore/import tail: open a FRESH-id client, materialize
   * the account via `run` (returns the fingerprint source: UFVK or viewing
   * key), register the row, and boot the just-opened client. */
  const createWalletFlow = async (args: {
    name: string;
    kind: WalletKind;
    run: (w: EngineWallet) => Promise<string>;
  }): Promise<ImportResult> => {
    const id = crypto.randomUUID();
    // Capture the active Network ONCE: a setNetwork landing mid-flow must not
    // relabel this Wallet's record onto the other network — the client below
    // stays bound to the network it was opened with.
    const net = network.get();
    // Session token: any closeWallet() (i.e. network switch) bumps openSeq.
    // Landing after a bump means the switch owns the screen now, not us.
    const seq = openSeq;
    let w: EngineWallet | null = null;
    try {
      w = await deps.engine.open({
        network: net,
        endpoint: deps.endpoints[net],
        storageName: storageName(net, id),
        allowTransparentSends: ALLOW_TRANSPARENT_SENDS,
      });
      // accounts.create requires coherent local chain state (SDK: stale =>
      // SYNC_REQUIRED before mutation, "after explicit sync"). Bounded
      // freshness pass first; one retry covers the live tip race (spike S1d).
      await w.syncFresh(FRESHNESS_TIMEOUT_MS);
      let fingerprintSource: string;
      try {
        fingerprintSource = await args.run(w);
      } catch (e) {
        if (!(e instanceof EngineError) || e.code !== 'SYNC_REQUIRED') throw e;
        await w.syncFresh(FRESHNESS_TIMEOUT_MS);
        fingerprintSource = await args.run(w);
      }
      const fingerprint = await fingerprintFromUfvk(fingerprintSource);
      await deps.requestPersist();
      const record: WalletRecord = {
        id,
        network: net,
        name: args.name,
        fingerprint,
        kind: args.kind,
        lastUsed: Date.now(),
      };
      await deps.registry.add(record);
      if (seq !== openSeq) {
        // A network switch landed mid-flow: that session owns the screen and
        // the stores. This Wallet is registered and its data lives in its own
        // per-Wallet DB (ADR-0003): close our client, leave theirs untouched.
        await w.close();
        return { ok: true };
      }
      await closeWallet();
      wallet = w;
      await finishOpen(w, record);
      return { ok: true };
    } catch (e) {
      // Past closeWallet() the module pointer names THIS client; if a late
      // step (registry.add, finishOpen) throws, never leave it dangling at
      // the closed client we are about to close below.
      if (wallet === w) wallet = null;
      if (w !== null) await w.close();
      return asResult(e);
    }
  };

  /** Main page for a seed the user just saved. Balance is zero until a scan says otherwise. */
  const presentNewWallet = (w: EngineWallet, id: string): void => {
    wallet = w;
    walletInfo.set({ id, name: 'wallet', fingerprint: '', kind: 'seed' });
    canSpend.set(false);
    balances.set({ accountId: id, transparent: 0n, sapling: 0n, ironwood: 0n, scanned: false });
    address.set(null);
    const cur = sync.get();
    sync.set({
      activity: 'running',
      scanned: cur?.scanned ?? null,
      target: cur?.target ?? null,
      targetReached: false,
      scanComplete: cur?.scanComplete ?? null,
    });
    screen.set('wallet');
  };

  const armSync = async (w: EngineWallet, restart = false): Promise<void> => {
    if (syncArmed !== w) {
      syncArmed = w;
      void watchLoop(w);
      void pollLoop(w);
      await w.startSync();
      return;
    }
    if (restart) await w.startSync();
  };

  /**
   * Open (or reuse) the client, show the main page, then create the account
   * once the chain is fresh enough. A stuck sync stays on that page.
   */
  let tipContinueStarted = false;

  /** Finish account creation once the scan has reached the tip. */
  const continueCreateAfterTip = (): void => {
    if (tipContinueStarted || creating.get() || !backupPending.get() || createPhrase === null) return;
    if (sync.get()?.targetReached !== true) return;
    tipContinueStarted = true;
    const phrase = createPhrase;
    const bytes = phraseBytes(phrase);
    traceSecret(bytes);
    void createSeedWallet(bytes, false, phrase, pendingChoice).finally(() => zeroize(bytes));
  };

  /**
   * A reload opens the saved shell before the account exists. The phrase from
   * this tab is still in sessionStorage, so creation can finish.
   */
  const resumeStoredSeed = async (w: EngineWallet, record: WalletRecord): Promise<void> => {
    const pending = readPendingSeed();
    if (pending === null || pending.id !== record.id) return;
    if ((await w.accounts()).length > 0) {
      clearPendingSeed();
      return;
    }
    createPhrase = pending.phrase;
    backupConfirmed = false;
    backupPending.set(true);
    // A reload-resume honors the stored custody choice (Remember → store the
    // envelope + mirror; Never-store → no mirror). A pendingChoice from the
    // same in-memory session wins; otherwise the persisted one does. The
    // envelope re-store is idempotent.
    const storedChoice: RememberChoice | null =
      pending.remember === true && pending.vaultPassphrase !== undefined
        ? { remember: true, vaultPassphrase: pending.vaultPassphrase }
        : null;
    const choice: RememberChoice = pendingChoice ?? storedChoice ?? { remember: await deps.vault.has(record.id) };
    const bytes = phraseBytes(pending.phrase);
    traceSecret(bytes);
    try {
      await createSeedWallet(bytes, false, pending.phrase, choice);
    } finally {
      zeroize(bytes);
    }
  };

  // --- Session restore + Unlock/Lock (issue #6) ----------------------------
  /** Boot-time unlock check: the ONLY guarantee. A valid mirror re-attaches
   * the signer from already-decrypted bytes; a Lock flag or expired deadline
   * leaves the Wallet locked (passphrase or phrase path required). */
  const restoreSession = async (w: EngineWallet, record: WalletRecord): Promise<void> => {
    stopAutoLock();
    unlocked.set(false);
    unlockDeadline.set(null);
    autoLockInMs.set(null);
    hasVault.set(false);
    if (record.kind !== 'seed') return; // view-only: no Unlock machinery
    hasVault.set(await deps.vault.has(record.id));
    const locked = readLockFlag();
    const mirror = readMirror();
    const now = Date.now();
    if (mirror !== null && mirror.id === record.id && mirror.deadline <= now) {
      // An expired mirror is stale plaintext with no future use: remove it
      // rather than leaving the seed readable in a locked session.
      clearMirror();
    }
    if (mirror !== null && mirror.id === record.id && mirror.deadline > now && !locked) {
      const account = await defaultAccount(w);
      if (account === undefined) return;
      const bytes = phraseBytes(mirror.phrase);
      traceSecret(bytes);
      try {
        await w.attachSigner({ accountId: account.id, mnemonic: bytes });
        unlocked.set(true);
        unlockDeadline.set(mirror.deadline);
        autoLockInMs.set(mirror.deadline - now);
        startAutoLock();
      } catch {
        // A mirror that fails to attach is no longer trustworthy: drop it so
        // the user is prompted for a passphrase rather than retrying bad bytes.
        clearMirror();
      } finally {
        zeroize(bytes);
      }
    }
    canSpend.set(record.kind === 'seed' && unlocked.get() && recovered.get());
  };

  /** App-wide Lock (issue #6): detach the signer, zeroize the mirror, set the
   * Lock flag. Viewing continues. The flag survives reload until the next Unlock. */
  const lock = async (): Promise<void> => {
    stopAutoLock();
    // Drop spend authority before the first await. Shield and send review
    // read the guard synchronously; waiting on detach would let a review
    // that starts after Lock still propose (issue #8).
    clearMirror();
    setLockFlag();
    unlocked.set(false);
    unlockDeadline.set(null);
    autoLockInMs.set(null);
    canSpend.set(false);
    const w = wallet;
    const info = walletInfo.get();
    if (w !== null && info?.kind === 'seed') {
      const account = await defaultAccount(w);
      if (account !== undefined) {
        try {
          await w.detachSigner({ accountId: account.id });
        } catch {
          // best-effort detach; the flag + cleared mirror are the guarantee
        }
      }
    }
  };

  /** Shared Unlock guard: an open seed Wallet plus its default account, or
   * null. All three Unlock paths (Vault passphrase, Never-store phrase,
   * after create/restore) open with the same check. */
  const unlockTarget = async (): Promise<{ w: EngineWallet; info: WalletInfo; account: EngineAccount } | null> => {
    const w = wallet;
    const info = walletInfo.get();
    if (w === null || info === null || info.kind !== 'seed') return null;
    const account = await defaultAccount(w);
    if (account === undefined) return null;
    return { w, info, account };
  };

  /** Shared Unlock success: clear the Lock flag, open the session against a
   * fresh idle deadline, and restart the auto-Lock timer. `mirrorPhrase`
   * (Remember custody only) persists the seed mirror; Never-store just sets
   * the deadline, so a reload re-prompts. */
  const markUnlocked = (id: string, mirrorPhrase: string | null): void => {
    clearLockFlag();
    unlocked.set(true);
    const deadline = Date.now() + AUTO_LOCK_MS;
    if (mirrorPhrase !== null) writeMirror({ id, phrase: mirrorPhrase, deadline });
    unlockDeadline.set(deadline);
    autoLockInMs.set(AUTO_LOCK_MS);
    canSpend.set(true);
    startAutoLock();
  };

  /** Unlock via the Vault passphrase (Remember path). Decrypts the envelope,
   * verifies the phrase by attaching the signer (the SDK checks it against
   * the stored viewing key), mirrors the seed, and clears the Lock flag. */
  const unlock = async (passphrase: string): Promise<ImportResult> => {
    const target = await unlockTarget();
    if (target === null) return { ok: false, code: 'UNKNOWN', message: 'no open seed Wallet' };
    const { w, info, account } = target;
    let phrase: string;
    try {
      phrase = await deps.vault.load(info.id, passphrase);
    } catch (e) {
      const code: VaultErrorCode = e instanceof VaultError ? e.code : 'UNKNOWN';
      return { ok: false, code, message: e instanceof Error ? e.message : String(e) };
    }
    const bytes = phraseBytes(phrase);
    traceSecret(bytes);
    try {
      await w.attachSigner({ accountId: account.id, mnemonic: bytes });
      markUnlocked(info.id, phrase);
      return { ok: true };
    } catch (e) {
      return asResult(e);
    } finally {
      zeroize(bytes);
    }
  };

  /** Unlock by re-entering the recovery phrase (Never-store path; no Vault
   * envelope). Verifies via attachSigner; no mirror is written. */
  const unlockWithPhrase = async (phrase: string): Promise<ImportResult> => {
    const target = await unlockTarget();
    if (target === null) return { ok: false, code: 'UNKNOWN', message: 'no open seed Wallet' };
    const { w, account } = target;
    let normalized: string;
    try {
      normalized = normalizePhrase(phrase);
    } catch (e) {
      return { ok: false, code: 'INVALID_MNEMONIC', message: e instanceof Error ? e.message : String(e) };
    }
    const bytes = phraseBytes(normalized);
    traceSecret(bytes);
    try {
      await w.attachSigner({ accountId: account.id, mnemonic: bytes });
      markUnlocked(target.info.id, null);
      return { ok: true };
    } catch (e) {
      return asResult(e);
    } finally {
      zeroize(bytes);
    }
  };

  /** Attach the signer using the phrase still in memory from a create/restore
   * flow, then (Remember) store in vault + mirror, or (Never-store) set the
   * idle deadline only. NOT auto-decrypt — the phrase is in memory from the
   * user's own create/restore action this turn. */
  const unlockAfterCreate = async (phrase: string, choice: RememberChoice | null): Promise<void> => {
    const target = await unlockTarget();
    if (target === null) return;
    const { w, info, account } = target;
    const bytes = phraseBytes(phrase);
    traceSecret(bytes);
    try {
      await w.attachSigner({ accountId: account.id, mnemonic: bytes });
      const remember = choice !== null && choice.remember && choice.vaultPassphrase !== undefined && choice.vaultPassphrase !== '';
      if (remember && choice !== null && choice.vaultPassphrase !== undefined) {
        await deps.vault.store(info.id, phrase, choice.vaultPassphrase);
      }
      hasVault.set(remember);
      markUnlocked(info.id, remember ? phrase : null);
    } catch {
      // best-effort: a failed attach after create leaves the wallet locked;
      // the user can Unlock with the passphrase (Remember) or phrase (Never).
    } finally {
      zeroize(bytes);
    }
  };

  const createSeedWallet = async (bytes: Uint8Array, restartSync = false, phrase = '', choice: RememberChoice | null = null): Promise<ImportResult> => {
    const net = network.get();
    const seq = openSeq;
    let w: EngineWallet | null = wallet;
    creating.set(true);
    try {
      if (w === null) {
        pendingWalletId = crypto.randomUUID();
        w = await deps.engine.open({
          network: net,
          endpoint: deps.endpoints[net],
          storageName: storageName(net, pendingWalletId),
          allowTransparentSends: ALLOW_TRANSPARENT_SENDS,
        });
      }
      const id = pendingWalletId ?? walletInfo.get()?.id ?? crypto.randomUUID();
      pendingWalletId = id;
      // Persist before the scan finishes. A reload would otherwise find no wallet,
      // because the account itself cannot be created until the chain is fresh.
      const prior = await deps.registry.get(id);
      await deps.registry.add({
        id,
        network: net,
        name: prior?.name ?? 'wallet',
        fingerprint: prior?.fingerprint ?? '',
        kind: 'seed',
        lastUsed: Date.now(),
        excludedNotes: prior?.excludedNotes ?? [],
      });
      if (phrase !== '') savePendingSeed(choice ?? pendingChoice ?? { remember: false }, { id, phrase });
      // A network switch that landed while open() was in flight owns the screen.
      const ownsScreen = seq === openSeq && (wallet === null || wallet === w);
      if (ownsScreen) {
        presentNewWallet(w, id);
        await armSync(w, restartSync);
      }
      const run = async (): Promise<string> => {
        const created = await w!.createSeed({ mnemonic: bytes, name: 'wallet' });
        const ufvk = await created.ufvk();
        await created.dispose();
        return ufvk;
      };
      await w.syncFresh(FRESHNESS_TIMEOUT_MS);
      let fingerprintSource: string;
      try {
        fingerprintSource = await run();
      } catch (e) {
        if (!(e instanceof EngineError) || e.code !== 'SYNC_REQUIRED') throw e;
        await w.syncFresh(FRESHNESS_TIMEOUT_MS);
        fingerprintSource = await run();
      }
      const fingerprint = await fingerprintFromUfvk(fingerprintSource);
      await deps.requestPersist();
      const record: WalletRecord = {
        id,
        network: net,
        name: 'wallet',
        fingerprint,
        kind: 'seed',
        lastUsed: Date.now(),
        excludedNotes: (await deps.registry.get(id))?.excludedNotes ?? [],
      };
      await deps.registry.add(record);
      clearPendingSeed();
      createPhrase = null;
      // The switch kept its own client. Register this wallet, then close it
      // instead of taking over the screen.
      if (wallet !== w) {
        await w.close();
      } else {
        await finishOpen(w, record, true);
      }
      // Unlock-after-create (issue #6): the phrase is in memory from the flow,
      // so attach the signer now (NOT auto-decrypt — this is the create itself).
      // Remember → store in vault + mirror; Never-store → session-only, no mirror.
      if (phrase !== '' && wallet === w) {
        await unlockAfterCreate(phrase, choice ?? pendingChoice);
      }
      backupConfirmed = true;
      createPhrase = null;
      pendingChoice = null;
      pendingWalletId = null;
      backupPending.set(false);
      return { ok: true };
    } catch (e) {
      const res = asResult(e);
      if (res.code === 'SYNC_REQUIRED' && w !== null && wallet === w) {
        const cur = sync.get();
        // No height yet means the scan never started reporting. Say so on the
        // main page. A live progress report is left alone.
        if (cur === null || (cur.scanned === null && cur.targetReached !== true)) {
          sync.set({
            activity: 'failed',
            scanned: cur?.scanned ?? null,
            target: cur?.target ?? null,
            targetReached: false,
            scanComplete: false,
          });
        }
        queueMicrotask(() => continueCreateAfterTip());
        return res;
      }
      if (pendingWalletId !== null) {
        clearPendingSeed();
        await deps.registry.remove(pendingWalletId).catch(() => undefined);
      }
      if (w !== null && wallet === w) await closeWallet();
      else if (w !== null) await w.close();
      pendingWalletId = null;
      if (wallet === null && screen.get() === 'wallet') screen.set('welcome');
      return res;
    } finally {
      creating.set(false);
    }
  };

  const onCreate = {
    /** Idempotent while the gate is pending: re-issue the SAME phrase, so
     * re-clicking Create can neither spawn a second session nor lose the
     * gate (#4: cannot dismiss). */
    async generate(): Promise<CreateSession> {
      if (createPhrase !== null) return { phrase: createPhrase };
      const phrase = generatePhrase();
      createPhrase = phrase;
      backupConfirmed = false;
      backupPending.set(true);
      return { phrase };
    },
    /**
     * Forced backup gate: only the phrase that re-matches the generated one
     * creates + registers + opens the Wallet. The main page appears as soon
     * as the phrase is accepted, with a zero balance and live sync progress.
     */
    async confirmBackup(phrase: string, choice?: RememberChoice): Promise<ImportResult> {
      if (backupConfirmed) return { ok: true }; // idempotent double-tap
      if (createPhrase === null) return { ok: false, code: 'UNKNOWN', message: 'no phrase in flight' };
      if (choice?.remember === true && (choice.vaultPassphrase === undefined || choice.vaultPassphrase === ''))
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'Remember on this device requires a passphrase' };
      let normalized: string;
      try {
        normalized = normalizePhrase(phrase);
      } catch (e) {
        return { ok: false, code: 'INVALID_MNEMONIC', message: e instanceof Error ? e.message : String(e) };
      }
      if (normalized !== createPhrase) {
        return { ok: false, code: 'INVALID_MNEMONIC', message: 'phrase mismatch' };
      }
      pendingChoice = choice ?? { remember: false };
      const bytes = phraseBytes(normalized);
      traceSecret(bytes);
      try {
        return await createSeedWallet(bytes, false, normalized, pendingChoice);
      } finally {
        zeroize(bytes);
      }
    },
    async resume(): Promise<ImportResult> {
      if (backupConfirmed) return { ok: true };
      if (createPhrase === null) return { ok: false, code: 'UNKNOWN', message: 'no phrase in flight' };
      const bytes = phraseBytes(createPhrase);
      traceSecret(bytes);
      try {
        return await createSeedWallet(bytes, true, createPhrase, pendingChoice);
      } finally {
        zeroize(bytes);
      }
    },
  };

  const onRestore = {
    async restore(args: {
      phrase: string;
      passphrase?: string;
      accountIndex: number;
      birthday: RestoreBirthday;
      name?: string;
      custody?: RememberChoice;
    }): Promise<ImportResult> {
      // #4: a pending forced-backup gate blocks every other onboarding path.
      if (backupPending.get())
        return { ok: false, code: 'GATE_PENDING', message: 'Confirm your backup phrase first — it cannot be left pending.' };
      if (!Number.isInteger(args.accountIndex) || args.accountIndex < 0)
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'Account index must be a whole number ≥ 0' };
      if (!validBirthday(args.birthday))
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'Birthday height must be a whole number ≥ 1' };
      if (args.custody?.remember === true && (args.custody.vaultPassphrase === undefined || args.custody.vaultPassphrase === ''))
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'Remember on this device requires a passphrase' };
      let phrase: string;
      try {
        phrase = normalizePhrase(args.phrase);
      } catch (e) {
        return { ok: false, code: 'INVALID_MNEMONIC', message: e instanceof Error ? e.message : String(e) };
      }
      const name = args.name ?? 'restored';
      const choice: RememberChoice = args.custody ?? { remember: false };
      const bytes = phraseBytes(phrase);
      const pass = args.passphrase === undefined || args.passphrase === '' ? undefined : phraseBytes(args.passphrase);
      traceSecret(bytes);
      if (pass !== undefined) traceSecret(pass);
      try {
        const result = await createWalletFlow({
          name,
          kind: 'seed',
          run: async (w) => {
            const birthday =
              args.birthday === 'fullScan' ? ('fullScan' as const) : await w.resolveBirthday(args.birthday.height);
            const created = await w.importSeed({
              mnemonic: bytes,
              ...(pass !== undefined ? { passphrase: pass } : {}),
              accountIndex: args.accountIndex,
              birthday,
              name,
            });
            const ufvk = await created.ufvk();
            await created.dispose();
            return ufvk;
          },
        });
        // Unlock-after-restore (issue #6): same path as create. The phrase is
        // in memory from the restore action; attach + (Remember) vault + mirror.
        if (result.ok && wallet !== null) {
          await unlockAfterCreate(phrase, choice);
        }
        return result;
      } finally {
        zeroize(bytes);
        if (pass !== undefined) zeroize(pass);
      }
    },
  };

  const onViewOnly = {
    async import(args: { viewingKey: string; birthday: RestoreBirthday; name?: string }): Promise<ImportResult> {
      if (backupPending.get())
        return { ok: false, code: 'GATE_PENDING', message: 'Confirm your backup phrase first — it cannot be left pending.' };
      const viewingKey = args.viewingKey.trim();
      if (viewingKey.length === 0)
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'Viewing key is required' };
      if (!validBirthday(args.birthday))
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'Birthday height must be a whole number ≥ 1' };
      const name = args.name ?? 'view-only';
      return createWalletFlow({
        name,
        kind: 'viewonly',
        run: async (w) => {
          const birthday =
            args.birthday === 'fullScan' ? ('fullScan' as const) : await w.resolveBirthday(args.birthday.height);
          await w.importViewing({ viewingKey, birthday, name });
          return viewingKey;
        },
      });
    },
  };

  interface Draft {
    recipient: string;
    amount: string;
    memo: string;
  }

  const emptyDraft = (): Draft => ({ recipient: '', amount: '', memo: '' });

  const draftView = (draft: Draft): SendDraftView => {
    const recipient = draft.recipient.trim();
    const classified = recipient === '' ? null : classifyAddress(recipient, network.get());
    const memo = draft.memo.trim();
    const transparent = classified?.ok === true && classified.kind === 'transparent';
    return {
      recipient: draft.recipient,
      amount: draft.amount,
      memo: draft.memo,
      memoWarning: memo !== '' && !transparent,
      transparentBlocked: transparent && !ALLOW_TRANSPARENT_SENDS,
    };
  };

  const showForm = (draft: Draft, notice: SendNotice): void => {
    send.set({ phase: 'form', draft: draftView(draft), notice });
  };

  const showReview = (draft: Draft, proposal: EngineProposal, notice: SendNotice): void => {
    send.set({
      phase: 'review',
      draft: draftView(draft),
      proposal,
      notice,
      deviation: heldDeviation,
      accepted: heldAccepted,
    });
  };

  const readDraft = (view: { readonly draft: SendDraftView }): Draft => ({
    recipient: view.draft.recipient,
    amount: view.draft.amount,
    memo: view.draft.memo,
  });

  /** In-flight abandon. A new propose waits on this so input locks are free. */
  let releaseTail: Promise<void> = Promise.resolve();
  let releasesInFlight = 0;

  const releaseHeld = (): Promise<void> => {
    const op = held?.operationId ?? null;
    const current = wallet;
    held = null;
    heldDeviation = false;
    heldAccepted = false;
    if (op === null || current === null) return releaseTail;
    const run = (): Promise<void> => {
      releasesInFlight += 1;
      return current.abandon(op).catch(() => undefined).finally(() => {
        releasesInFlight -= 1;
      });
    };
    // Start now when idle. Chaining through an already-settled promise would
    // defer the engine call a turn, and the next review could race it.
    const job = releasesInFlight === 0 ? run() : releaseTail.then(run);
    releaseTail = job;
    return job;
  };

  const spendGuard = (): SpendGuard => {
    const info = walletInfo.get();
    if (info === null) return { ok: false, reason: 'unavailable' };
    if (info.kind !== 'seed') return { ok: false, reason: 'view-only' };
    if (!recovered.get()) return { ok: false, reason: 'unavailable' };
    if (!unlocked.get()) return { ok: false, reason: 'locked' };
    return { ok: true };
  };

  type Resolved =
    | { readonly ok: true; readonly to: string; readonly amount: bigint; readonly memo?: string }
    | { readonly ok: false; readonly notice: SendNotice };

  const noticeForUri = (error: string): SendNotice => {
    if (error === 'memo-on-transparent') return { kind: 'memo-on-transparent' };
    if (error === 'network-mismatch') return { kind: 'network-mismatch' };
    return { kind: 'invalid-recipient' };
  };

  /** Recipient text, amount text, and memo → the payment propose() will build. */
  const resolveDraft = (draft: Draft): Resolved => {
    let recipient = draft.recipient.trim();
    let amountText = draft.amount.trim();
    let memo = draft.memo.trim();
    if (recipient.startsWith('zcash:')) {
      const uri = parseZip321(recipient, network.get());
      if (!uri.ok) return { ok: false, notice: noticeForUri(uri.error) };
      recipient = uri.address;
      if (uri.amountZats !== null) amountText = formatZats(uri.amountZats);
      if (uri.memo !== null) memo = uri.memo;
    }
    const classified = classifyAddress(recipient, network.get());
    if (!classified.ok) return { ok: false, notice: noticeForUri(classified.error) };
    if (classified.kind === 'transparent') {
      if (!ALLOW_TRANSPARENT_SENDS) return { ok: false, notice: { kind: 'transparent-disabled' } };
      if (memo !== '') return { ok: false, notice: { kind: 'memo-on-transparent' } };
    }
    const amount = parseZecAmount(amountText);
    if (amount === null || amount <= 0n) return { ok: false, notice: { kind: 'invalid-amount' } };
    if (new TextEncoder().encode(memo).length > 512) return { ok: false, notice: { kind: 'memo-too-long' } };
    return { ok: true, to: recipient, amount, ...(memo === '' ? {} : { memo }) };
  };

  const routeEngine = async (error: unknown, draft: Draft, keepProposal: boolean): Promise<void> => {
    if (!(error instanceof EngineError)) {
      await releaseHeld();
      showForm(draft, { kind: 'engine', code: 'UNKNOWN', recovery: 'none' });
      return;
    }
    if (error.recovery === 'sync') {
      await releaseHeld();
      send.set({ phase: 'sync', draft: draftView(draft) });
      return;
    }
    if (error.recovery === 'reattach-signer') {
      send.set({ phase: 'unlock', draft: draftView(draft), notice: null });
      return;
    }
    if (error.recovery === 'review-new-proposal') {
      await releaseHeld();
      showForm(draft, null);
      return;
    }
    const engineNotice: SendNotice = { kind: 'engine', code: error.code, recovery: error.recovery };
    if (keepProposal && held !== null) {
      showReview(draft, held, engineNotice);
      return;
    }
    showForm(draft, engineNotice);
  };

  const editDraft = (next: Draft): void => {
    const phase = send.get().phase;
    if (phase !== 'form' && phase !== 'review') return;
    if (phase === 'review') void releaseHeld();
    showForm(next, null);
  };

  const onSend = {
    async open(): Promise<void> {
      const phase = send.get().phase;
      if (phase !== 'closed' && phase !== 'sent') return;
      if (!spendGuard().ok) return;
      // Form first, so a caller that doesn't await still sees the send draft.
      // Then drop any shield plan: both flows share one held proposal.
      showForm(emptyDraft(), null);
      await onShield.close();
    },
    async close(): Promise<void> {
      await releaseHeld();
      send.set({ phase: 'closed' });
    },
    setRecipient(text: string): void {
      const view = send.get();
      if (view.phase !== 'form' && view.phase !== 'review') return;
      const draft = readDraft(view);
      const trimmed = text.trim();
      if (trimmed.startsWith('zcash:')) {
        const uri = parseZip321(trimmed, network.get());
        if (view.phase === 'review') void releaseHeld();
        if (!uri.ok) {
          showForm({ ...draft, recipient: text }, noticeForUri(uri.error));
          return;
        }
        showForm(
          {
            recipient: uri.address,
            amount: uri.amountZats !== null ? formatZats(uri.amountZats) : draft.amount,
            memo: uri.memo !== null ? uri.memo : draft.memo,
          },
          null,
        );
        return;
      }
      editDraft({ ...draft, recipient: text });
    },
    setAmount(text: string): void {
      const view = send.get();
      if (view.phase !== 'form' && view.phase !== 'review') return;
      editDraft({ ...readDraft(view), amount: text });
    },
    setMemo(text: string): void {
      const view = send.get();
      if (view.phase !== 'form' && view.phase !== 'review') return;
      editDraft({ ...readDraft(view), memo: text });
    },
    async review(): Promise<void> {
      const view = send.get();
      if ((view.phase !== 'form' && view.phase !== 'review') || wallet === null) return;
      const draft = readDraft(view);
      const guard = spendGuard();
      if (!guard.ok) {
        showForm(draft, { kind: guard.reason === 'view-only' ? 'view-only' : guard.reason === 'locked' ? 'locked' : 'unavailable' });
        return;
      }
      // A send attempt counts as activity (issue #6): reset the idle deadline.
      touchIdle();
      const resolved = resolveDraft(draft);
      if (!resolved.ok) {
        if (view.phase === 'review') void releaseHeld();
        showForm(draft, resolved.notice);
        return;
      }
      await releaseHeld();
      const account = await defaultAccount(wallet);
      if (account === undefined) {
        showForm(draft, { kind: 'unavailable' });
        return;
      }
      try {
        const proposal = await wallet.propose({
          accountId: account.id,
          to: resolved.to,
          amount: resolved.amount,
          ...(resolved.memo === undefined ? {} : { memo: resolved.memo }),
        });
        if (proposal.steps.some((step) => step.inputs.some((input) => input.pool === 'transparent'))) {
          held = proposal;
          await releaseHeld();
          showForm(draft, { kind: 'transparent-input' });
          return;
        }
        held = proposal;
        // The engine picked inputs on its own. If one is Excluded (or otherwise
        // outside the selection), the review shows that real plan and confirm
        // waits for an explicit accept. Inventory is read after propose; if the
        // user left or edited the draft during that read, drop the plan instead
        // of painting a review they already dismissed.
        const deviates = await selectionDeviates(wallet, account.id, proposal);
        if (held !== proposal) return;
        const current = send.get();
        if (current.phase !== 'form' && current.phase !== 'review') {
          await releaseHeld();
          return;
        }
        const currentDraft = readDraft(current);
        if (
          currentDraft.recipient !== draft.recipient
          || currentDraft.amount !== draft.amount
          || currentDraft.memo !== draft.memo
        ) {
          await releaseHeld();
          return;
        }
        heldDeviation = deviates;
        heldAccepted = false;
        showReview(draft, proposal, null);
      } catch (error) {
        await routeEngine(error, draft, false);
      }
    },
    async confirm(): Promise<void> {
      const view = send.get();
      if (view.phase !== 'review' || held === null || wallet === null) return;
      // A deviant plan is not consent. The user has to accept the real inputs.
      if (view.deviation && !view.accepted) return;
      const draft = readDraft(view);
      // Broadcasting is a spend attempt → activity (issue #6).
      touchIdle();
      try {
        const result = await wallet.send(held.proposalId);
        held = null;
        heldDeviation = false;
        heldAccepted = false;
        await refreshOperations();
        send.set({ phase: 'sent', txid: result.txid });
      } catch (error) {
        await routeEngine(error, draft, true);
      }
    },
    async unlock(phrase: string): Promise<void> {
      const view = send.get();
      if (view.phase !== 'unlock' || wallet === null) return;
      const draft = readDraft(view);
      let normalized: string;
      try {
        normalized = normalizePhrase(phrase);
      } catch {
        send.set({ phase: 'unlock', draft: view.draft, notice: { kind: 'phrase' } });
        return;
      }
      const bytes = phraseBytes(normalized);
      traceSecret(bytes);
      try {
        const account = await defaultAccount(wallet);
        if (account === undefined) {
          send.set({ phase: 'unlock', draft: view.draft, notice: { kind: 'unavailable' } });
          return;
        }
        await wallet.attachSigner({ accountId: account.id, mnemonic: bytes });
        // The send-path unlock is the Never-store path (no Vault envelope) or
        // a Remember Wallet whose mirror expired: enter the session model so
        // auto-Lock and canSpend track this attach (issue #6). No mirror is
        // written here — the Vault path writes one via app.unlock().
        clearLockFlag();
        unlocked.set(true);
        unlockDeadline.set(Date.now() + AUTO_LOCK_MS);
        autoLockInMs.set(AUTO_LOCK_MS);
        canSpend.set(true);
        startAutoLock();
        touchIdle();
        if (held !== null) showReview(draft, held, null);
        else showForm(draft, null);
      } catch (error) {
        await routeEngine(error, draft, held !== null);
      } finally {
        zeroize(bytes);
      }
    },
    backToForm(): void {
      const view = send.get();
      if (view.phase !== 'sync' && view.phase !== 'unlock') return;
      if (view.phase === 'unlock') void releaseHeld();
      showForm(readDraft(view), null);
    },
    edit(): void {
      const view = send.get();
      if (view.phase !== 'review') return;
      void releaseHeld();
      showForm(readDraft(view), null);
    },
    acceptInputs(): void {
      const view = send.get();
      if (view.phase !== 'review' || !view.deviation || view.accepted || held === null) return;
      heldAccepted = true;
      send.set({ ...view, accepted: true });
    },
  };

  // --- Shielding (issue #8) -------------------------------------------------
  // Same held-proposal lock as send: opening either flow releases the other's
  // proposal, and confirm() broadcasts exactly the reviewed bytes via
  // send(proposalId). The SDK's one-call shield() is never reachable.
  interface ShieldDraft {
    threshold: string;
    rows: readonly ShieldAddressRow[];
    ready: boolean;
  }

  const asDraftView = (draft: ShieldDraft): ShieldDraftView => ({
    threshold: draft.threshold,
    addresses: draft.rows,
    ready: draft.ready,
  });

  const showShieldForm = (draft: ShieldDraft, notice: ShieldNotice): void => {
    shield.set({ phase: 'form', draft: asDraftView(draft), notice });
  };

  const readShieldDraft = (view: { readonly draft: ShieldDraftView }): ShieldDraft => ({
    threshold: view.draft.threshold,
    rows: view.draft.addresses,
    ready: view.draft.ready,
  });

  /** Group the flat utxo list by address, first-seen order, all checked. */
  const groupUtxos = (utxos: readonly EngineTransparentUtxo[]): readonly ShieldAddressRow[] => {
    const byAddress = new Map<string, ShieldAddressRow>();
    for (const u of utxos) {
      const row = byAddress.get(u.address);
      if (row === undefined) {
        byAddress.set(u.address, { address: u.address, zats: u.value, utxoCount: 1, checked: true });
      } else {
        byAddress.set(u.address, { ...row, zats: row.zats + u.value, utxoCount: row.utxoCount + 1 });
      }
    }
    return [...byAddress.values()];
  };

  /** Threshold text → whole zats. '' = the frozen policy default. */
  const parseThreshold = (text: string): bigint | null => {
    const trimmed = text.trim();
    if (trimmed === '') return frozenPolicy(ALLOW_TRANSPARENT_SENDS).shieldingThreshold;
    if (!/^\d+$/.test(trimmed)) return null;
    return BigInt(trimmed);
  };

  /** Recovery routing shared with send, except NOTHING_TO_SHIELD is explained
   * on the form first: the SDK maps that code's recovery to 'correct-input',
   * and a generic "invalid input" dead end must not swallow the plain-language
   * explanation (issue #8). */
  const routeShield = async (error: unknown, draft: ShieldDraft, keepProposal: boolean): Promise<void> => {
    const viewOf = (notice: ShieldNotice): Extract<ShieldView, { phase: 'form' }> => ({
      phase: 'form',
      draft: asDraftView(draft),
      notice,
    });
    if (error instanceof EngineError && error.code === 'NOTHING_TO_SHIELD') {
      await releaseHeld();
      shield.set(viewOf({ kind: 'nothing-to-shield' }));
      return;
    }
    if (!(error instanceof EngineError)) {
      await releaseHeld();
      shield.set(viewOf({ kind: 'engine', code: 'UNKNOWN', recovery: 'none' }));
      return;
    }
    if (error.recovery === 'sync') {
      await releaseHeld();
      shield.set({ phase: 'sync', draft: asDraftView(draft) });
      return;
    }
    if (error.recovery === 'reattach-signer') {
      shield.set({ phase: 'unlock', draft: asDraftView(draft), notice: null });
      return;
    }
    if (error.recovery === 'review-new-proposal') {
      await releaseHeld();
      showShieldForm(draft, null);
      return;
    }
    const engineNotice: ShieldNotice = { kind: 'engine', code: error.code, recovery: error.recovery };
    if (keepProposal && held !== null) {
      shield.set({
        phase: 'review',
        draft: asDraftView(draft),
        proposal: held,
        notice: engineNotice,
      });
      return;
    }
    showShieldForm(draft, engineNotice);
  };

  const editShieldDraft = (next: ShieldDraft): void => {
    const phase = shield.get().phase;
    if (phase !== 'form' && phase !== 'review') return;
    if (phase === 'review') void releaseHeld();
    showShieldForm(next, null);
  };

  const onShield = {
    async open(): Promise<void> {
      const phase = shield.get().phase;
      if (phase !== 'closed' && phase !== 'sent') return;
      if (!spendGuard().ok) return;
      // One review at a time: opening shielding closes send, which releases
      // any held send proposal through the shared lock.
      await onSend.close();
      const draft: ShieldDraft = {
        threshold: String(frozenPolicy(ALLOW_TRANSPARENT_SENDS).shieldingThreshold),
        rows: [],
        ready: false,
      };
      showShieldForm(draft, null);
      if (wallet === null) return;
      const account = await defaultAccount(wallet);
      if (account === undefined) return;
      const rows = groupUtxos(await wallet.listTransparentUtxos(account.id));
      // A close() during the await discards this late list.
      if (shield.get().phase !== 'form') return;
      showShieldForm({ threshold: draft.threshold, rows, ready: true }, null);
    },
    async close(): Promise<void> {
      await releaseHeld();
      shield.set({ phase: 'closed' });
    },
    setThreshold(text: string): void {
      const view = shield.get();
      if (view.phase !== 'form' && view.phase !== 'review') return;
      editShieldDraft({ ...readShieldDraft(view), threshold: text });
    },
    toggle(address: string): void {
      const view = shield.get();
      if (view.phase !== 'form' && view.phase !== 'review') return;
      const draft = readShieldDraft(view);
      editShieldDraft({
        ...draft,
        rows: draft.rows.map((row) => (row.address === address ? { ...row, checked: !row.checked } : row)),
      });
    },
    async review(): Promise<void> {
      const view = shield.get();
      if ((view.phase !== 'form' && view.phase !== 'review') || wallet === null) return;
      const draft = readShieldDraft(view);
      const guard = spendGuard();
      if (!guard.ok) {
        showShieldForm(draft, guard.reason === 'view-only' ? { kind: 'view-only' } : guard.reason === 'locked' ? { kind: 'locked' } : { kind: 'unavailable' });
        return;
      }
      touchIdle();
      const threshold = parseThreshold(draft.threshold);
      if (threshold === null) {
        if (view.phase === 'review') void releaseHeld();
        showShieldForm(draft, { kind: 'invalid-threshold' });
        return;
      }
      const fromAddresses = draft.rows.filter((row) => row.checked).map((row) => row.address);
      if (fromAddresses.length === 0) {
        if (view.phase === 'review') void releaseHeld();
        showShieldForm(draft, { kind: 'empty-selection' });
        return;
      }
      if (fromAddresses.length > MAX_SHIELD_ADDRESSES) {
        if (view.phase === 'review') void releaseHeld();
        showShieldForm(draft, { kind: 'too-many-addresses' });
        return;
      }
      await releaseHeld();
      const account = await defaultAccount(wallet);
      if (account === undefined) {
        showShieldForm(draft, { kind: 'unavailable' });
        return;
      }
      try {
        const proposal = await wallet.proposeShield({ accountId: account.id, fromAddresses, threshold });
        held = proposal;
        shield.set({
          phase: 'review',
          draft: asDraftView(draft),
          proposal,
          notice: null,
        });
      } catch (error) {
        await routeShield(error, draft, false);
      }
    },
    async confirm(): Promise<void> {
      const view = shield.get();
      if (view.phase !== 'review' || held === null || wallet === null) return;
      const draft = readShieldDraft(view);
      const guard = spendGuard();
      if (!guard.ok) {
        // Lock already dropped spend authority. Release the plan so its
        // inputs are not stuck, and do not broadcast.
        await releaseHeld();
        showShieldForm(
          draft,
          guard.reason === 'view-only' ? { kind: 'view-only' } : guard.reason === 'locked' ? { kind: 'locked' } : { kind: 'unavailable' },
        );
        return;
      }
      touchIdle();
      try {
        const result = await wallet.send(held.proposalId);
        held = null;
        await refreshOperations();
        shield.set({ phase: 'sent', txid: result.txid });
      } catch (error) {
        await routeShield(error, draft, true);
      }
    },
    async unlock(phrase: string): Promise<void> {
      const view = shield.get();
      if (view.phase !== 'unlock' || wallet === null) return;
      const draft = readShieldDraft(view);
      let normalized: string;
      try {
        normalized = normalizePhrase(phrase);
      } catch {
        shield.set({ phase: 'unlock', draft: view.draft, notice: { kind: 'phrase' } });
        return;
      }
      const bytes = phraseBytes(normalized);
      traceSecret(bytes);
      try {
        const account = await defaultAccount(wallet);
        if (account === undefined) {
          shield.set({ phase: 'unlock', draft: view.draft, notice: { kind: 'unavailable' } });
          return;
        }
        await wallet.attachSigner({ accountId: account.id, mnemonic: bytes });
        // Mirrors onSend.unlock (issue #6 session model): enter unlocked state
        // without a Vault mirror write; keep the held proposal for the retry.
        clearLockFlag();
        unlocked.set(true);
        unlockDeadline.set(Date.now() + AUTO_LOCK_MS);
        autoLockInMs.set(AUTO_LOCK_MS);
        canSpend.set(true);
        startAutoLock();
        touchIdle();
        if (held !== null) {
          shield.set({
            phase: 'review',
            draft: asDraftView(draft),
            proposal: held,
            notice: null,
          });
        } else {
          showShieldForm(draft, null);
        }
      } catch (error) {
        await routeShield(error, draft, held !== null);
      } finally {
        zeroize(bytes);
      }
    },
    backToForm(): void {
      const view = shield.get();
      if (view.phase !== 'sync' && view.phase !== 'unlock') return;
      if (view.phase === 'unlock') void releaseHeld();
      showShieldForm(readShieldDraft(view), null);
    },
    edit(): void {
      const view = shield.get();
      if (view.phase !== 'review') return;
      void releaseHeld();
      showShieldForm(readShieldDraft(view), null);
    },
  };

  return {
    screen,
    network,
    endpoint,
    walletInfo,
    balances,
    excludedCount,
    notes,
    sync,
    syncProgress,
    address,
    exposedAddresses,
    pendingCount,
    recovered,
    canSpend,
    unlocked,
    unlockDeadline,
    autoLockInMs,
    hasVault,
    backupPending,
    creating,
    bootError,
    boot,
    setNetwork,
    openSettings,
    closeSettings,
    removeWallet,
    onCreate,
    onRestore,
    onViewOnly,
    guardSpend: spendGuard,
    unlock,
    lock,
    unlockWithPhrase,
    send,
    onSend,
    onNotes,
    shield,
    onShield,
    async history(): Promise<readonly EngineHistoryEntry[]> {
      if (wallet === null) return [];
      const account = await defaultAccount(wallet);
      return account === undefined ? [] : wallet.getHistory(account.id);
    },
  };
};
