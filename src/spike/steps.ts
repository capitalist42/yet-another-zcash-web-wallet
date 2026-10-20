// Ticket #2 step runner: policy matrix (P1–P3), round trip (S3),
// failed-submit drill (S4), reload survival (S5). Throwaway harness.
import {
  balanceView,
  clientA,
  errorShape,
  note,
  openWallet,
  record,
  requireAccountA,
  seedBytes,
  summarizeProposal,
  isResyncGuided,
  syncTolerant,
  RUN_NETWORK,
  SHIELDING_THRESHOLD,
  delay,
  FAUCET_API,
} from './core';
import type { Ctx, StepName, TransparentMode } from './core';
import type { AccountId, AccountRecord, AddressRecord, MemorySigner, PaymentConfirmation, SyncStatus, WalletClient } from '@zcashlabs/zcash.js';
import { accountIndex, isZcashError, resolveBirthday } from '@zcashlabs/zcash.js';


// ---- S1: create / address semantics / sync --------------------------------

export const step1a_createA = async (ctx: Ctx, transparent: TransparentMode = 'disallow'): Promise<void> => {
  try {
    if (ctx.openedA !== null) {
      await ctx.openedA.client.close();
      ctx.openedA = null;
    }
    const opened = await openWallet(ctx.storageA, transparent);
    ctx.openedA = opened;
    note(ctx, `client open; recovery=${JSON.stringify(opened.recovery)}`);
    // accounts.create requires coherent chain state (doc: stale => SYNC_REQUIRED).
    await syncTolerant(opened.client);
    // Re-run must not collide (ACCOUNT_COLLISION on same mnemonic) nor double-open the
    // OPFS lease the previous client still holds.
    const { account, signer, adopted } = await ensureAccountA(opened.client, ctx);
    ctx.accountA = account.id;
    ctx.signerA = signer;
    const binding = await opened.client.accounts.attachSigner({ accountId: account.id, signer });
    record(ctx, 'S1a-create-A', binding.state === 'ready', `account=${account.id} birthday=${account.birthdayHeight} binding=${binding.state}${adopted ? ' adopted=existing' : ''}`);
  } catch (e) {
    record(ctx, 'S1a-create-A', false, JSON.stringify(errorShape(e)));
  }
};

// S1b: `addresses.current()` probe on the fresh account. The spec claim
// (rc.5 docs: null on fresh) is DISPROVEN live — create() already exposes
// index 0 (plan §0). Step renamed from "current-null" so PASS/FAIL is not
// inverted: PASS = probe ran and behavior recorded; the null-vs-not-null
// fact rides in the detail, and a FAIL means the probe itself broke.
export const step1b_currentNull = async (ctx: Ctx): Promise<void> => {
  try {
    const current = await clientA(ctx).addresses.current({ accountId: requireAccountA(ctx) });
    record(ctx, 'S1b-current-probe', true, `current() on fresh account = ${current === null ? 'null' : `NOT NULL (${current.slice(0, 8)}…)`}`);
  } catch (e) {
    record(ctx, 'S1b-current-probe', false, JSON.stringify(errorShape(e)));
  }
};

export const step1c_nextMints = async (ctx: Ctx): Promise<void> => {
  try {
    const client = clientA(ctx);
    const accountId = requireAccountA(ctx);
    const minted: AddressRecord = await client.addresses.next({ accountId });
    ctx.unifiedA = minted.address;
    const current = await client.addresses.current({ accountId });
    const transparent: AddressRecord = await client.addresses.next({ accountId, request: { format: 'transparent' } });
    ctx.transparentA = transparent.address;
    const listed = await client.addresses.list({ accountId });
    record(
      ctx,
      'S1c-next-mints',
      minted.address.startsWith('u1') && transparent.address.startsWith('t1') && listed.length >= 3,
      `unified=${minted.address.slice(0, 12)}… receivers=[${minted.receiverTypes.join(',')}] current-after-next=${current === null ? 'null' : current.slice(0, 12)} (follows-next=${current === minted.address}); transparent=${transparent.address.slice(0, 6)}…; exposed=${listed.length}`,
    );
  } catch (e) {
    record(ctx, 'S1c-next-mints', false, JSON.stringify(errorShape(e)));
  }
};

