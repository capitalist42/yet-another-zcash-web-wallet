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
    confirmBackup(phrase: string): Promise<ImportResult>;
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

const savePendingSeed = (id: string, phrase: string): void => {
  try {
    globalThis.sessionStorage?.setItem(PENDING_SEED_KEY, JSON.stringify({ id, phrase }));
  } catch {
    // Reload can only finish creation when the tab can hold the phrase.
  }
};

const readPendingSeed = (): { id: string; phrase: string } | null => {
  try {
    const raw = globalThis.sessionStorage?.getItem(PENDING_SEED_KEY);
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = JSON.parse(raw) as { id?: unknown; phrase?: unknown };
    if (typeof parsed.id !== 'string' || typeof parsed.phrase !== 'string') return null;
    return { id: parsed.id, phrase: parsed.phrase };
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

/** Mainnet by default. `?network=mainnet|testnet` overrides the boot Network. */
export const networkFromQuery = (): NetworkId | null => {
  const forced = new URLSearchParams(globalThis.location?.search ?? '').get('network');
  return forced === 'mainnet' || forced === 'testnet' ? forced : null;
};

export const createWalletApp = (deps: WalletAppDeps): WalletApp => {
  const screen = atom<Screen>('booting');
  const network = atom<NetworkId>(networkFromQuery() ?? 'mainnet');
  const endpoint = atom<string>(deps.endpoints[network.get()]);
  const walletInfo = atom<WalletInfo | null>(null);
  const balances = atom<EngineBalance | null>(null);
  const sync = atom<EngineSyncStatus | null>(null);
  const address = atom<string | null>(null);
  const pendingCount = atom<number>(0);
  const recovered = atom<boolean>(false);
  const canSpend = atom<boolean>(false);
  const backupPending = atom<boolean>(false);
  const creating = atom<boolean>(false);
  const bootError = atom<string | null>(null);

  const traceSecret = deps.traceSecret ?? (() => undefined);

  let wallet: EngineWallet | null = null;
  let openSeq = 0;
  let createPhrase: string | null = null;
  let backupConfirmed = false;
  /** Client whose sync stream is already subscribed. */
  let syncArmed: EngineWallet | null = null;
  /** Id of a create that is on screen but not registered yet. */
  let pendingWalletId: string | null = null;

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
    syncArmed = null;
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
        if (status.targetReached) continueCreateAfterTip();
        await refreshOperations();
        const account = await defaultAccount(w);
        if (account !== undefined) {
          const raw = await w.getBalance(account.id);
          const prev = balances.get();
          const unscanned = raw.transparent === null && raw.sapling === null && raw.ironwood === null;
          const showingZero = prev?.transparent === 0n && prev.sapling === 0n && prev.ironwood === 0n;
          // Keep the new-wallet zero until a scan reports a real figure.
          balances.set(unscanned && showingZero ? prev : raw);
        }
      }
    } catch {
      // closed or superseded; the next open owns the stores now
    }
  };

  /**
   * Finish opening a wallet whose Client is live: recovery is complete
   * (it ran inside open), serve balances from the LOCAL DB, then start sync.
   */
  const finishOpen = async (w: EngineWallet, record: WalletRecord, showZeroUntilScan = false): Promise<void> => {
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
      await refreshOperations();
    }
    // Subscribe BEFORE triggering sync: the SDK stream only publishes on
    // scan-revision changes, so ticks fired between start and subscribe
    // would be lost (spike §Sync). A create already armed this client.
    if (syncArmed !== w) {
      syncArmed = w;
      void watchLoop(w);
      await w.startSync();
    }
    await deps.registry.touch(record.id);
    screen.set('wallet');
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
      allowTransparentSends: false, // Settings switch lands in #12; default off
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
    void createSeedWallet(bytes, false, phrase).finally(() => zeroize(bytes));
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
    const bytes = phraseBytes(pending.phrase);
    traceSecret(bytes);
    try {
      await createSeedWallet(bytes, false, pending.phrase);
    } finally {
      zeroize(bytes);
    }
  };

  const createSeedWallet = async (bytes: Uint8Array, restartSync = false, phrase = ''): Promise<ImportResult> => {
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
          allowTransparentSends: false,
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
      });
      if (phrase !== '') savePendingSeed(id, phrase);
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
      backupConfirmed = true;
      createPhrase = null;
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
        return await createSeedWallet(bytes, false, normalized);
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
        return await createSeedWallet(bytes, true, createPhrase);
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
