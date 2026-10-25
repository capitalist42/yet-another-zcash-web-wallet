// The Wallet app service: boot choreography + onboarding flows + UI stores.
// Everything engine-shaped goes through the port; this module is the single
// orchestrator the React tree subscribes to (nanostores).
import { atom, type ReadableAtom, type WritableAtom } from 'nanostores';
import type {
  Engine,
  EngineAccount,
  EngineBalance,
  EngineHistoryEntry,
  EngineSyncStatus,
  EngineWallet,
  NetworkId,
} from './engine/port';
import { EngineError, isNonTerminal, type EngineErrorCode } from './engine/port';
import type { Registry, WalletKind, WalletRecord } from './registry';
import { storageName, FRESHNESS_TIMEOUT_MS, type EndpointSettings } from './policy';
import { fingerprintFromUfvk } from './fingerprint';
import { generatePhrase, normalizePhrase, phraseBytes, zeroize } from './keys';

export type Screen = 'booting' | 'welcome' | 'wallet' | 'storage-busy';

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

/** App-level result codes: engine codes plus the onboarding gate refusal. */
export type ImportErrorCode = EngineErrorCode | 'GATE_PENDING';

export interface ImportResult {
  readonly ok: boolean;
  readonly code?: ImportErrorCode;
  readonly message?: string;
}

export interface SpendGuard {
  readonly ok: boolean;
  readonly reason?: 'view-only' | 'unavailable';
}

export interface WalletApp {
  // --- stores (UI subscribes; tests assert) --------------------------------
  readonly screen: ReadableAtom<Screen>;
  readonly network: WritableAtom<NetworkId>;
  /** Active lightwalletd endpoint; persistent chip (ADR-0001 disclosure). */
  readonly endpoint: ReadableAtom<string>;
  readonly walletInfo: ReadableAtom<WalletInfo | null>;
  readonly balances: ReadableAtom<EngineBalance | null>;
  readonly sync: ReadableAtom<EngineSyncStatus | null>;
  readonly address: ReadableAtom<string | null>;
  readonly pendingCount: ReadableAtom<number>;
  /** Startup recovery finished (boot gate): payment paths unlock after. */
  readonly recovered: ReadableAtom<boolean>;
  /** Spend-capable = spend authority exists AND recovery completed (#4). */
  readonly canSpend: ReadableAtom<boolean>;
  /** Forced backup gate is open: a generated phrase awaits confirmation.
   * While true, every other onboarding path is refused (#4: not dismissable). */
  readonly backupPending: ReadableAtom<boolean>;
  readonly bootError: ReadableAtom<string | null>;
  // --- flows ----------------------------------------------------------------
  boot(): Promise<void>;
  setNetwork(network: NetworkId): Promise<void>;
  readonly onCreate: {
    generate(): Promise<CreateSession>;
    confirmBackup(phrase: string): Promise<ImportResult>;
  };
  readonly onRestore: {
    restore(args: {
      phrase: string;
      passphrase?: string;
      accountIndex: number;
      birthday: RestoreBirthday;
      name?: string;
    }): Promise<ImportResult>;
  };
  readonly onViewOnly: {
    import(args: { viewingKey: string; birthday: RestoreBirthday; name?: string }): Promise<ImportResult>;
  };
  /** Capability gate the Send surface must pass before composing (#4). */
  guardSpend(): SpendGuard;
  history(): Promise<readonly EngineHistoryEntry[]>;
}

