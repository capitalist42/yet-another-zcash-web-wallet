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
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

export const TESTNET_ENDPOINT = 'https://zcash-testnet.chainsafe.dev';
export const FAUCET_ORIGIN = 'https://zcashfaucet.jinolabs.xyz';

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

export const seedBytes = async (mnemonic: string): Promise<Uint8Array> => {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('invalid mnemonic');
  return new Uint8Array(await mnemonicToSeed(mnemonic));
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
  const light = await createLightClient(TESTNET_ENDPOINT, { network: 'testnet' });
  const broadcaster =
    broadcasterEndpoint === null ? light : await createLightClient(broadcasterEndpoint, { network: 'testnet' });
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
    storageA: 'yaw-spike-A',
    storageB: 'yaw-spike-B',
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