export const step1d_syncTip = async (ctx: Ctx): Promise<void> => {
  try {
    let status: SyncStatus;
    try {
      status = await syncTolerant(clientA(ctx));
    } catch (e) {
      // Issue #177 tip race (live mainnet): spaced retries sometimes never
      // recover; the reliable remedy is a fresh client on the same OPFS DB.
      if (!isResyncGuided(e)) throw e;
      note(ctx, 'S1d: sync loop exhausted (tip race #177); reopening client on same DB');
      await openA(ctx, 'disallow');
      status = await syncTolerant(clientA(ctx));
    }
    record(
      ctx,
      'S1d-sync-tip',
      status.targetReached,
      `activity=${status.activity} targetReached=${status.targetReached} tip=${status.scan.tipHeight} scanned=${status.scan.fullyScannedHeight} complete=${status.scan.scanComplete}`,
    );
  } catch (e) {
    record(ctx, 'S1d-sync-tip', false, JSON.stringify(errorShape(e)));
  }
};

// ---- Faucet: drip claim against the transparent receiver ------------------

// Valargroup NU7-aware public-testnet faucet (0.125 TAZ; 24 h per address AND
// per IP; POST /api/claim -> 202 queued -> poll GET /api/claim/:id). The old
// jinolabs PoW faucet died at NU7 activation (2026-10-04) — see core.ts.
interface FaucetStatus {
  ready: boolean;
  walletSynced: boolean;
  payout: string;
  addressCooldownSeconds: number;
  chainHeight: number;
}

interface FaucetClaim {
  id: string;
  status: 'queued' | 'sent' | 'failed' | string;
  amount?: string;
  txid?: string;
  error?: string;
  message?: string;
  retryAfterSeconds?: number;
}