export interface WalletAppDeps {
  readonly engine: Engine;
  readonly registry: Registry;
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

/** Testnet-first default; `?network=mainnet|testnet` picks the boot Network. */
export const networkFromQuery = (): NetworkId | null => {
  const forced = new URLSearchParams(globalThis.location?.search ?? '').get('network');
  return forced === 'mainnet' || forced === 'testnet' ? forced : null;
};

export const createWalletApp = (deps: WalletAppDeps): WalletApp => {
  const screen = atom<Screen>('booting');
  const network = atom<NetworkId>(networkFromQuery() ?? 'testnet');
  const endpoint = atom<string>(deps.endpoints[network.get()]);
  const walletInfo = atom<WalletInfo | null>(null);
  const balances = atom<EngineBalance | null>(null);
  const sync = atom<EngineSyncStatus | null>(null);
  const address = atom<string | null>(null);
  const pendingCount = atom<number>(0);
  const recovered = atom<boolean>(false);
  const canSpend = atom<boolean>(false);
  const backupPending = atom<boolean>(false);
  const bootError = atom<string | null>(null);

  const traceSecret = deps.traceSecret ?? (() => undefined);

  let wallet: EngineWallet | null = null;
  let openSeq = 0;
  let createPhrase: string | null = null;
  let backupConfirmed = false;

  const resetStores = (): void => {
    walletInfo.set(null);
    balances.set(null);
    sync.set(null);
    address.set(null);
    pendingCount.set(0);
    recovered.set(false);
    canSpend.set(false);
    bootError.set(null);
  };

  const closeWallet = async (): Promise<void> => {
    openSeq += 1; // invalidate in-flight opens and watch loops
    const w = wallet;
    wallet = null;
    if (w !== null) await w.close();
  };

  /** v1 rule: one default account per Wallet; switcher UI is #11. */
  const defaultAccount = async (w: EngineWallet): Promise<EngineAccount | undefined> =>
    (await w.accounts())[0];

  const refreshOperations = async (): Promise<void> => {
    if (wallet === null) return;
    const ops = await wallet.listOperations();
    pendingCount.set(ops.filter((o) => isNonTerminal(o.phase)).length);
  };

  /** Watch the sync stream; refresh displayed state per progress tick. */
  const watchLoop = async (w: EngineWallet): Promise<void> => {
    try {
      for await (const status of w.watchSync()) {
        if (wallet !== w) break;
        sync.set(status);
        await refreshOperations();
        const account = await defaultAccount(w);
        if (account !== undefined) balances.set(await w.getBalance(account.id));
      }
    } catch {
      // closed or superseded; the next open owns the stores now
    }
  };

  /**
   * Finish opening a wallet whose Client is live: recovery is complete
   * (it ran inside open), serve balances from the LOCAL DB, then start sync.
   */
  const finishOpen = async (w: EngineWallet, record: WalletRecord): Promise<void> => {
    wallet = w;
    recovered.set(true);
    walletInfo.set({
      id: record.id,
      name: record.name,
      fingerprint: record.fingerprint,
      kind: record.kind,
    });
    canSpend.set(record.kind === 'seed');
    const account = await defaultAccount(w);
    if (account !== undefined) {
      balances.set(await w.getBalance(account.id));
      const current = await w.currentAddress(account.id);
      // A view-only account cannot mint (the SDK has no spend key to derive
      // the next shielded address from); the current one is the truth.
      address.set(current ?? (account.viewOnly ? null : await w.mintAddress(account.id)));
      await refreshOperations();
    }
    // Subscribe BEFORE triggering sync: the SDK stream only publishes on
    // scan-revision changes, so ticks fired between start and subscribe
    // would be lost (spike §Sync).
    void watchLoop(w);
    await w.startSync();
    await deps.registry.touch(record.id);
    screen.set('wallet');
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
      allowTransparentSends: false, // Settings switch lands in #12; default off
    });
    if (seq !== openSeq) {
      await w.close(); // superseded by a newer open (network switch)
      return;
    }
    await finishOpen(w, record);
  };

  const boot = async (): Promise<void> => {
    screen.set('booting');
    endpoint.set(deps.endpoints[network.get()]);
    try {
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
    network.set(next);
    endpoint.set(deps.endpoints[next]);
    await closeWallet();
    await boot();
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
    let w: EngineWallet | null = null;
    try {
      w = await deps.engine.open({
        network: net,
        endpoint: deps.endpoints[net],
        storageName: storageName(net, id),
        allowTransparentSends: false,
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
      await closeWallet();
      wallet = w;
      const record: WalletRecord = {
        id,
        network: net,
        name: args.name,
        fingerprint,
        kind: args.kind,
        lastUsed: Date.now(),
      };
      await deps.registry.add(record);
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
     * creates + registers + opens the Wallet. No other path completes it.
     */
    async confirmBackup(phrase: string): Promise<ImportResult> {
      if (backupConfirmed) return { ok: true }; // idempotent double-tap
      if (createPhrase === null) return { ok: false, code: 'UNKNOWN', message: 'no phrase in flight' };
      let normalized: string;
      try {
        normalized = normalizePhrase(phrase);
      } catch (e) {
        return { ok: false, code: 'INVALID_MNEMONIC', message: e instanceof Error ? e.message : String(e) };
      }
      if (normalized !== createPhrase) {
        return { ok: false, code: 'INVALID_MNEMONIC', message: 'phrase mismatch' };
      }
      const bytes = phraseBytes(normalized);
      traceSecret(bytes);
      try {
        const res = await createWalletFlow({
          name: 'wallet',
          kind: 'seed',
          run: async (w) => {
            const created = await w.createSeed({ mnemonic: bytes, name: 'wallet' });
            const ufvk = await created.ufvk();
            await created.dispose();
            return ufvk;
          },
        });
        if (res.ok) {
          backupConfirmed = true;
          createPhrase = null;
          backupPending.set(false);
        }
        return res;
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
    }): Promise<ImportResult> {
      // #4: a pending forced-backup gate blocks every other onboarding path.
      if (backupPending.get())
        return { ok: false, code: 'GATE_PENDING', message: 'Confirm your backup phrase first — it cannot be left pending.' };
      if (!Number.isInteger(args.accountIndex) || args.accountIndex < 0)
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'Account index must be a whole number ≥ 0' };
      if (!validBirthday(args.birthday))
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'Birthday height must be a whole number ≥ 1' };
      let phrase: string;
      try {
        phrase = normalizePhrase(args.phrase);
      } catch (e) {
        return { ok: false, code: 'INVALID_MNEMONIC', message: e instanceof Error ? e.message : String(e) };
      }
      const name = args.name ?? 'restored';
      const bytes = phraseBytes(phrase);
      const pass = args.passphrase === undefined || args.passphrase === '' ? undefined : phraseBytes(args.passphrase);
      traceSecret(bytes);
      if (pass !== undefined) traceSecret(pass);
      try {
        return await createWalletFlow({
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

  return {
    screen,
    network,
    endpoint,
    walletInfo,
    balances,
    sync,
    address,
    pendingCount,
    recovered,
    canSpend,
    backupPending,
    bootError,
    boot,
    setNetwork,
    onCreate,
    onRestore,
    onViewOnly,
    guardSpend(): SpendGuard {
      const info = walletInfo.get();
      if (info === null) return { ok: false, reason: 'unavailable' };
      if (info.kind !== 'seed') return { ok: false, reason: 'view-only' };
      if (!recovered.get()) return { ok: false, reason: 'unavailable' };
      return { ok: true };
    },
    async history(): Promise<readonly EngineHistoryEntry[]> {
      if (wallet === null) return [];
      const account = await defaultAccount(wallet);
      return account === undefined ? [] : wallet.getHistory(account.id);
    },
  };
};
