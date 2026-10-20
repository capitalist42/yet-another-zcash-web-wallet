// Ticket #2 engine spike — core harness for @zcashlabs/zcash.js qualification.
// Not product code: no registry, no vault; mnemonics live in tab storage only.
import { createLightClient, createWalletClient, formatZec, isZcashError } from '@zcashlabs/zcash.js';
import type {
  AccountId,
  LightClient,
  MemorySigner,
  Proposal,
  RecoveryReport,
  SyncStatus,
  TransactionPolicy,
  WalletBalance,
  WalletClient,
} from '@zcashlabs/zcash.js';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

export const TESTNET_ENDPOINT = 'https://zcash-testnet.chainsafe.dev';
export const MAINNET_ENDPOINT = 'https://zcash-mainnet.chainsafe.dev';
export const FAUCET_ORIGIN = 'https://zcashfaucet.jinolabs.xyz';

// Live-qualification run target. Testnet is NU7 since 2026-10-04 (height
// 4,465,026; branch 77190ad9) and rc.5's codec stops at Nu6_3 (37a5165b), so
// the only public chain rc.5 can currently open is mainnet. ?endpoint=…&network=…
// selects the run target without rebuilding the bundle.
const runParams = new URLSearchParams(window.location.search);
export const RUN_NETWORK: 'mainnet' | 'testnet' =
  runParams.get('network') === 'testnet' ? 'testnet' : 'mainnet';
export const RUN_ENDPOINT =
  runParams.get('endpoint') ?? (RUN_NETWORK === 'mainnet' ? MAINNET_ENDPOINT : TESTNET_ENDPOINT);

export type TransparentMode = 'disallow' | 'allow-owned';

export type StepName =
  | 'S1a-create-A'
  | 'S1b-current-null'
  | 'S1c-next-mints'
  | 'S1d-sync-tip'
  | 'FAUCET-t'
  | 'P1-shield-disallow'
  | 'P2-shield-allow-owned'
  | 'P3-direct-transparent-send'
  | 'P4-shield-execute'
  | 'S3-shield-send'
  | 'S3b-memo-send'
  | 'S3c-history-both'
  | 'S4-submit-unknown'
  | 'S4b-resume-mined'
  | 'S5-reload-sane';

export interface StepResult {
  ok: boolean;
  detail: string;
  at: string;
}

export const phrase = (): string => generateMnemonic(wordlist, 256);

// SDK contract (docs/api/accounts-signers.md): UTF-8 phrase bytes, NOT mnemonicToSeed output.
export const seedBytes = (mnemonic: string): Uint8Array => {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid mnemonic');
  return new TextEncoder().encode(mnemonic);
};

export interface ErrorShape {
  code?: string;
  stage?: string;
  recovery?: string;
  retryable?: boolean;
  message: string;
}

export const errorShape = (e: unknown): ErrorShape =>
  isZcashError(e)
    ? { code: e.code, stage: e.stage, recovery: e.recovery, retryable: e.retryable, message: e.message }
    : { message: e instanceof Error ? e.message : String(e) };

const CONFIRMATIONS = { trusted: 1, untrusted: 1, allowZeroConfirmationShielding: false };

// Frozen policy per plan §2; the one experiment axis (transparent) swaps per phase.
export const frozenPolicy = (transparent: TransparentMode): TransactionPolicy => ({
  spendPools: ['sapling', 'ironwood'],
  transparent,
  changePool: 'ironwood',
  feeRule: 'zip317-standard',
  confirmations: CONFIRMATIONS,
  expiry: { kind: 'offset', blocks: 5 },
  lockExpiryBlocks: 20,
  shieldingThreshold: 10_000n,
  freshness: { mode: 'catch-up', maxLagBlocks: 10, timeoutMs: 30_000 },
});

export interface OpenedWallet {
  client: WalletClient;
  light: LightClient;
  recovery: RecoveryReport;
}

export async function openWallet(
  storageName: string,
  transparent: TransparentMode,
  broadcasterEndpoint: string | null = null,
): Promise<OpenedWallet> {
  const light = await createLightClient(RUN_ENDPOINT, { network: RUN_NETWORK });
  const broadcaster =
    broadcasterEndpoint === null ? light : await createLightClient(broadcasterEndpoint, { network: RUN_NETWORK });
  const client = await createWalletClient({
    network: light.network,
    light,
    broadcaster,
    storage: { kind: 'browser-opfs', name: storageName },
    confirmations: CONFIRMATIONS,
    observation: { pollIntervalMs: 3_000, maxBufferedUpdates: 16 },
    recovery: { mode: 'online', timeoutMs: 15_000 },
    transactionPolicy: frozenPolicy(transparent),
  });
  return { client, light, recovery: client.recovery };
}