// Testnet only: there is no mainnet faucet. A mainnet run refuses honestly
// instead of pretending a drip could land.
export const step_faucetT = async (ctx: Ctx): Promise<void> => {
  try {
    if (RUN_NETWORK !== 'testnet') {
      throw new Error(`faucet serves testnet only; run network=${RUN_NETWORK} (no mainnet faucet exists)`);
    }
    if (ctx.transparentA === null) throw new Error('run S1c first (need transparent address)');
    const status = (await (await fetch(`${FAUCET_API}/status`)).json()) as FaucetStatus;
    if (!status.ready || !status.walletSynced) throw new Error(`faucet not ready (ready=${status.ready} walletSynced=${status.walletSynced})`);
    note(ctx, `faucet at height ${status.chainHeight}, payout ${status.payout} TAZ`);
    let claim = (await (
      await fetch(`${FAUCET_API}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: ctx.transparentA }),
      })
    ).json()) as FaucetClaim;
    if (claim.error) throw new Error(`claim refused: ${claim.message ?? claim.error}`);
    // Poll until the faucet reports broadcast ("sent"); confirmation waiting is
    // P1's job (skipIfUnfunded gates on SDK-visible confirmed balance anyway).
    for (let i = 0; i < 20 && claim.status === 'queued'; i += 1) {
      await delay(5_000);
      claim = (await (await fetch(`${FAUCET_API}/claim/${claim.id}`)).json()) as FaucetClaim;
    }
    if (claim.status === 'failed') throw new Error(`claim failed: ${claim.error ?? 'unknown'}`);
    if (claim.status !== 'sent') throw new Error(`claim still ${claim.status} after 100 s`);
    record(ctx, 'FAUCET-t', true, `drip txid=${claim.txid ?? 'n/a'} to transparent receiver; wait for confirmation before P1`);
  } catch (e) {
    record(ctx, 'FAUCET-t', false, JSON.stringify(errorShape(e)));
  }
};
// ---- Wallet-reopen helpers (policy is creation-time; swap = reopen) ------

// Hard guard against the review finding: the hang-proxy broadcaster forwards
// to ONE upstream network, configured server-side and invisible to the page.
// Routing a mainnet run's transactions through a testnet broadcaster is a
// silent funds-losing misroute, so ask the proxy which network it fronts and
// refuse loudly on mismatch.
const ensureProxyNetwork = async (endpoint: string): Promise<void> => {
  const res = await fetch(`${endpoint}/drill/config`).catch(() => null);
  if (res === null || !res.ok) {
    throw new Error(`drill proxy config unreachable at ${endpoint} (run the dev/preview server; S4 needs the hang proxy)`);
  }
  const cfg = (await res.json()) as { network?: string };
  if (cfg.network !== RUN_NETWORK) {
    throw new Error(
      `refusing to broadcast through ${endpoint}: proxy upstream is ${cfg.network ?? 'unknown'}, run network=${RUN_NETWORK}`,
    );
  }
};

export const openA = async (ctx: Ctx, transparent: TransparentMode, broadcasterEndpoint: string | null = null): Promise<void> => {
  if (broadcasterEndpoint !== null) await ensureProxyNetwork(broadcasterEndpoint);
  if (ctx.openedA !== null) {
    await ctx.openedA.client.close();
    ctx.openedA = null;
  }
  const opened = await openWallet(ctx.storageA, transparent, broadcasterEndpoint);
  ctx.openedA = opened;
  await syncTolerant(opened.client);
  // Adopt-first: the DB already has spike-A on re-run/reopen/reload.
  const { account, signer } = await ensureAccountA(opened.client, ctx);
  ctx.accountA = account.id;
  ctx.signerA = signer;
  await opened.client.accounts.attachSigner({ accountId: account.id, signer });
};

// Open account A in the given client: adopt an existing spike-A account when the
// DB already has one (re-run / reopen / reload), create fresh otherwise.
// Finding (live mainnet 2026-10-20): create() does NOT enforce ACCOUNT_COLLISION for
// the same mnemonic in the same DB — a second create silently adds a duplicate
// account with a fresh birthday. Hence adopt-first, not create-then-adopt.
// Returns the mnemonic-derived signer; caller attaches it.
const ensureAccountA = async (
  client: WalletClient,
  ctx: Ctx,
): Promise<{ account: AccountRecord; signer: MemorySigner; adopted: boolean }> => {
  const accounts = await client.accounts.list();
  const existing =
    accounts.find((a) => a.id === ctx.accountA) ?? accounts.find((a) => a.name === 'spike-A');
  if (existing !== undefined) {
    const signer = await client.accounts.restoreSigner({
      accountId: existing.id,
      mnemonic: seedBytes(ctx.mnemonicA),
    });
    return { account: existing, signer, adopted: true };
  }
  const created = await client.accounts.create({ mnemonic: seedBytes(ctx.mnemonicA), name: 'spike-A' });
  return { account: created.account, signer: created.signer, adopted: false };
};

export const openB = async (ctx: Ctx): Promise<void> => {
  if (ctx.openedB !== null) throw new Error('B already open; close it first');
  ctx.openedB = await openWallet(ctx.storageB, 'allow-owned');
  await syncTolerant(ctx.openedB.client);
  const created = await ctx.openedB.client.accounts.create({ mnemonic: seedBytes(ctx.mnemonicB), name: 'spike-B' });
  await ctx.openedB.client.accounts.attachSigner({ accountId: created.account.id, signer: created.signer });
  ctx.accountB = created.account.id;
  const address = await ctx.openedB.client.addresses.next({ accountId: created.account.id });
  ctx.unifiedB = address.address;
};

export const closeB = async (ctx: Ctx): Promise<void> => {
  if (ctx.openedB !== null) {
    await ctx.openedB.client.close();
    ctx.openedB = null;
  }
};
// Funding axis for the policy matrix: on mainnet there is no faucet, so the
// funded legs (shieldable t balance) cannot run at all. A pool error from an
// unfunded account ("UNSUPPORTED_POOL") is NOT evidence about the policy axis
// under test — record an honest skip (ok:false, never a PASS) instead.
// Same bar as the P2/P3 inline gates and frozenPolicy.shieldingThreshold:
// below it, propose({kind:'shield'}) throws NOTHING_TO_SHIELD, and that error
// is about the threshold, not the policy axis.
const skipIfUnfunded = async (ctx: Ctx, step: StepName, detail: string): Promise<boolean> => {
  const balance = await clientA(ctx).getBalance({ accountId: requireAccountA(ctx) });
  const spendable = balance.amounts?.transparent.regular.spendable ?? 0n;
  if (spendable > SHIELDING_THRESHOLD) return false;
  record(ctx, step, false, `SKIPPED: t-spendable <= shielding threshold (${balanceView(balance)}); ${detail}`);
  return true;
};

// ---- P1: propose shield() while A sits in disallow phase ------------------

export const stepP1_shieldDisallow = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedA === null) throw new Error('open A (disallow) first');
    if (await skipIfUnfunded(ctx, 'P1-shield-disallow', 'shield() proposal needs confirmed t funds; fund via faucet (testnet) + sync, then re-run')) return;
    const proposal = await clientA(ctx).propose({ kind: 'shield', accountId: requireAccountA(ctx) });
    record(ctx, 'P1-shield-disallow', true, `propose shield under disallow OK -> ${summarizeProposal(proposal)}`);
    await clientA(ctx).operations.abandon({ operationId: proposal.operationId });
  } catch (e) {
    record(ctx, 'P1-shield-disallow', false, JSON.stringify(errorShape(e)));
  }
};

// ---- P2: reopen same DB allow-owned; t-send proposal ----------------------

export const stepP2_shieldAllowOwned = async (ctx: Ctx): Promise<void> => {
  try {
    await openA(ctx, 'allow-owned');
    const client = clientA(ctx);
    const accountId = requireAccountA(ctx);
    if (await skipIfUnfunded(ctx, 'P2-shield-allow-owned', 't-spend leg needs confirmed t funds; fund via faucet + sync, then re-run')) return;
    const shieldProposal = await client.propose({ kind: 'shield', accountId });
    const detail = `reopen allow-owned; shield proposal: ${summarizeProposal(shieldProposal)}; `;
    await client.operations.abandon({ operationId: shieldProposal.operationId });
    const balance = await client.getBalance({ accountId });
    const spendable = balance.amounts?.transparent.regular.spendable ?? 0n;
    if (spendable <= SHIELDING_THRESHOLD) {
      // A skipped experiment NEVER reports PASS: without confirmed t funds the
      // allow-owned spend path went unexercised. ok:false keeps it visible.
      record(ctx, 'P2-shield-allow-owned', false, `${detail}SKIPPED t-spend leg (no confirmed t funds: ${balanceView(balance)}); fund via faucet + sync, then re-run`);
      return;
    }
    const tProposal = await client.propose({ accountId, to: ctx.transparentA!, amount: spendable - 5_000n });
    await client.operations.abandon({ operationId: tProposal.operationId });
    record(ctx, 'P2-shield-allow-owned', true, `${detail}direct t-send proposal OK -> ${summarizeProposal(tProposal)}`);
  } catch (e) {
    record(ctx, 'P2-shield-allow-owned', false, JSON.stringify(errorShape(e)));
  }
};

// ---- P3: direct transparent send under disallow => must reject ------------

export const stepP3_directTransparentSend = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedA === null) throw new Error('open A (disallow, funded) first');
    const client = clientA(ctx);
    const accountId = requireAccountA(ctx);
    const balance = await client.getBalance({ accountId });
    const spendable = balance.amounts?.transparent.regular.spendable ?? 0n;
    // Unfunded is no evidence about the policy axis: honest skip, like P1/P2/P4.
    if (spendable <= SHIELDING_THRESHOLD) {
      record(ctx, 'P3-direct-transparent-send', false, `SKIPPED: account unfunded (${balanceView(balance)}); t-send proposal needs > ${SHIELDING_THRESHOLD} confirmed t; fund via faucet (testnet) + sync, then re-run`);
      return;
    }
    const proposal = await client.propose({ accountId, to: ctx.transparentA!, amount: spendable - 5_000n });
    await client.operations.abandon({ operationId: proposal.operationId });
    record(ctx, 'P3-direct-transparent-send', false, `proposal SUCCEEDED under disallow (policy does NOT gate t-spend): ${summarizeProposal(proposal)}`);
  } catch (e) {
    const shape = errorShape(e);
    record(ctx, 'P3-direct-transparent-send', shape.code !== undefined, `rejected code=${shape.code ?? '-'} recovery=${shape.recovery ?? '-'} message=${shape.message.slice(0, 140)}`);
  }
};

// ---- P4: reviewed shield execute (propose -> send exact bytes -> mined) ----

export const stepP4_shieldExecute = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedA === null) throw new Error('open A (allow-owned, funded) first');
    const client = clientA(ctx);
    const accountId = requireAccountA(ctx);
    if (await skipIfUnfunded(ctx, 'P4-shield-execute', 'propose->send needs confirmed t funds to shield; fund via faucet + sync, then re-run')) return;
    // Product ships only the reviewed path (plan §1 "Shield"): propose ->
    // inspect -> send the exact proposal bytes -> wait mined. Bare
    // client.shield() has NO review window, so the spike exercises
    // propose->send, matching what users can actually trigger.
    const proposal = await client.propose({ kind: 'shield', accountId });
    const summary = summarizeProposal(proposal);
    const pending = await client.send({ proposal });
    const confirmation = await pending.wait({ timeoutMs: 300_000 });
    const balance = await client.getBalance({ accountId });
    record(
      ctx,
      'P4-shield-execute',
      true,
      `propose->send mined txid=${String(confirmation.transactions[0]?.txid ?? '?')}; ${summary}; balance now ${balanceView(balance)}`,
    );
  } catch (e) {
    record(ctx, 'P4-shield-execute', false, JSON.stringify(errorShape(e)));
  }
};

// ---- S3: shielded round trip A -> B ----------------------------------------

export const stepS3_shieldSend = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedB === null) throw new Error('open B first');
    const client = clientA(ctx);
    const clientB = ctx.openedB.client;
    const balance = await client.getBalance({ accountId: requireAccountA(ctx) });
    const spendable = balance.amounts?.ironwood.spendable ?? 0n;
    if (spendable <= 1_000_000n) throw new Error(`shielded spendable ${spendable} too small; fund + shield first`);
    const pending = await client.send({
      accountId: requireAccountA(ctx),
      to: ctx.unifiedB!,
      amount: 1_000_000n,
    });
    ctx.lastOperationId = pending.operationId;
    const confirmation = await pending.wait({ timeoutMs: 240_000 });
    const txid = confirmation.transactions[0]!.txid;
    let sawB = false;
    for (let i = 0; i < 40 && !sawB; i += 1) {
      await syncTolerant(clientB);
      sawB = (await clientB.getTransaction({ txid })) !== null;
      if (!sawB) await delay(3_000);
    }
    record(ctx, 'S3-shield-send', sawB, `A->B 0.01 sent+mined txid=${String(txid)}; B observed via getTransaction=${sawB}`);
  } catch (e) {
    record(ctx, 'S3-shield-send', false, JSON.stringify(errorShape(e)));
  }
};

export const stepS3b_memoSend = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedB === null) throw new Error('open B first');
    const client = clientA(ctx);
    const clientB = ctx.openedB.client;
    const memoText = `yaw-spike-${Date.now()}`;
    const pending = await client.send({
      accountId: requireAccountA(ctx),
      to: ctx.unifiedB!,
      amount: 10_000n,
      memo: { text: memoText },
    });
    const confirmation = await pending.wait({ timeoutMs: 240_000 });
    const txid = confirmation.transactions[0]!.txid;
    let seenMemo: string | null = null;
    for (let i = 0; i < 40 && seenMemo === null; i += 1) {
      await syncTolerant(clientB);
      const found = await clientB.getTransaction({ txid });
      const out = found?.outputs.find((o) => o.receivingAccountIds.includes(ctx.accountB!));
      if (out !== undefined && out.memo.kind === 'text') seenMemo = out.memo.text;
      else await delay(3_000);
    }
    record(ctx, 'S3b-memo-send', seenMemo === memoText, `memo round trip: sent='${memoText}' received='${seenMemo ?? 'never'}'`);
  } catch (e) {
    record(ctx, 'S3b-memo-send', false, JSON.stringify(errorShape(e)));
  }
};

export const stepS3c_historyBoth = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedB === null) throw new Error('open B first');
    const histA = await clientA(ctx).getHistory({ accountId: requireAccountA(ctx) });
    const histB = await ctx.openedB.client.getHistory({ accountId: ctx.accountB! });
    const spendA = histA.items.filter((h) => h.balanceDelta < 0n).length;
    const recvB = histB.items.filter((h) => h.balanceDelta > 0n).length;
    record(
      ctx,
      'S3c-history-both',
      spendA > 0 && recvB > 0,
      `A: ${histA.items.length} entries (${spendA} net-negative), B: ${histB.items.length} entries (${recvB} net-positive), scanComplete A=${histA.scan.scanComplete} B=${histB.scan.scanComplete}`,
    );
  } catch (e) {
    record(ctx, 'S3c-history-both', false, JSON.stringify(errorShape(e)));
  }
};

// ---- S4: failed submit => SUBMISSION_UNKNOWN journal + observe-only --------

export const stepS4_submitUnknown = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedA === null) throw new Error('open A (allow-owned phase with /hang proxy) first');
    const client = clientA(ctx);
    const pending = await client.send({ accountId: requireAccountA(ctx), to: ctx.unifiedB!, amount: 10_000n });
    const state = await pending.snapshot();
    const attempt = state.steps[0]?.attempts[0];
    record(
      ctx,
      'S4-submit-unknown',
      attempt?.outcome === 'unknown',
      `phase=${state.phase} attempts=[${state.steps.flatMap((s) => s.attempts.map((a) => a.outcome)).join(',')}] bound to exact bytes=${state.steps[0]?.exactBytesSha256 !== undefined}`,
    );
    ctx.lastOperationId = pending.operationId;
  } catch (e) {
    const shape = errorShape(e);
    const expected = shape.code === 'SUBMISSION_UNKNOWN';
    if (isZcashError(e) && e.paymentState !== undefined) ctx.lastOperationId = e.paymentState.operationId;
    record(ctx, 'S4-submit-unknown', expected, `threw code=${shape.code ?? '-'} recovery=${shape.recovery ?? '-'} opId=${ctx.lastOperationId ?? 'missing'}`);
  }
};

export const stepS4b_resumeMined = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedA === null || ctx.lastOperationId === null) throw new Error('need S4 first (operation id)');
    const client = clientA(ctx);
    const before = await client.operations.get({ operationId: ctx.lastOperationId });
    const hadUnknown = before?.steps.flatMap((s) => s.attempts).some((a) => a.outcome === 'unknown') ?? false;
    const page = await client.operations.list();
    const pending = await client.operations.resume({ operationId: ctx.lastOperationId });
    // AC2: resume() reconciles the UNKNOWN attempt by txid/observation.
    // wait() resolves only once every step has checked inclusion; a timeout
    // retains the latest state, which we then read explicitly.
    let confirmation: PaymentConfirmation | null = null;
    try {
      confirmation = await pending.wait({ timeoutMs: 300_000 });
    } catch {
      confirmation = null;
    }
    const state = confirmation?.snapshot ?? (await pending.snapshot());
    const steps = state.steps.flatMap((s) => s.attempts.map((a) => a.outcome)).join(',');
    const mined =
      state.steps.some((s) => s.observation?.state === 'mined' && s.inclusion !== null) ||
      (confirmation !== null && state.phase === 'complete');
    record(
      ctx,
      'S4b-resume-mined',
      hadUnknown && mined,
      `resume() over ${page.items.length} ops -> phase=${state.phase} mined=${mined} hadUnknownBefore=${hadUnknown} attempts=[${steps}] exactBytesRetained=${state.steps[0]?.exactBytesSha256 !== undefined}`,
    );
  } catch (e) {
    record(ctx, 'S4b-resume-mined', false, JSON.stringify(errorShape(e)));
  }
};

// ---- S5: reload survival (UI drives location.reload; this runs post-load) --

export const stepS5_reloadSane = async (ctx: Ctx): Promise<void> => {
  try {
    const opened = await openWallet(ctx.storageA, 'allow-owned');
    ctx.openedA = opened;
    // AC3: the reload-recovery report is asserted, not just logged.
    const rec = opened.recovery;
    const recoverySane = rec.local === 'complete' && rec.lastError === null && rec.observation !== 'incomplete';
    await syncTolerant(opened.client);
    const accounts = await opened.client.accounts.list();
    const aPresent = ctx.accountA !== null && accounts.some((a) => a.id === ctx.accountA);
    // Signer-memory-only invariant: viewOnly is the PERSISTENT record flag
    // (only viewing-key imports set it — live finding); the reload-relevant
    // fact is that the in-memory signer is gone: signerAttached=false.
    const rec0 = accounts.find((a) => a.id === ctx.accountA);
    const signerDetached = rec0 !== undefined && !rec0.signerAttached;
    const balance = aPresent && ctx.accountA !== null ? await opened.client.getBalance({ accountId: ctx.accountA }) : null;
    record(
      ctx,
      'S5-reload-sane',
      aPresent && signerDetached && balance !== null && recoverySane,
      `reopen after reload: accounts=${accounts.length} A-present=${aPresent} A-viewOnly=${rec0?.viewOnly} signerAttached=${rec0?.signerAttached} (memory-only) balance=${balance === null ? '-' : balanceView(balance)} recovery=${JSON.stringify(rec)}`,
    );
  } catch (e) {
    record(ctx, 'S5-reload-sane', false, JSON.stringify(errorShape(e)));
  }
};

// ---- S5b: AC3 mid-sync reload (plan §0.4: reload mid-watchSync) ------------
//
// Separate DB (C) imports a fresh mnemonic with a CHECKPOINT birthday ~200k
// blocks below tip: a scan long enough to interrupt, yet short enough that
// in-flight progress is observable. (fullScan from birthday 1 commits no
// scan-state revision inside any sane drill window — live finding.) Arm:
// import, fire sync(), poll getSyncStatus() until activity=running with
// maxScannedHeight past the birthday (getBalance/getSyncStatus answer while
// the scan works), snapshot + persist, and the UI reloads the tab mid-flight
// (worker killed, no clean close). Resume: reopen and assert recovery-report
// sanity and that scan progress sits at/above the armed frontier BEFORE any
// sync() call — the scan resumed from committed progress, not from zero.

export const stepS5b_armMidSync = async (ctx: Ctx): Promise<void> => {
  try {
    if (ctx.openedC !== null) throw new Error('C already open; close all first');
    const opened = await openWallet(ctx.storageC, 'allow-owned');
    ctx.openedC = opened;
    const client = opened.client;
    // Re-run safety: C's DB may already carry spike-C from a prior arm.
    const accounts0 = await client.accounts.list();
    const existingC = accounts0.find((a) => a.id === ctx.midSync?.accountC) ?? accounts0.find((a) => a.name === 'spike-C');
    let accountC: AccountId;
    let birthday: number;
    if (existingC !== undefined) {
      const signer = await client.accounts.restoreSigner({ accountId: existingC.id, mnemonic: seedBytes(ctx.mnemonicC) });
      await client.accounts.attachSigner({ accountId: existingC.id, signer });
      accountC = existingC.id;
      birthday = existingC.birthdayHeight;
    } else {
      // resolveBirthday fetches the witness at firstScanHeight-1 and validates
      // it natively — live finding: a tree state AT firstScanHeight yields
      // native INVALID_BIRTHDAY, surfaced as opaque INVALID_ARGUMENT.
      const tip = await opened.light.getTip();
      const birthday0 = await resolveBirthday({ light: opened.light, firstScanHeight: Math.max(1, tip.height - 200_000 + 1) });
      note(ctx, `S5b arm: birthday resolved first=${birthday0.firstScanHeight} witness=${birthday0.priorTreeState.length}B`);
      const created = await client.accounts.import({
        mnemonic: seedBytes(ctx.mnemonicC),
        accountIndex: accountIndex(0),
        birthday: birthday0,
        name: 'spike-C',
      });
      note(ctx, `S5b arm: imported ${created.account.id} birthday=${created.account.birthdayHeight}`);
      await client.accounts.attachSigner({ accountId: created.account.id, signer: created.signer });
      accountC = created.account.id;
      birthday = created.account.birthdayHeight;
    }
    let syncError: string | null = null;
    void client.sync().catch((e: unknown) => {
      syncError = JSON.stringify(errorShape(e));
    });
    // Poll for a committed mid-scan point: maxScannedHeight strictly above
    // the birthday means blocks were scanned and committed while running.
    let armedStatus: SyncStatus | null = null;
    let frontier: number | null = null;
    for (let i = 0; i < 40; i += 1) {
      if (syncError !== null) throw new Error(`sync died while arming: ${syncError}`);
      const s = await client.getSyncStatus();
      if (s.activity === 'running' && !s.targetReached && s.scan.maxScannedHeight !== null && s.scan.maxScannedHeight > birthday) {
        armedStatus = s;
        frontier = s.scan.maxScannedHeight;
        break;
      }
      await delay(2_000);
    }
    if (armedStatus === null || frontier === null) throw new Error(`no committed mid-scan progress within 80s (birthday ${birthday}) syncError=${syncError ?? 'none'}`);
    const balance = await client.getBalance({ accountId: accountC });
    const snapshot = {
      at: new Date().toISOString(),
      accountC,
      firstScanHeight: birthday,
      maxScannedHeight: frontier,
      fullyScannedHeight: armedStatus.scan.fullyScannedHeight,
      tipHeight: armedStatus.scan.tipHeight ?? 0,
      balance: balanceView(balance),
    };
    ctx.midSync = snapshot;
    // Durability before the kill: record() persists ctx incl. midSync.
    record(
      ctx,
      'S5b-midsync-arm',
      true,
      `mid-scan snapshot: maxScanned=${snapshot.maxScannedHeight} fullyScanned=${snapshot.fullyScannedHeight} of tip=${snapshot.tipHeight} (birthday ${birthday}); balance ${snapshot.balance}; hit "reload mid-scan (kill)" NOW, then run resume`,
    );
  } catch (e) {
    record(ctx, 'S5b-midsync-arm', false, JSON.stringify(errorShape(e)));
  }
};

export const stepS5b_resumeMidSync = async (ctx: Ctx): Promise<void> => {
  try {
    const armed = ctx.midSync;
    if (armed === null) throw new Error('run S5b arm + mid-flight reload first (no midSync snapshot in session)');
    const opened = await openWallet(ctx.storageC, 'allow-owned');
    ctx.openedC = opened;
    const client = opened.client;
    // BEFORE any sync() call: reads must come from the durable DB.
    const rec = opened.recovery;
    const accounts = await client.accounts.list();
    const cPresent = accounts.some((a) => a.id === armed.accountC);
    const status = await client.getSyncStatus();
    const balance = cPresent ? balanceView(await client.getBalance({ accountId: armed.accountC })) : null;
    const recSane = rec.local === 'complete' && rec.lastError === null;
    // No rescan from zero: after the mid-scan kill, persisted scan progress
    // sits at or beyond the armed mid-scan frontier (monotonic). A wiped or
    // restarted scan would fall back to the birthday.
    const progress = status.scan.maxScannedHeight;
    const resumed = progress !== null && progress >= armed.maxScannedHeight && armed.maxScannedHeight > armed.firstScanHeight;
    record(
      ctx,
      'S5b-midsync-resume',
      cPresent && recSane && resumed && balance !== null,
      `reload mid-scan: C-present=${cPresent} maxScanned armed=${armed.maxScannedHeight} after-kill=${progress} fullyScanned=${status.scan.fullyScannedHeight} (birthday ${armed.firstScanHeight}) resumed=${resumed} balance armed=${armed.balance} now=${balance ?? '-'} (equality NOT asserted: background sync may commit an inbound block across the kill) recovery=${JSON.stringify(rec)}`,
    );
  } catch (e) {
    record(ctx, 'S5b-midsync-resume', false, JSON.stringify(errorShape(e)));
  }
};

export const closeAll = async (ctx: Ctx): Promise<void> => {
  await closeB(ctx);
  if (ctx.openedC !== null) {
    await ctx.openedC.client.close();
    ctx.openedC = null;
  }
  if (ctx.openedA !== null) {
    await ctx.openedA.client.close();
    ctx.openedA = null;
  }
};