// Live mainnet produces blocks every ~75 s; enhancement's tip-vs-retained-point
// read races them (enhancement.js unspent()). Both throw codes documented as
// retry-via-sync (errors-lifecycle.md: CURSOR_STALE / RECOVERY_REQUIRED).
const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const isResyncGuided = (e: unknown): boolean =>
  isZcashError(e) && e.recovery === 'sync' && (e.code === 'RECOVERY_REQUIRED' || e.code === 'CURSOR_STALE');

// Observed live 2026-10-20: retries spaced across the ~75 s block cadence
// sometimes recover (run 1), sometimes don't (run 2: 8 spaced fails, then a
// fresh client reopen on the same OPFS DB synced clean). Reliable remedy is
// reopen, not spacing; retries kept here for the cheap win anyway.
export const syncTolerant = async (client: WalletClient, attempts = 8): Promise<SyncStatus> => {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await client.sync();
    } catch (e) {
      if (!isResyncGuided(e)) throw e;
      lastError = e;
      await delay(10_000);
    }
  }
  throw lastError;
};

export interface Ctx {
  storageA: string;
  storageB: string;
  mnemonicA: string;
  mnemonicB: string;
  accountA: AccountId | null;
  accountB: AccountId | null;
  unifiedA: string | null;
  transparentA: string | null;
  unifiedB: string | null;
  lastOperationId: string | null;
  openedA: OpenedWallet | null;
  openedB: OpenedWallet | null;
  signerA: MemorySigner | null;
  sync: SyncStatus | null;
  steps: Partial<Record<StepName, StepResult>>;
  log: string[];
}

const CTX_KEY = '***';

const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export const loadCtx = (): Ctx => {
  const stored = sessionStorage.getItem(CTX_KEY);
  if (stored !== null) return JSON.parse(stored) as Ctx;
  return {
    storageA: `yaw-spike-A-${RUN_NETWORK}`,
    storageB: `yaw-spike-B-${RUN_NETWORK}`,
    mnemonicA: phrase(),
    mnemonicB: phrase(),
    accountA: null,
    accountB: null,
    unifiedA: null,
    transparentA: null,
    unifiedB: null,
    lastOperationId: null,
    openedA: null,
    openedB: null,
    signerA: null,
    sync: null,
    steps: {},
    log: [],
  };
};

export const persistCtx = (ctx: Ctx): void => {
  const clone: Ctx = { ...ctx, openedA: null, openedB: null, signerA: null, sync: null };
  sessionStorage.setItem(CTX_KEY, JSON.stringify(clone, bigintReplacer));
};

export const note = (ctx: Ctx, message: string): void => {
  ctx.log.push(`${new Date().toISOString()} ${message}`);
  persistCtx(ctx);
};

export const record = (ctx: Ctx, step: StepName, ok: boolean, detail: string): StepResult => {
  const result: StepResult = { ok, detail, at: new Date().toISOString() };
  ctx.steps[step] = result;
  note(ctx, `${step} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  return result;
};
export const summarizeProposal = (p: Proposal): string =>
  p.steps
    .map((step) =>
      `v${step.transactionVersion} exp:${step.expiryHeight} fee:${step.fee} in:${step.inputs.length} ` +
      `out:[${step.outputs.map((o) => `${o.kind}:${o.pool}:${zats(o.amount)}`).join(', ')}]`)
    .concat(`totalFee:${p.totalFee}`)
    .join(' | ');

export const clientA = (ctx: Ctx): WalletClient => {
  if (ctx.openedA === null) throw new Error('wallet A not open');
  return ctx.openedA.client;
};

export const requireAccountA = (ctx: Ctx): AccountId => {
  if (ctx.accountA === null) throw new Error('account A missing');
  return ctx.accountA;
};

export const zats = (value: bigint): string => formatZec(value);

export const balanceView = (b: WalletBalance): string =>
  b.amounts === null
    ? 'amounts:null'
    : `t:${zats(b.amounts.transparent.regular.spendable)} s:${zats(b.amounts.sapling.spendable)} i:${zats(b.amounts.ironwood.spendable)}`;

export const dump = (ctx: Ctx): string =>
  JSON.stringify(
    {
      storageA: ctx.storageA,
      storageB: ctx.storageB,
      mnemonicA: ctx.mnemonicA,
      mnemonicB: ctx.mnemonicB,
      steps: ctx.steps,
      log: ctx.log,
    },
    bigintReplacer,
    2,
  );
